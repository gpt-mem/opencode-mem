import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Database } from "@opencode/core/database/database"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { SessionTable } from "@opencode/core/session/sql"
import { MemRecordStore } from "@opencode/core/session/mem-record-store"
import { Project } from "@opencode/schema/project"
import { testEffect } from "./lib/effect"

const sessionID = "ses_mem_search" as const

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node]), []))

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "mem-search",
      directory: "/project",
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
})

const seed = (entries: Parameters<typeof MemRecordStore.writeBatch>[1]["entries"]) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* setup
    const result = yield* MemRecordStore.writeBatch(db, { sessionID, agent: "test-agent", entries })
    if (!result.ok) throw new Error(`seed failed: ${JSON.stringify(result.error)}`)
    return { db, records: result.records }
  })

describe("MemRecordStore.search", () => {
  // A no-query listing is the plainest call the tool makes; it must not throw.
  it.effect("lists records when no query is given", () =>
    Effect.gen(function* () {
      const { db } = yield* seed([
        { type: "decision", subject: "first", decision: "alpha" },
        { type: "decision", subject: "second", decision: "beta" },
      ])
      const result = yield* MemRecordStore.search(db, { sessionID })
      // No query lists newest first, so the most recent decision wins the limit.
      expect(result?.records.map((record) => record.subject)).toEqual(["second", "first"])
    }),
  )

  // A regex that finds nothing falls back to plain-text word matching, which
  // ranks by how many query terms a record contains. The best matches must
  // survive the limit, not the tail of the ranked list.
  it.effect("returns the best plain-text matches within the limit", () =>
    Effect.gen(function* () {
      const { db } = yield* seed([
        { type: "decision", subject: "only left", decision: "дефект" },
        { type: "decision", subject: "both terms", decision: "хвост дефект" },
        { type: "decision", subject: "only right", decision: "хвост" },
      ])
      const result = yield* MemRecordStore.search(db, { sessionID, query: "дефект хвост", limit: 2 })
      expect(result?.matched).toBe(3)
      expect(result?.records.map((record) => record.subject)).toContain("both terms")
    }),
  )

  // Superseded records are history, not current state: a query must not resurface them.
  it.effect("hides superseded records when a query is given", () =>
    Effect.gen(function* () {
      const { db, records } = yield* seed([{ type: "decision", subject: "old", decision: "дефект" }])
      yield* MemRecordStore.writeBatch(db, {
        sessionID,
        agent: "test-agent",
        entries: [{ type: "decision", subject: "new", decision: "дефект", supersedes: records[0]!.id }],
      })
      const result = yield* MemRecordStore.search(db, { sessionID, query: "дефект" })
      expect(result?.records.map((record) => record.subject)).toEqual(["new"])
    }),
  )
})
