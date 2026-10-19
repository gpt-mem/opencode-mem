import { describe, expect } from "bun:test"
import { Message } from "@opencode/ai"
import { Effect } from "effect"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { CacheMark } from "@opencode/core/session/cache-mark"
import { CacheMask } from "@opencode/core/session/cache-mask"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node])))

const SCOPE = "v1_" + "a".repeat(32)

describe("CacheMark", () => {
  it.effect("collapses the mark when the provider cached nothing", () =>
    Effect.sync(() => {
      const mark = CacheMark.applyUsage(
        { tokens: 100, index: 5 },
        { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, sentCount: 7 },
      )
      expect(mark).toEqual({ tokens: 0, index: 0 })
    }),
  )

  it.effect("confirms the sent prefix on the first cached response", () =>
    Effect.sync(() => {
      const mark = CacheMark.applyUsage(undefined, {
        input: 10,
        output: 2,
        cacheRead: 0,
        cacheWrite: 40,
        sentCount: 7,
      })
      expect(mark).toEqual({ tokens: 40, index: 7 })
    }),
  )

  it.effect("keeps the mark when the provider read at least as much as before", () =>
    Effect.sync(() => {
      const mark = CacheMark.applyUsage(
        { tokens: 40, index: 7 },
        { input: 1, output: 1, cacheRead: 55, cacheWrite: 0, sentCount: 9 },
      )
      expect(mark).toEqual({ tokens: 55, index: 9 })
    }),
  )

  it.effect("shrinks the mark when the provider evicted part of the prefix", () =>
    Effect.sync(() => {
      const mark = CacheMark.applyUsage(
        { tokens: 100, index: 10 },
        { input: 1, output: 1, cacheRead: 50, cacheWrite: 0, sentCount: 12 },
      )
      expect(mark).toEqual({ tokens: 50, index: 5 })
    }),
  )

  it.effect("counts the leading run of untouched messages", () =>
    Effect.sync(() => {
      const a = { id: "a" }
      const b = { id: "b" }
      const c = { id: "c" }
      expect(CacheMark.verbatimPrefixLength([a, b, { id: "x" }], [a, b, c])).toBe(2)
    }),
  )
})

describe("CacheMask", () => {
  it.effect("keeps the confirmed prefix byte-identical and compacts the settled tool results", () =>
    Effect.sync(() => {
      const messages = [
        Message.user("first"),
        Message.tool({ id: "c1", name: "bash", result: "x".repeat(100) }),
        Message.user("second"),
        Message.tool({ id: "c2", name: "read", result: "y".repeat(100) }),
        Message.user("third"),
        Message.tool({ id: "c3", name: "grep", result: "z".repeat(100) }),
      ]
      const projection = CacheMask.project(messages, { markIndex: 2, keepRecent: 1 })
      // The confirmed prefix and the recent window stay the very same objects.
      expect(projection.messages[0]).toBe(messages[0])
      expect(projection.messages[1]).toBe(messages[1])
      expect(projection.messages[5]).toBe(messages[5])
      // The settled tool result above the boundary collapses to a marker.
      const compacted = projection.messages[3]
      expect(compacted).not.toBe(messages[3])
      const part = compacted.content[0]
      expect(part?.type).toBe("tool-result")
      expect(part?.type === "tool-result" ? part.result : undefined).toEqual({
        type: "text",
        value: expect.stringContaining("compacted"),
      })
      // The leading run of untouched messages is the prefix the provider cached.
      expect(projection.verbatim).toBe(3)
    }),
  )

  it.effect("keeps the pointer to the saved output in the marker", () =>
    Effect.sync(() => {
      const message = Message.tool({
        id: "c1",
        name: "bash",
        result:
          "head of the output\n[showing lines 1-3 of 90; full output saved to /tmp/tool-output/tool_abc — read or grep that file instead of re-running the command]",
        resultType: "text",
      })
      const projection = CacheMask.project([message], { markIndex: 0, keepRecent: 0 })
      const part = projection.messages[0]?.content[0]
      expect(part?.type === "tool-result" ? part.result : undefined).toEqual({
        type: "text",
        value: expect.stringContaining("/tmp/tool-output/tool_abc"),
      })
    }),
  )

  it.effect("reads the rung, the scope and the served branch from the response headers", () =>
    Effect.sync(() => {
      expect(
        CacheMask.parseHeaders({
          "x-ladder-model": "opencode-go/gpt-5",
          "x-ladder-cache-scope": SCOPE,
          "x-ladder-cache-variant": "masked",
        }),
      ).toEqual({ rung: "opencode-go/gpt-5", scope: SCOPE, variant: "masked" })
      expect(CacheMask.parseHeaders({})).toEqual({ variant: "default" })
      // A scope the provider did not mint is ignored.
      expect(CacheMask.parseHeaders({ "x-ladder-cache-scope": "nope" })).toEqual({ variant: "default" })
    }),
  )

  it.effect("keys the ledger by the rung and the scope the provider confirmed", () =>
    Effect.sync(() => {
      expect(CacheMask.scopedKey("ladder/gpt-5", { rung: "rung", scope: SCOPE, variant: "masked" })).toBe(
        `ladder/gpt-5::rung::${SCOPE}`,
      )
      expect(CacheMask.scopedKey("ladder/gpt-5", { variant: "default" })).toBeUndefined()
    }),
  )

  it.effect("masks the Ladder provider only", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const messages = [Message.user("a")]
      expect(yield* CacheMask.apply({ db, providerID: "anthropic", modelID: "claude", messages })).toBeUndefined()
      const state = yield* CacheMask.apply({ db, providerID: "ladder", modelID: "gpt-5", messages })
      expect(state?.key).toBe("ladder/gpt-5")
      expect(state?.masked).toBeUndefined()
      expect(state?.fallback.messages).toEqual(messages)
    }),
  )
})

describe("CacheMark ledger", () => {
  it.effect("confirms the sent prefix, refuses a mutated one and drops it on a reset", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const messages = [Message.user("a"), Message.user("b"), Message.user("c")]
      yield* CacheMark.recordUsage(
        db,
        "ladder/gpt-5",
        { input: 10, output: 2, cacheRead: 0, cacheWrite: 100, sentCount: 2 },
        messages,
      )
      expect(yield* CacheMark.markIndexFor(db, "ladder/gpt-5", messages)).toBe(2)
      // A mutated prefix no longer matches the bytes the provider cached.
      const mutated = [Message.user("changed"), messages[1], messages[2]]
      expect(yield* CacheMark.markIndexFor(db, "ladder/gpt-5", mutated)).toBeUndefined()
      // A history that shrank below the mark cannot be floored either.
      expect(yield* CacheMark.markIndexFor(db, "ladder/gpt-5", messages.slice(0, 1))).toBeUndefined()
      yield* CacheMark.reset(db, "ladder/gpt-5")
      expect(yield* CacheMark.markIndexFor(db, "ladder/gpt-5", messages)).toBe(0)
    }),
  )

  it.effect("scopes the confirmation to the rung that cached it", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const messages = [Message.user("a"), Message.user("b"), Message.user("c")]
      yield* CacheMark.recordUsage(
        db,
        `ladder/gpt-5::opencode-go/gpt-5::${SCOPE}`,
        { input: 10, output: 2, cacheRead: 0, cacheWrite: 100, sentCount: 2 },
        messages,
      )
      const scoped = yield* CacheMark.latestScoped(db, "ladder/gpt-5", messages)
      expect(scoped).toEqual({ rung: "opencode-go/gpt-5", scope: SCOPE, index: 2 })
      // Another model of the same provider keeps its own row.
      expect(yield* CacheMark.latestScoped(db, "ladder/other", messages)).toBeUndefined()
    }),
  )

  it.effect("drops every confirmation of a provider when the rung is unknown", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const messages = [Message.user("a"), Message.user("b")]
      yield* CacheMark.recordUsage(
        db,
        `ladder/gpt-5::opencode-go/gpt-5::${SCOPE}`,
        { input: 1, output: 1, cacheRead: 0, cacheWrite: 50, sentCount: 2 },
        messages,
      )
      expect(yield* CacheMark.latestScoped(db, "ladder/gpt-5", messages)).toBeDefined()
      yield* CacheMark.resetMatching(db, "ladder/gpt-5")
      expect(yield* CacheMark.latestScoped(db, "ladder/gpt-5", messages)).toBeUndefined()
    }),
  )
})
