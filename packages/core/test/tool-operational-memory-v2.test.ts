import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { MemRecordTable, SessionTable } from "@opencode-ai/core/session/sql"
import { MemRecordStore } from "@opencode-ai/core/session/mem-record-store"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { GetOperationalMemoryTool } from "@opencode-ai/core/tool/get-operational-memory"
import { PutInOperationalMemoryTool } from "@opencode-ai/core/tool/put-in-operational-memory"
import { SearchOperationalMemoryTool } from "@opencode-ai/core/tool/search-operational-memory"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { testEffect } from "./lib/effect"
import { toolIdentity, executeTool } from "./lib/tool"

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: () => Effect.void,
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      ToolRegistry.node,
      ToolRegistry.toolsNode,
      PutInOperationalMemoryTool.node,
      SearchOperationalMemoryTool.node,
      GetOperationalMemoryTool.node,
    ]),
    [
      [PermissionV2.node, permission],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    ],
  ),
)

const sessionID = SessionV2.ID.make("ses_opmem_v2")
const otherSessionID = SessionV2.ID.make("ses_opmem_v2_other")

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values([
      {
        id: sessionID,
        project_id: Project.ID.global,
        slug: "opmem-v2",
        directory: "/project",
        title: "opmem-v2",
        version: "test",
      },
      {
        id: otherSessionID,
        project_id: Project.ID.global,
        slug: "opmem-v2-other",
        directory: "/project",
        title: "opmem-v2-other",
        version: "test",
      },
    ])
    .run()
    .pipe(Effect.orDie)
})

const put = (input: Record<string, unknown>, sid = sessionID) => ({
  sessionID: sid,
  ...toolIdentity,
  call: { type: "tool-call" as const, id: "call_put", name: PutInOperationalMemoryTool.name, input },
})

const search = (input: Record<string, unknown>, sid = sessionID) => ({
  sessionID: sid,
  ...toolIdentity,
  call: { type: "tool-call" as const, id: "call_search", name: SearchOperationalMemoryTool.name, input },
})

const get = (input: Record<string, unknown>, sid = sessionID) => ({
  sessionID: sid,
  ...toolIdentity,
  call: { type: "tool-call" as const, id: "call_get", name: GetOperationalMemoryTool.name, input },
})

const parsed = (result: { type: string; value: unknown }) => {
  if (result.type !== "text" && result.type !== "json") throw new Error(`unexpected result type: ${result.type}`)
  return typeof result.value === "string"
    ? (JSON.parse(result.value) as Record<string, unknown>)
    : (result.value as Record<string, unknown>)
}

describe("V2 operational-memory tools", () => {
  it.effect("writeBatch is idempotent for source-linked records", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const entry = {
        type: "decision" as const,
        subject: "reasoning-ledger",
        decision: "keep a rolling summary",
        source_ref: `${sessionID}#decision:abc123`,
      }
      const first = yield* MemRecordStore.writeBatch(db, { sessionID, agent: "compaction", entries: [entry] })
      const second = yield* MemRecordStore.writeBatch(db, { sessionID, agent: "compaction", entries: [entry] })
      expect(first.ok).toBe(true)
      expect(second.ok).toBe(true)
      if (!first.ok || !second.ok) return
      expect(second.records[0]?.id).toBe(first.records[0]?.id)
      const rows = yield* db.select().from(MemRecordTable).all().pipe(Effect.orDie)
      expect(rows).toHaveLength(1)
      expect(rows[0]?.authority).toBe("agent")
    }),
  )

  it.effect("put then search then get with provenance and revision chain", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service

      const first = parsed(
        yield* executeTool(
          registry,
          put({
            entries: [
              {
                type: "decision",
                subject: "database-choice",
                decision: "use PostgreSQL",
                reason: "need transactions",
                decided_by: "user",
              },
            ],
          }),
        ),
      )
      expect(first["written"]).toBe(1)
      const v1 = (first["records"] as Record<string, unknown>[])[0]
      expect(v1["authority"]).toBe("user")

      const second = parsed(
        yield* executeTool(
          registry,
          put({
            entries: [
              {
                type: "decision",
                subject: "database-choice",
                decision: "use SQLite",
                reason: "local project",
                decided_by: "user",
                supersedes: v1["id"],
              },
            ],
          }),
        ),
      )
      expect(second["written"]).toBe(1)
      const v2 = (second["records"] as Record<string, unknown>[])[0]
      expect(v2["version"]).toBe(2)
      expect(v2["supersedes"]).toBe(v1["id"])

      const found = parsed(yield* executeTool(registry, search({ query: "database" })))
      expect(found["matched"]).toBe(2)

      const detail = parsed(yield* executeTool(registry, get({ id: v2["id"] })))
      expect(detail["found"]).toBe(true)
      const record = detail["record"] as Record<string, unknown>
      expect(record["status"]).toBe("active")
      expect(record["authority"]).toBe("user")
      const chain = detail["supersedes_chain"] as Record<string, unknown>[]
      expect(chain.map((entry) => entry["id"])).toEqual([v1["id"]])
      expect(chain[0]["status"]).toBe("superseded")
      expect(detail["superseded_by"]).toEqual([])
    }),
  )

  it.effect("cross-session search and get", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      const written = parsed(
        yield* executeTool(
          registry,
          put({ entries: [{ type: "constraint", subject: "ci-gate", decision: "core full suite must pass" }] }),
        ),
      )
      expect(written["written"]).toBe(1)

      const found = parsed(yield* executeTool(registry, search({ query: "ci-gate" }, otherSessionID)))
      expect(found["matched"]).toBe(1)
      const id = (found["records"] as Record<string, unknown>[])[0]["id"] as string

      const detail = parsed(yield* executeTool(registry, get({ id }, otherSessionID)))
      expect(detail["found"]).toBe(true)
      expect((detail["record"] as Record<string, unknown>)["authority"]).toBe("agent")
    }),
  )

  it.effect("rejects the whole batch on a bad entry (all-or-nothing)", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      const result = parsed(
        yield* executeTool(
          registry,
          put({
            entries: [
              { type: "decision", subject: "good", decision: "v1" },
              { type: "decision", subject: "bad", decision: "  " },
            ],
          }),
        ),
      )
      expect(result["written"]).toBe(0)
      expect(String(result["error"])).toContain("empty decision")
      const leftover = parsed(yield* executeTool(registry, search({ query: "good" })))
      expect(leftover["matched"]).toBe(0)
    }),
  )

  it.effect("get on unknown id reports found=false", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      const result = parsed(yield* executeTool(registry, get({ id: "mem_missing" })))
      expect(result["found"]).toBe(false)
      expect(String(result["error"])).toContain("try search_operational_memory")
    }),
  )

  it.effect("search explains a query that erased filter-matched records", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      yield* executeTool(
        registry,
        put({ entries: [{ type: "decision", subject: "cache strategy", decision: "use provider cache-mark ledger" }] }),
      )
      const result = parsed(yield* executeTool(registry, search({ type: "decision", query: "decision" })))
      expect(result["matched"]).toBe(0)
      expect(result["filter_matched"]).toBe(1)
      expect(String(result["hint"])).toContain("retry without query")

      const listed = parsed(yield* executeTool(registry, search({ type: "decision" })))
      expect(listed["matched"]).toBe(1)
      expect(listed["hint"]).toBeUndefined()
    }),
  )
})
