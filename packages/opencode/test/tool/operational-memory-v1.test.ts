import { afterEach, describe, expect } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { Project } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "@/tool/tool"
import { Agent } from "../../src/agent/agent"
import { PutInOperationalMemoryTool } from "../../src/tool/put-in-operational-memory"
import { SearchOperationalMemoryTool } from "../../src/tool/search-operational-memory"
import { Truncate } from "@/tool/truncate"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(LayerNode.compile(LayerNode.group([Database.node, Truncate.node, Agent.node])))

const sessionID = SessionID.make("ses_v1_memrec_test")
const otherSessionID = SessionID.make("ses_v1_memrec_other")

const seed = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values([
      {
        id: sessionID,
        project_id: Project.ID.global,
        slug: "memrec",
        directory: AbsolutePath.make("/project"),
        title: "test",
        version: "0.0.0",
      },
      {
        id: otherSessionID,
        project_id: Project.ID.global,
        slug: "memrec-other",
        directory: AbsolutePath.make("/project"),
        title: "other",
        version: "0.0.0",
      },
    ])
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

const ctx = (sid: SessionID = sessionID, agent = "build"): Tool.Context => ({
  sessionID: sid,
  messageID: MessageID.ascending(),
  agent,
  abort: new AbortController().signal,
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
})

describe("tool.put_in_operational_memory (V1)", () => {
  it.instance("writes a decision and returns the record", () =>
    Effect.gen(function* () {
      yield* seed
      const def = yield* Tool.init(yield* PutInOperationalMemoryTool)
      const result = yield* def.execute(
        {
          entries: [
            {
              type: "decision",
              subject: "fork OpenCode",
              decision: "принято решение форкать опенкод и его развивать",
              reason: "нужен свой контекст-слой",
              decided_by: "user",
              source_ref: "call_abc123",
            },
          ],
        },
        ctx(),
      )
      const parsed = JSON.parse(result.output)
      expect(parsed.written).toBe(1)
      expect(parsed.records).toHaveLength(1)
      const record = parsed.records[0]
      expect(record.type).toBe("decision")
      expect(record.subject).toBe("fork OpenCode")
      expect(record.content).toContain("форкать опенкод")
      expect(record.authority).toBe("user")
      expect(record.decided_by).toBe("user")
      expect(record.recorded_by).toBe("build")
      expect(record.source_ref).toBe("call_abc123")
      expect(record.status).toBe("active")
      expect(record.version).toBe(1)
    }),
  )

  it.instance("agent proposal without decided_by gets authority=agent", () =>
    Effect.gen(function* () {
      yield* seed
      const def = yield* Tool.init(yield* PutInOperationalMemoryTool)
      const result = yield* def.execute(
        {
          entries: [
            {
              type: "decision",
              subject: "use SQLite",
              decision: "storage layer should be SQLite",
            },
          ],
        },
        ctx(),
      )
      const parsed = JSON.parse(result.output)
      expect(parsed.records[0].authority).toBe("agent")
      expect(parsed.records[0].decided_by).toBeUndefined()
    }),
  )

  it.instance("rejects empty decision content", () =>
    Effect.gen(function* () {
      yield* seed
      const def = yield* Tool.init(yield* PutInOperationalMemoryTool)
      const result = yield* def.execute(
        {
          entries: [{ type: "decision", subject: "empty", decision: "   " }],
        },
        ctx(),
      )
      const parsed = JSON.parse(result.output)
      expect(parsed.written).toBe(0)
      expect(parsed.error).toContain("empty decision")
    }),
  )

  it.instance("redacts credentials before storage", () =>
    Effect.gen(function* () {
      yield* seed
      const def = yield* Tool.init(yield* PutInOperationalMemoryTool)
      const result = yield* def.execute(
        {
          entries: [
            {
              type: "decision",
              subject: "deploy key",
              decision: "rollback token is sk-abcdef1234567890abcdef for the deploy",
            },
          ],
        },
        ctx(),
      )
      const parsed = JSON.parse(result.output)
      expect(parsed.records[0].content).not.toContain("sk-abcdef1234567890abcdef")
      expect(parsed.records[0].content).toContain("[REDACTED:api_key]")
    }),
  )

  it.instance("writes multiple entries in one batch", () =>
    Effect.gen(function* () {
      yield* seed
      const def = yield* Tool.init(yield* PutInOperationalMemoryTool)
      const result = yield* def.execute(
        {
          entries: [
            { type: "decision", subject: "a", decision: "first" },
            { type: "constraint", subject: "b", decision: "must not break cache" },
            { type: "failed_approach", subject: "c", decision: "sliding window invalidated prefix" },
          ],
        },
        ctx(),
      )
      const parsed = JSON.parse(result.output)
      expect(parsed.written).toBe(3)
    }),
  )
})

describe("tool.search_operational_memory (V1)", () => {
  it.instance("finds a decision written in a previous turn", () =>
    Effect.gen(function* () {
      yield* seed
      const put = yield* Tool.init(yield* PutInOperationalMemoryTool)
      yield* put.execute(
        {
          entries: [
            {
              type: "decision",
              subject: "fork OpenCode",
              decision: "принято решение форкать опенкод и его развивать",
              decided_by: "user",
            },
          ],
        },
        ctx(),
      )
      const search = yield* Tool.init(yield* SearchOperationalMemoryTool)
      const result = yield* search.execute({ query: "форкать" }, ctx())
      const parsed = JSON.parse(result.output)
      expect(parsed.matched).toBe(1)
      expect(parsed.records[0].content).toContain("форкать опенкод")
      expect(parsed.records[0].authority).toBe("user")
    }),
  )

  it.instance("finds decisions written from a different session (cross-session)", () =>
    Effect.gen(function* () {
      yield* seed
      const put = yield* Tool.init(yield* PutInOperationalMemoryTool)
      yield* put.execute(
        {
          entries: [{ type: "decision", subject: "cache strategy", decision: "use provider cache-mark ledger" }],
        },
        ctx(otherSessionID),
      )
      const search = yield* Tool.init(yield* SearchOperationalMemoryTool)
      const result = yield* search.execute({ query: "cache-mark" }, ctx(sessionID))
      const parsed = JSON.parse(result.output)
      expect(parsed.matched).toBe(1)
      expect(parsed.records[0].content).toContain("cache-mark ledger")
    }),
  )

  it.instance("filters by type", () =>
    Effect.gen(function* () {
      yield* seed
      const put = yield* Tool.init(yield* PutInOperationalMemoryTool)
      yield* put.execute(
        {
          entries: [
            { type: "decision", subject: "d1", decision: "pick SQLite" },
            { type: "constraint", subject: "c1", decision: "never mutate prefix below mark" },
          ],
        },
        ctx(),
      )
      const search = yield* Tool.init(yield* SearchOperationalMemoryTool)
      const result = yield* search.execute({ type: "constraint" }, ctx())
      const parsed = JSON.parse(result.output)
      expect(parsed.matched).toBe(1)
      expect(parsed.records[0].type).toBe("constraint")
    }),
  )

  it.instance("filters by scope tag", () =>
    Effect.gen(function* () {
      yield* seed
      const put = yield* Tool.init(yield* PutInOperationalMemoryTool)
      yield* put.execute(
        {
          entries: [
            { type: "decision", subject: "s1", decision: "scoped decision", scope: "issue-13" },
            { type: "decision", subject: "s2", decision: "other decision", scope: "issue-9" },
          ],
        },
        ctx(),
      )
      const search = yield* Tool.init(yield* SearchOperationalMemoryTool)
      const result = yield* search.execute({ scope: "issue-13" }, ctx())
      const parsed = JSON.parse(result.output)
      expect(parsed.matched).toBe(1)
      expect(parsed.records[0].subject).toBe("s1")
    }),
  )

  it.instance("returns empty for unknown query", () =>
    Effect.gen(function* () {
      yield* seed
      const put = yield* Tool.init(yield* PutInOperationalMemoryTool)
      yield* put.execute({ entries: [{ type: "decision", subject: "x", decision: "y" }] }, ctx())
      const search = yield* Tool.init(yield* SearchOperationalMemoryTool)
      const result = yield* search.execute({ query: "definitely-not-present" }, ctx())
      const parsed = JSON.parse(result.output)
      expect(parsed.matched).toBe(0)
      expect(parsed.records).toHaveLength(0)
    }),
  )

  it.instance("most recent first when multiple match", () =>
    Effect.gen(function* () {
      yield* seed
      const put = yield* Tool.init(yield* PutInOperationalMemoryTool)
      yield* put.execute(
        {
          entries: [
            { type: "decision", subject: "old", decision: "first decision about topic" },
            { type: "decision", subject: "new", decision: "second decision about topic" },
          ],
        },
        ctx(),
      )
      const search = yield* Tool.init(yield* SearchOperationalMemoryTool)
      const result = yield* search.execute({ query: "decision about topic" }, ctx())
      const parsed = JSON.parse(result.output)
      expect(parsed.matched).toBe(2)
      expect(parsed.records[0].subject).toBe("new")
      expect(parsed.records[1].subject).toBe("old")
    }),
  )
})
