import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Database } from "@opencode/core/database/database"
import { CacheMarkLedgerService, node as CacheMarkLedgerNode } from "@opencode/core/session/cache-mark-ledger"
import { SessionMemoryContext } from "@opencode/core/session/memory-context"
import * as CacheMark from "@opencode/core/session/cache-mark"
import { SessionMessage } from "@opencode/core/session/message"
import { Model } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import { Agent } from "@opencode/core/agent"
import { DateTime } from "effect"
import { Bus } from "@opencode/core/bus"
import { testEffect } from "./lib/effect"

// Test fixtures using proper SessionMessage types (match memory-context.test.ts)
const created = DateTime.makeUnsafe(0)
const messageID = (value: string) => SessionMessage.ID.make(`msg_${value}`)
const model = Model.Ref.make({ id: Model.ID.make("model"), providerID: Provider.ID.make("provider") })

const tool = (input: {
  readonly id: string
  readonly name?: string
  readonly text: string
  readonly status?: "completed" | "error"
  readonly executed?: boolean
  readonly toolInput?: Record<string, unknown>
}) =>
  SessionMessage.AssistantTool.make({
    type: "tool",
    id: input.id,
    name: input.name ?? "shell",
    ...(input.executed === undefined ? {} : { executed: input.executed }),
    state:
      input.status === "error"
        ? SessionMessage.ToolStateError.make({
            status: "error",
            input: input.toolInput ?? {},
            error: { type: "unknown", message: "failed" },
          })
        : SessionMessage.ToolStateCompleted.make({
            status: "completed",
            input: input.toolInput ?? {},
            content: [{ type: "text" as const, text: input.text }],
          }),
    time: { created },
  })

const assistant = (value: string, content: SessionMessage.Assistant["content"]) =>
  SessionMessage.Assistant.make({
    id: messageID(value),
    type: "assistant",
    agent: Agent.defaultID,
    model,
    content,
    time: { created, completed: created },
  })

const large = "x".repeat(3000)

const history = () => [assistant("first", [tool({ id: "call_1", text: large, toolInput: { command: "cat call_1.txt" } })]), assistant("second", [tool({ id: "call_2", text: large, toolInput: { command: "cat call_2.txt" } })])]

const markerOf = (message: SessionMessage.Info) => {
  if (message.type !== "assistant") return undefined
  const item = message.content[0]
  if (item?.type !== "tool" || item.state.status !== "completed") return undefined
  return item.state.content[0]?.type === "text" ? item.state.content[0].text : undefined
}

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, CacheMarkLedgerNode]),
  ),
)

// Test the CacheMarkLedger service with proper database context
describe("CacheMarkLedger - Service Integration", () => {
  it.effect("getMark returns 0 for new provider", () => Effect.gen(function* () {
    const ledger = yield* CacheMarkLedgerService
    const providerID = "test-provider-1"

    const mark = yield* ledger.getMark(providerID)

    expect(mark).toBe(0)
  }))

  it.effect("applyUsage updates mark_tokens and mark_index", () => Effect.gen(function* () {
    const ledger = yield* CacheMarkLedgerService
    const providerID = "test-provider-2"
    const usage = {
      input: 100,
      output: 10,
      cache_read: 1000,
      cache_write: 500,
      sentCount: 7,
    }

    // Provide enough messages that mark_index=7 is not treated as a shrunk history
    const messages = Array.from({ length: 8 }, (_, i) =>
      i % 2 === 0
        ? { type: "user" as const, text: `msg-${i}` }
        : { type: "assistant" as const, content: [] },
    )
    yield* ledger.applyUsage(providerID, usage, messages)

    const mark = yield* ledger.getMark(providerID)
    // mark_tokens = cacheRead + cacheWrite = 1500
    expect(mark).toBe(1500)

    // Projection mark is the index floor
    const projMark = yield* ledger.getProjectionMark(providerID, messages)
    expect(projMark).toBe(7)
  }))

  it.effect("mark only increases when cache_read grows (forward-only)", () => Effect.gen(function* () {
    const ledger = yield* CacheMarkLedgerService
    const providerID = "test-provider-3"
    const messages = [{ type: "user" as const, text: "hello" }, { type: "assistant" as const, content: [] }]

    const usage1 = { input: 100, output: 10, cache_read: 500, cache_write: 200, sentCount: 5 }
    const usage2 = { input: 100, output: 10, cache_read: 300, cache_write: 100, sentCount: 6 }

    yield* ledger.applyUsage(providerID, usage1, messages)
    yield* ledger.applyUsage(providerID, usage2, messages)

    const mark = yield* ledger.getMark(providerID)
    // first: 500+200=700; second: cache_read (300) < prev (700) -> shrink to 300, index = 5 * (300/700) = 2
    expect(mark).toBe(300)

    const projMark = yield* ledger.getProjectionMark(providerID, messages)
    expect(projMark).toBe(2)
  }))

  it.effect("new provider starts with mark=0", () => Effect.gen(function* () {
    const ledger = yield* CacheMarkLedgerService
    const providerID = "test-provider-4"

    const mark = yield* ledger.getMark(providerID)

    expect(mark).toBe(0)
  }))

  it.effect("getProjectionMark returns index floor", () => Effect.gen(function* () {
    const ledger = yield* CacheMarkLedgerService
    const providerID = "test-provider-5"

    const mark = yield* ledger.getProjectionMark(providerID, [{ type: "user", text: "x" }])

    expect(mark).toBe(0)
  }))

  it.effect("isMarkStale returns true for non-existent provider", () => Effect.gen(function* () {
    const ledger = yield* CacheMarkLedgerService
    const providerID = "test-provider-6"
    const maxIdleMs = 3600000

    const isStale = yield* ledger.isMarkStale(providerID, maxIdleMs)

    expect(isStale).toBe(true)
  }))

  it.effect("isMarkStale returns false for recently used provider", () => Effect.gen(function* () {
    const ledger = yield* CacheMarkLedgerService
    const providerID = "test-provider-7"
    const maxIdleMs = 3600000

    const usage = { input: 100, output: 10, cache_read: 1000, cache_write: 500, sentCount: 5 }
    const messages = [{ type: "user" as const, text: "hello" }, { type: "assistant" as const, content: [] }]

    yield* ledger.applyUsage(providerID, usage, messages)

    const isStale = yield* ledger.isMarkStale(providerID, maxIdleMs)

    expect(isStale).toBe(false)
  }))

  it.effect("reset collapses mark to 0", () => Effect.gen(function* () {
    const ledger = yield* CacheMarkLedgerService
    const providerID = "test-provider-8"
    const messages = [{ type: "user" as const, text: "hello" }, { type: "assistant" as const, content: [] }]

    yield* ledger.applyUsage(providerID, { input: 100, output: 10, cache_read: 1000, cache_write: 500, sentCount: 5 }, messages)
    expect(yield* ledger.getMark(providerID)).toBe(1500)

    yield* ledger.reset(providerID)
    expect(yield* ledger.getMark(providerID)).toBe(0)
    expect(yield* ledger.getProjectionMark(providerID, messages)).toBe(0)
  }))

  it.effect("markIndexFor fail-safe: history shrunk below mark returns verbatim", () => Effect.gen(function* () {
    const ledger = yield* CacheMarkLedgerService
    const providerID = "test-provider-9"
    const messagesLong = [{ type: "user", text: "1" }, { type: "assistant", content: [] }, { type: "user", text: "2" }, { type: "assistant", content: [] }, { type: "user", text: "3" }, { type: "assistant", content: [] }]

    // Establish mark at index 5 (5 messages)
    yield* ledger.applyUsage(providerID, { input: 100, output: 10, cache_read: 5000, cache_write: 0, sentCount: 5 }, messagesLong)
    expect(yield* ledger.getProjectionMark(providerID, messagesLong)).toBe(5)

    // Now history shrinks (simulating compaction or truncation)
    const messagesShort = [{ type: "user", text: "a" }, { type: "assistant", content: [] }]
    // Should return verbatim (messagesShort.length = 2) because mark_index > messages.length
    const projMark = yield* ledger.getProjectionMark(providerID, messagesShort)
    expect(projMark).toBe(messagesShort.length)
  }))

  it.effect("markIndexFor fail-safe: hash mismatch returns verbatim", () => Effect.gen(function* () {
    const ledger = yield* CacheMarkLedgerService
    const providerID = "test-provider-10"
    const messages = [{ type: "user", text: "original" }, { type: "assistant", content: [] }]

    // Establish mark
    yield* ledger.applyUsage(providerID, { input: 100, output: 10, cache_read: 1000, cache_write: 0, sentCount: 1 }, messages)

    // Mutate the message (simulating external mutation)
    const mutated = [{ type: "user", text: "mutated" }, { type: "assistant", content: [] }]
    const projMark = yield* ledger.getProjectionMark(providerID, mutated)
    // Hash mismatch → verbatim (messages.length = 2)
    expect(projMark).toBe(mutated.length)
  }))

  // Step 5 (issue #202): integration of ledger + projection. The ledger only
  // supplies a mark; the projection must honour it byte-for-byte below the mark
  // and compact only the suffix. mark=0 (fresh/free provider) must equal the
  // no-ledger projection — that is the track-A case and B0 first delivery.
  it.effect("mark=0 parity: projection with ledger mark=0 equals projection without ledger", () => Effect.gen(function* () {
    const ledger = yield* CacheMarkLedgerService
    const providerID = "test-provider-parity"
    const messages = history()

    // No ledger row yet → the provider has confirmed nothing → mark=0.
    const mark = yield* ledger.getProjectionMark(providerID, messages)
    expect(mark).toBe(0)

    const withLedger = SessionMemoryContext.project(messages, { enabled: true, minOutputChars: 100, providerMark: mark })
    const withoutLedger = SessionMemoryContext.project(messages, { enabled: true, minOutputChars: 100 })
    // mark=0 is byte-for-byte the no-ledger projection (track A).
    expect(withLedger).toEqual(withoutLedger)
    // And it actually compacts (otherwise the parity would be vacuous).
    expect(markerOf(withLedger[0])).toContain("[mem:compacted tool result]")
  }))

  it.effect("B0 via ledger: fresh provider (mark=0) compacts the whole first delivery", () => Effect.gen(function* () {
    const ledger = yield* CacheMarkLedgerService
    const providerID = "test-provider-b0"
    const messages = history()

    const mark = yield* ledger.getProjectionMark(providerID, messages)
    const projected = SessionMemoryContext.project(messages, { enabled: true, minOutputChars: 100, providerMark: mark })

    // First delivery: nothing was sent verbatim, so no leading run is preserved.
    expect(CacheMark.verbatimPrefixLength(projected, messages)).toBe(0)
    // Both bulk results became markers — no separate first-delivery flag involved.
    expect(markerOf(projected[0])).toContain("[mem:compacted tool result]")
    expect(markerOf(projected[1])).toContain("[mem:compacted tool result]")
  }))

  it.effect("warm ledger: prefix below mark stays verbatim, suffix compacts", () => Effect.gen(function* () {
    const ledger = yield* CacheMarkLedgerService
    const providerID = "test-provider-warm"
    const messages = history()

    // The provider confirmed the first message is cached verbatim.
    yield* ledger.applyUsage(providerID, { input: 100, output: 10, cache_read: 5000, cache_write: 0, sentCount: 1 }, messages)
    const mark = yield* ledger.getProjectionMark(providerID, messages)
    expect(mark).toBe(1)

    const projected = SessionMemoryContext.project(messages, { enabled: true, minOutputChars: 100, providerMark: mark })

    // Below the mark: same object reference, byte-identical (invariant #1).
    expect(projected[0]).toBe(messages[0])
    // Above the mark: compacted.
    expect(markerOf(projected[1])).toContain("[mem:compacted tool result]")
    // The provider's cached prefix hash is unchanged, so the cache stays valid.
    expect(CacheMark.messagePrefixHash(projected.slice(0, mark))).toBe(CacheMark.messagePrefixHash(messages.slice(0, mark)))
  }))
})