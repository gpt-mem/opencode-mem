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
      expect(result.durationMs).toBeLessThan(15_000)
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
