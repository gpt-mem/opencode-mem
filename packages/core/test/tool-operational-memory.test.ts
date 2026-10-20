import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Database } from "@opencode/core/database/database"
import { Permission } from "@opencode/core/permission"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionTable } from "@opencode/core/session/sql"
import { Tool } from "@opencode/core/tool"
import { OperationalMemoryTool } from "@opencode/core/tool/plugin/operational-memory"
import { Project } from "@opencode/schema/project"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { testEffect } from "./lib/effect"
import { permissionLayer } from "./lib/permission"
import { toolIdentity, executeTool, registerToolPlugin, type ToolExecution } from "./lib/tool"

const assertions: Permission.AssertInput[] = []
const permission = permissionLayer({
  assert: (input) =>
    Effect.sync(() => {
      assertions.push(input)
    }),
})

const memNode = makeLocationNode({
  name: "test/operational-memory-tools",
  layer: Layer.effectDiscard(registerToolPlugin(OperationalMemoryTool.Plugin)),
  deps: [Tool.node, Database.node, Permission.node],
})

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Tool.node, Database.node, memNode]), [
    Permission.node.replace(permission),
  ]),
)

const sessionID = Session.ID.make("ses_opmem_v2")
const otherSessionID = Session.ID.make("ses_opmem_v2_other")

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
      { id: sessionID, project_id: Project.ID.global, slug: "opmem-v2", directory: "/project", version: "test" },
      {
        id: otherSessionID,
        project_id: Project.ID.global,
        slug: "opmem-v2-other",
        directory: "/project",
        version: "test",
      },
    ])
    .run()
    .pipe(Effect.orDie)
})

const put = (input: Record<string, unknown>, sid = sessionID) => ({
  sessionID: sid,
  ...toolIdentity,
  call: { type: "tool-call" as const, id: "call_put", name: OperationalMemoryTool.putName, input },
})

const search = (input: Record<string, unknown>, sid = sessionID) => ({
  sessionID: sid,
  ...toolIdentity,
  call: { type: "tool-call" as const, id: "call_search", name: OperationalMemoryTool.searchName, input },
})

const get = (input: Record<string, unknown>, sid = sessionID) => ({
  sessionID: sid,
  ...toolIdentity,
  call: { type: "tool-call" as const, id: "call_get", name: OperationalMemoryTool.getName, input },
})

const output = (result: ToolExecution) => {
  if (result.status !== "completed") throw new Error(`tool failed: ${JSON.stringify(result.error)}`)
  return result.output
}

describe("operational-memory tools", () => {
  it.effect("put then search then get with provenance and revision chain", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* Tool.Service

      const first = output(
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
      expect(first.written).toBe(1)
      const v1 = first.records[0]
      expect(v1.authority).toBe("user")

      const second = output(
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
                supersedes: v1.id,
              },
            ],
          }),
        ),
      )
      expect(second.written).toBe(1)
      const v2 = second.records[0]
      expect(v2.version).toBe(2)
      expect(v2.supersedes).toBe(v1.id)

      const found = output(yield* executeTool(registry, search({ query: "database" })))
      expect(found.matched).toBe(2)

      const detail = output(yield* executeTool(registry, get({ id: v2.id })))
      expect(detail.found).toBe(true)
      expect(detail.record.status).toBe("active")
      expect(detail.record.authority).toBe("user")
      expect(detail.supersedes_chain.map((entry: { id: string }) => entry.id)).toEqual([v1.id])
      expect(detail.supersedes_chain[0].status).toBe("superseded")
      expect(detail.superseded_by).toEqual([])
    }),
  )

  it.effect("cross-session search and get", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* Tool.Service
      const written = output(
        yield* executeTool(
          registry,
          put({ entries: [{ type: "constraint", subject: "ci-gate", decision: "core full suite must pass" }] }),
        ),
      )
      expect(written.written).toBe(1)

      const found = output(yield* executeTool(registry, search({ query: "ci-gate" }, otherSessionID)))
      expect(found.matched).toBe(1)
      const id = found.records[0].id

      const detail = output(yield* executeTool(registry, get({ id }, otherSessionID)))
      expect(detail.found).toBe(true)
      expect(detail.record.authority).toBe("agent")
    }),
  )

  it.effect("rejects the whole batch on a bad entry (all-or-nothing)", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* Tool.Service
      const result = output(
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
      expect(result.written).toBe(0)
      expect(String(result.error)).toContain("empty decision")
      const leftover = output(yield* executeTool(registry, search({ query: "good" })))
      expect(leftover.matched).toBe(0)
    }),
  )

  it.effect("get on unknown id reports found=false", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* Tool.Service
      const result = output(yield* executeTool(registry, get({ id: "mem_missing" })))
      expect(result.found).toBe(false)
      expect(String(result.error)).toContain("try search_operational_memory")
    }),
  )

  it.effect("search explains a query that erased filter-matched records", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* Tool.Service
      yield* executeTool(
        registry,
        put({ entries: [{ type: "decision", subject: "cache strategy", decision: "use provider cache-mark ledger" }] }),
      )
      const result = output(yield* executeTool(registry, search({ type: "decision", query: "decision" })))
      expect(result.matched).toBe(0)
      expect(result.filter_matched).toBe(1)
      expect(String(result.hint)).toContain("retry without query")

      const listed = output(yield* executeTool(registry, search({ type: "decision" })))
      expect(listed.matched).toBe(1)
      expect(listed.hint).toBeUndefined()
    }),
  )

  it.effect("natural-language query finds a record on the first call", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* Tool.Service
      yield* executeTool(
        registry,
        put({
          entries: [
            {
              type: "decision",
              subject: "migration-idempotency",
              decision: "the mem_record migration must be idempotent",
              reason: "the shared stock database already has the table",
            },
          ],
        }),
      )
      // Words are in a different order than the stored text, so the regex pass
      // misses and only the plain-text fallback finds it.
      const found = output(yield* executeTool(registry, search({ query: "idempotent migration" })))
      expect(found.matched).toBe(1)
    }),
  )

  it.effect("an invalid regex query falls back to plain text instead of failing", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* Tool.Service
      yield* executeTool(
        registry,
        put({ entries: [{ type: "constraint", subject: "cache-ledger", decision: "mark zero means free track" }] }),
      )
      const found = output(yield* executeTool(registry, search({ query: "cache(" })))
      expect(found.matched).toBe(1)
    }),
  )
})
