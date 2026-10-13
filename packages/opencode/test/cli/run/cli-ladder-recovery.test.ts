import { expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../../lib/cli-process"
import { testProviderConfig } from "../../lib/test-provider"

cliIt.concurrent(
  "delivers a recovered ladder response and exits successfully",
  ({ llm, opencode }) =>
    Effect.gen(function* () {
      yield* llm.error(400, { error: { message: "every rung failed" } })
      yield* llm.text("audit-recovered")
      const result = yield* opencode.run("synthetic recovery check", {
        timeoutMs: 30_000,
        env: {
          OPENCODE_CONFIG_CONTENT: JSON.stringify({
            ...testProviderConfig(llm.url),
            experimental: { ladder_retry_delay: 0 },
          }),
        },
      })
      expect(result.exitCode, result.stderr).toBe(0)
      expect(result.stdout).toContain("audit-recovered")
      expect(result.stdout).not.toContain("The model provider ladder is exhausted")
      expect(result.stderr).toContain("Retrying provider ladder (attempt 1, in 0s)")
      expect(result.stderr).not.toContain("every rung failed")
    }),
  45_000,
)

cliIt.live(
  "delivers a recovered ladder response through run --attach",
  ({ llm, opencode }) =>
    Effect.gen(function* () {
      yield* llm.error(400, { error: { message: "every rung failed" } })
      yield* llm.text("attach-recovered")
      const server = yield* opencode.serve({
        env: {
          OPENCODE_CONFIG_CONTENT: JSON.stringify({
            ...testProviderConfig(llm.url),
            experimental: { ladder_retry_delay: 0 },
          }),
        },
      })
      const result = yield* opencode.run("synthetic attach recovery check", {
        timeoutMs: 30_000,
        extraArgs: ["--attach", server.url],
      })
      expect(result.exitCode, result.stderr).toBe(0)
      expect(result.stdout).toContain("attach-recovered")
      expect(result.stdout).not.toContain("The model provider ladder is exhausted")
      expect(result.stderr).toContain("Retrying provider ladder (attempt 1, in 0s)")
      expect(result.stderr).not.toContain("every rung failed")
    }),
  45_000,
)

cliIt.concurrent(
  "reports retry state as JSON before the recovered answer",
  ({ llm, opencode }) =>
    Effect.gen(function* () {
      yield* llm.error(400, { error: { message: "every rung failed" } })
      yield* llm.text("json-recovered")
      const result = yield* opencode.run("synthetic JSON recovery check", {
        format: "json",
        timeoutMs: 30_000,
        env: {
          OPENCODE_CONFIG_CONTENT: JSON.stringify({
            ...testProviderConfig(llm.url),
            experimental: { ladder_retry_delay: 0 },
          }),
        },
      })
      const events = opencode.parseJsonEvents(result.stdout)
      expect(result.exitCode).toBe(0)
      expect(events.filter((event) => event.type === "retry")).toEqual([
        expect.objectContaining({
          status: expect.objectContaining({ type: "retry", attempt: 1, next: expect.any(Number) }),
        }),
      ])
      expect(events.some((event) => event.type === "text" && JSON.stringify(event).includes("json-recovered"))).toBe(
        true,
      )
    }),
  45_000,
)

cliIt.live(
  "reports the age of a silent provider without claiming completion",
  ({ llm, opencode }) =>
    Effect.gen(function* () {
      const gate = Promise.withResolvers<void>()
      yield* llm.hold("slow-finished", gate.promise)
      const run = yield* opencode.startRun("check wait status")
      yield* llm.wait(1)
      yield* Effect.sleep("30 seconds")
      gate.resolve()
      const result = yield* run.result
      expect(result.exitCode, result.stderr).toBe(0)
      expect(result.stderr).toContain("Waiting for provider; last session update")
      expect(result.stdout).toContain("slow-finished")
    }),
  60_000,
)

cliIt.live(
  "run --attach exits when its server dies during an active response",
  ({ llm, opencode }) =>
    Effect.gen(function* () {
      yield* llm.hang
      const server = yield* opencode.serve()
      const run = yield* opencode.startRun("wait for the provider", {
        extraArgs: ["--attach", server.url],
      })
      yield* llm.wait(1)
      server.kill()
      const result = yield* run.result
      expect(result.exitCode).not.toBe(0)
      expect(result.durationMs).toBeLessThan(25_000)
      expect(result.stderr).toContain("Reconnect and check the session before retrying")
    }),
  30_000,
)

cliIt.live(
  "run --attach reports a closed event stream before terminal idle",
  ({ llm, opencode }) =>
    Effect.gen(function* () {
      yield* llm.text("provider-finished")
      const server = yield* opencode.serve()
      const proxy = Bun.serve({
        port: 0,
        fetch(request) {
          const url = new URL(request.url)
          if (url.pathname.endsWith("/event"))
            return new Response("", { headers: { "content-type": "text/event-stream" } })
          return fetch(new Request(new URL(url.pathname + url.search, server.url), request))
        },
      })
      yield* Effect.addFinalizer(() => Effect.sync(() => proxy.stop(true)))
      const result = yield* opencode.run("check closed events", {
        extraArgs: ["--attach", proxy.url.toString()],
      })
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain("event stream ended before this session reported completion")
    }),
  30_000,
)

cliIt.concurrent(
  "exits nonzero when every ladder continuation fails",
  ({ llm, opencode }) =>
    Effect.gen(function* () {
      for (let i = 0; i < 6; i++) yield* llm.error(400, { error: { message: "every rung failed" } })
      const result = yield* opencode.run("synthetic terminal failure check", {
        timeoutMs: 30_000,
        env: {
          OPENCODE_CONFIG_CONTENT: JSON.stringify({
            ...testProviderConfig(llm.url),
            experimental: { ladder_retry_delay: 0 },
          }),
        },
      })
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain("every rung failed")
    }),
  45_000,
)
