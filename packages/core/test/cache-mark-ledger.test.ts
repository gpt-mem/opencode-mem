import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Database } from "@opencode/core/database/database"
import { CacheMarkLedgerService, node as CacheMarkLedgerNode } from "@opencode/core/session/cache-mark-ledger"
import { Bus } from "@opencode/core/bus"
import { testEffect } from "./lib/effect"

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
})