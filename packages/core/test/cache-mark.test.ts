import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { Effect } from "effect"
import { eq } from "drizzle-orm"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import providerCacheMarkMigration from "@opencode-ai/core/database/migration/20261011014246_damp_diamondback"
import { CacheMark } from "@opencode-ai/core/session/cache-mark"
import { ProviderCacheMarkTable } from "@opencode-ai/core/session/sql"
import { MemoryContext } from "@opencode-ai/core/session/memory-context"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { DateTime } from "effect"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"

const run = <A, E>(effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )

const makeDb = EffectDrizzleSqlite.makeWithDefaults()

const migratedDb = Effect.gen(function* () {
  const db = yield* makeDb
  yield* DatabaseMigration.applyOnly(db, [providerCacheMarkMigration])
  return db
})

const usage = (input: Partial<CacheMark.Usage> & { sentCount: number }): CacheMark.Usage => ({
  input: 100,
  output: 10,
  cacheRead: 0,
  cacheWrite: 0,
  ...input,
})

describe("CacheMark.applyUsage", () => {
  test("no cache activity collapses the mark to zero (free provider)", () => {
    expect(CacheMark.applyUsage({ tokens: 5000, index: 9 }, usage({ sentCount: 12, cacheRead: 0, cacheWrite: 0 })))
      .toEqual({ tokens: 0, index: 0 })
  })

  test("first observation with cache activity marks the whole sent request", () => {
    expect(CacheMark.applyUsage(undefined, usage({ sentCount: 7, cacheRead: 4000, cacheWrite: 0 })))
      .toEqual({ tokens: 4000, index: 7 })
  })

  test("growing cache_read advances the mark to the latest sent request", () => {
    expect(CacheMark.applyUsage({ tokens: 4000, index: 7 }, usage({ sentCount: 11, cacheRead: 9000, cacheWrite: 2000 })))
      .toEqual({ tokens: 11000, index: 11 })
  })

  test("cache_read equal to the confirmed mark keeps growing through cache_write", () => {
    expect(CacheMark.applyUsage({ tokens: 4000, index: 7 }, usage({ sentCount: 9, cacheRead: 4000, cacheWrite: 1500 })))
      .toEqual({ tokens: 5500, index: 9 })
  })

  test("eviction (cache_read below the mark) shrinks mark proportionally", () => {
    expect(CacheMark.applyUsage({ tokens: 10000, index: 10 }, usage({ sentCount: 15, cacheRead: 4000, cacheWrite: 1000 })))
      .toEqual({ tokens: 4000, index: 4 })
  })
})

describe("CacheMark.prefixHash", () => {
  test("is deterministic", () => {
    expect(CacheMark.prefixHash('{"a":1}')).toBe(CacheMark.prefixHash('{"a":1}'))
  })

  test("differs for different inputs", () => {
    expect(CacheMark.prefixHash('{"a":1}')).not.toBe(CacheMark.prefixHash('{"a":2}'))
  })
})

describe("CacheMark.verbatimPrefixLength", () => {
  test("counts the leading run of identical references", () => {
    const a = { id: 1 }
    const b = { id: 2 }
    const c = { id: 3 }
    expect(CacheMark.verbatimPrefixLength([a, b, c], [a, b, c])).toBe(3)
    expect(CacheMark.verbatimPrefixLength([a, { id: 2 }, c], [a, b, c])).toBe(1)
    expect(CacheMark.verbatimPrefixLength([{ id: 0 }, b], [a, b])).toBe(0)
  })

  test("is bounded by the shorter of the two lists", () => {
    const a = { id: 1 }
    expect(CacheMark.verbatimPrefixLength([a], [a, a, a])).toBe(1)
  })
})

describe("CacheMark ledger", () => {
  const provider = "prov/model-a"

  const row = (db: Effect.Success<typeof migratedDb>, id = provider) =>
    db.select().from(ProviderCacheMarkTable).where(eq(ProviderCacheMarkTable.provider_id, id)).get().pipe(Effect.orDie)

  test("markIndexFor returns 0 without a ledger row (provider confirmed nothing)", () =>
    run(
      Effect.gen(function* () {
        const db = yield* migratedDb
        const mark = yield* CacheMark.markIndexFor(db, provider, ["m0", "m1"])
        expect(mark).toBe(0)
      }),
    ))

  test("recordUsage creates a row and markIndexFor returns the index on a matching prefix", () =>
    run(
      Effect.gen(function* () {
        const db = yield* migratedDb
        const messages = ["m0", "m1", "m2"]
        yield* CacheMark.recordUsage(db, provider, usage({ sentCount: 3, cacheRead: 3000 }), messages)
        expect(yield* row(db)).toMatchObject({ provider_id: provider, mark_tokens: 3000, mark_index: 3 })
        expect(yield* CacheMark.markIndexFor(db, provider, messages)).toBe(3)
      }),
    ))

  test("hash mismatch below the mark fails safe to undefined", () =>
    run(
      Effect.gen(function* () {
        const db = yield* migratedDb
        yield* CacheMark.recordUsage(db, provider, usage({ sentCount: 2, cacheRead: 2000 }), ["m0", "m1"])
        const mark = yield* CacheMark.markIndexFor(db, provider, ["MUTATED", "m1", "m2"])
        expect(mark).toBeUndefined()
      }),
    ))

  test("history that shrank below the stored mark fails safe to undefined", () =>
    run(
      Effect.gen(function* () {
        const db = yield* migratedDb
        yield* CacheMark.recordUsage(db, provider, usage({ sentCount: 3, cacheRead: 3000 }), ["m0", "m1", "m2"])
        const mark = yield* CacheMark.markIndexFor(db, provider, ["m0"])
        expect(mark).toBeUndefined()
      }),
    ))

  test("mark 0 (free provider) returns 0 without a hash check", () =>
    run(
      Effect.gen(function* () {
        const db = yield* migratedDb
        yield* CacheMark.recordUsage(db, provider, usage({ sentCount: 4, cacheRead: 0, cacheWrite: 0 }), [
          "m0",
          "m1",
          "m2",
          "m3",
        ])
        expect(yield* row(db)).toMatchObject({ mark_tokens: 0, mark_index: 0, prefix_hash: null })
        expect(yield* CacheMark.markIndexFor(db, provider, ["anything"])).toBe(0)
      }),
    ))

  test("usage-free responses (aborted/error turns) never clobber a confirmed mark", () =>
    run(
      Effect.gen(function* () {
        const db = yield* migratedDb
        yield* CacheMark.recordUsage(db, provider, usage({ sentCount: 3, cacheRead: 3000 }), ["m0", "m1", "m2"])
        yield* CacheMark.recordUsage(
          db,
          provider,
          { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, sentCount: 3 },
          ["m0", "m1", "m2"],
        )
        expect(yield* row(db)).toMatchObject({ mark_tokens: 3000, mark_index: 3 })
      }),
    ))

  test("eviction recorded from usage lowers the stored mark", () =>
    run(
      Effect.gen(function* () {
        const db = yield* migratedDb
        yield* CacheMark.recordUsage(db, provider, usage({ sentCount: 10, cacheRead: 10000 }), [
          "a",
          "b",
          "c",
          "d",
          "e",
          "f",
          "g",
          "h",
          "i",
          "j",
        ])
        yield* CacheMark.recordUsage(db, provider, usage({ sentCount: 12, cacheRead: 5000, cacheWrite: 0 }), [
          "a",
          "b",
          "c",
          "d",
          "e",
          "f",
          "g",
          "h",
          "i",
          "j",
          "k",
          "l",
        ])
        expect(yield* row(db)).toMatchObject({ mark_tokens: 5000, mark_index: 5 })
      }),
    ))

  test("providers do not share marks", () =>
    run(
      Effect.gen(function* () {
        const db = yield* migratedDb
        yield* CacheMark.recordUsage(db, "prov/model-a", usage({ sentCount: 5, cacheRead: 5000 }), [
          "a",
          "b",
          "c",
          "d",
          "e",
        ])
        yield* CacheMark.recordUsage(db, "prov/model-b", usage({ sentCount: 2, cacheRead: 0, cacheWrite: 0 }), ["a", "b"])
        expect(yield* row(db, "prov/model-a")).toMatchObject({ mark_tokens: 5000, mark_index: 5 })
        expect(yield* row(db, "prov/model-b")).toMatchObject({ mark_tokens: 0, mark_index: 0 })
      }),
    ))

  test("failure reset collapses a confirmed mark to zero (issue #39)", () =>
    run(
      Effect.gen(function* () {
        const db = yield* migratedDb
        yield* CacheMark.recordUsage(db, provider, usage({ sentCount: 3, cacheRead: 900, cacheWrite: 300 }), [
          "m0",
          "m1",
          "m2",
        ])
        expect(yield* row(db)).toMatchObject({ mark_tokens: 1200, mark_index: 3 })
        yield* CacheMark.reset(db, provider)
        expect(yield* row(db)).toMatchObject({ mark_tokens: 0, mark_index: 0, prefix_hash: null })
        expect(yield* CacheMark.markIndexFor(db, provider, ["m0", "m1", "m2"])).toBe(0)
      }),
    ))

  test("self-heal: the next confirmed response restores the mark after a failure reset (issue #39)", () =>
    run(
      Effect.gen(function* () {
        const db = yield* migratedDb
        yield* CacheMark.recordUsage(db, provider, usage({ sentCount: 3, cacheRead: 900, cacheWrite: 300 }), [
          "m0",
          "m1",
          "m2",
        ])
        yield* CacheMark.reset(db, provider)
        yield* CacheMark.recordUsage(db, provider, usage({ sentCount: 6, cacheRead: 0, cacheWrite: 5000 }), [
          "m0",
          "m1",
          "m2",
          "m3",
          "m4",
          "m5",
        ])
        expect(yield* row(db)).toMatchObject({ mark_tokens: 5000, mark_index: 6 })
        expect(yield* CacheMark.markIndexFor(db, provider, ["m0", "m1", "m2", "m3", "m4", "m5"])).toBe(6)
      }),
    ))
})

const created = DateTime.makeUnsafe(0)
const id = (value: string) => SessionMessage.ID.make(`msg_${value}`)
const big = (size = 3000) => "x".repeat(size)

const user = (value: string) =>
  SessionMessage.User.make({ id: id(value), type: "user", text: "prompt", time: { created } })

const completedTool = (args: { id: string; name: string; text: string; input?: Record<string, unknown> }) =>
  SessionMessage.AssistantTool.make({
    type: "tool",
    id: args.id,
    name: args.name,
    state: SessionMessage.ToolStateCompleted.make({
      status: "completed",
      input: args.input ?? {},
      content: [{ type: "text", text: args.text }],
      structured: {},
    }),
    time: { created },
  })

const assistant = (value: string, content: SessionMessage.Assistant["content"]) =>
  SessionMessage.Assistant.make({
    id: id(value),
    type: "assistant",
    agent: "build",
    model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
    content,
    time: { created, completed: created },
  })

const toolText = (message: SessionMessage.Message, index = 0) => {
  if (message.type !== "assistant") throw new Error("expected assistant")
  const item = message.content[index]
  if (item === undefined || item.type !== "tool") throw new Error("expected tool")
  if (item.state.status !== "completed") throw new Error("expected completed")
  const text = item.state.content[0]
  if (text === undefined || text.type !== "text") throw new Error("expected text content")
  return text.text
}

const history = () => [
  user("u1"),
  assistant("a1", [completedTool({ id: "call_1", name: "bash", text: big(), input: { command: "npm test" } })]),
  assistant("a2", [completedTool({ id: "call_2", name: "read", text: big(), input: { path: "f2.txt" } })]),
  assistant("a3", [completedTool({ id: "call_3", name: "read", text: big(), input: { path: "f3.txt" } })]),
  user("u2"),
  assistant("a4", [completedTool({ id: "call_4", name: "bash", text: big(), input: { command: "npm run build" } })]),
]

describe("MemoryContext markIndex (suffix-only compression)", () => {
  const compact = (messages: readonly SessionMessage.Message[], overrides?: Partial<MemoryContext.Options>) =>
    MemoryContext.project(messages, { enabled: true, minOutputChars: 100, keepRecentUserTurns: 1, ...overrides })

  test("mark 0 is byte-identical to projection without a mark", () => {
    const messages = history()
    expect(JSON.stringify(compact(messages, { markIndex: 0 }))).toBe(JSON.stringify(compact(messages)))
  })

  test("messages below the mark stay byte-identical; only the suffix is compacted", () => {
    const messages = history()
    const projected = compact(messages, { markIndex: 2 })
    expect(JSON.stringify(projected[0])).toBe(JSON.stringify(messages[0]))
    expect(JSON.stringify(projected[1])).toBe(JSON.stringify(messages[1]))
    expect(toolText(projected[2]!)).toContain("[mem:compacted tool result]")
    expect(toolText(projected[2]!)).toContain("call_id=call_2")
    expect(toolText(projected[3]!)).toContain("[mem:compacted tool result]")
  })

  test("a mark covering everything eligible disables compaction", () => {
    const messages = history()
    expect(JSON.stringify(compact(messages, { markIndex: 99 }))).toBe(JSON.stringify(messages))
  })

  test("first-delivery with a mark compresses the fresh tail above the mark only", () => {
    const messages = [
      user("u1"),
      assistant("a1", [completedTool({ id: "call_1", name: "read", text: big(), input: { path: "f1.txt" } })]),
      assistant("a2", [completedTool({ id: "call_2", name: "read", text: big(), input: { path: "f2.txt" } })]),
    ]
    const projected = MemoryContext.project(messages, {
      enabled: true,
      firstDelivery: true,
      minOutputChars: 100,
      markIndex: 1,
    })
    expect(JSON.stringify(projected[0])).toBe(JSON.stringify(messages[0]))
    expect(toolText(projected[1]!)).toContain("[mem:compacted tool result]")
    expect(toolText(projected[2]!)).toContain("[mem:compacted tool result]")
  })

  // Issue #29 P1: the ledger flag alone selects first-delivery — B0 is the
  // ledger policy, not a second flag. The projection must be byte-identical
  // to the explicit firstDelivery:true arm (the acceptance-tested fdmark).
  test("OPENCODE_MEMORY_CACHE_MARK env implies first-delivery (byte-identical to explicit FD)", () => {
    process.env["OPENCODE_MEMORY_CACHE_MARK"] = "1"
    try {
      const messages = [
        user("u1"),
        assistant("a1", [completedTool({ id: "call_1", name: "read", text: big(), input: { path: "f1.txt" } })]),
        assistant("a2", [completedTool({ id: "call_2", name: "read", text: big(), input: { path: "f2.txt" } })]),
      ]
      const implied = MemoryContext.project(messages, { enabled: true, minOutputChars: 100, markIndex: 1 })
      const explicit = MemoryContext.project(messages, {
        enabled: true,
        firstDelivery: true,
        minOutputChars: 100,
        markIndex: 1,
      })
      expect(JSON.stringify(implied)).toBe(JSON.stringify(explicit))
      expect(toolText(implied[1]!)).toContain("[mem:compacted tool result]")
      expect(JSON.stringify(implied[0])).toBe(JSON.stringify(messages[0]))
    } finally {
      delete process.env["OPENCODE_MEMORY_CACHE_MARK"]
    }
  })

  // Regression (issue #29 acceptance, fdmark arm): the ledger used to floor
  // the whole sent request (sentCount = projected length), so compacted
  // messages fell below the grown mark and were re-sent as raw originals —
  // mutating the provider's cached marker prefix and re-uploading the full
  // bulk every turn. The mark must only cover the verbatim prefix.
  test("mark grown from the verbatim prefix keeps re-compacting the tail (two-step FD)", () => {
    const step1 = [
      user("u1"),
      assistant("a1", [completedTool({ id: "call_1", name: "read", text: big(), input: { path: "f1.txt" } })]),
    ]
    const projected1 = MemoryContext.project(step1, { enabled: true, firstDelivery: true, minOutputChars: 100 })
    const mark1 = CacheMark.verbatimPrefixLength(projected1, step1)
    expect(mark1).toBe(1)
    expect(CacheMark.applyUsage(undefined, usage({ sentCount: mark1, cacheRead: 4000 }))).toEqual({
      tokens: 4000,
      index: 1,
    })

    const step2 = [
      ...step1,
      assistant("a2", [completedTool({ id: "call_2", name: "read", text: big(), input: { path: "f2.txt" } })]),
    ]
    const projected2 = MemoryContext.project(step2, {
      enabled: true,
      firstDelivery: true,
      minOutputChars: 100,
      markIndex: 1,
    })
    expect(JSON.stringify(projected2[0])).toBe(JSON.stringify(step2[0]))
    expect(toolText(projected2[1]!)).toContain("[mem:compacted tool result]")
    expect(toolText(projected2[2]!)).toContain("[mem:compacted tool result]")
    // The re-compacted tail is byte-identical to step 1's marker, so the
    // projected prefix stays append-only across steps.
    expect(JSON.stringify(projected2.slice(0, 2))).toBe(JSON.stringify(projected1))
    expect(CacheMark.verbatimPrefixLength(projected2, step2)).toBe(1)
  })
})
