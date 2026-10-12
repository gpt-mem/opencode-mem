import { Effect, Schema } from "effect"
import { and, eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { MemRecord } from "@opencode-ai/core/session/mem-record"
import { MemRecordTable, SessionTable } from "@opencode-ai/core/session/sql"
import * as Tool from "./tool"

const MAX_CHAIN = 10

export const Parameters = Schema.Struct({
  id: Schema.String.annotate({
    description: "Memory record id (mem_...), e.g. from search_operational_memory or a put result",
  }),
})

type Metadata = { found: boolean }

export const GetOperationalMemoryTool = Tool.define<typeof Parameters, Metadata, Database.Service>(
  "get_operational_memory",
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = database.db

    return {
      description:
        "Fetch one operational memory by id with full provenance: authority (user vs agent), decided_by, " +
        "recorded_by, source_ref, timestamps, and the whole revision chain — records this one supersedes " +
        "and records that supersede it. When source_ref points at a tool call, the response includes the " +
        "exact get_tool_call_details invocation to load the original utterance. Use " +
        "search_operational_memory to find ids first.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "get_operational_memory",
            patterns: ["*"],
            always: ["*"],
            metadata: {},
          })
          const session = yield* db
            .select({ project_id: SessionTable.project_id })
            .from(SessionTable)
            .where(eq(SessionTable.id, ctx.sessionID))
            .get()
            .pipe(Effect.orDie)
          if (session === undefined) {
            return {
              title: "No project for session",
              output: JSON.stringify({ found: false, error: `Session ${ctx.sessionID} not found` }, null, 2),
              metadata: { found: false },
            }
          }

          const row = yield* db
            .select()
            .from(MemRecordTable)
            .where(and(eq(MemRecordTable.id, params.id), eq(MemRecordTable.project_id, session.project_id)))
            .get()
            .pipe(Effect.orDie)
          if (row === undefined) {
            return {
              title: "Memory not found",
              output: JSON.stringify(
                { found: false, error: `No memory ${params.id} in this project — try search_operational_memory` },
                null,
                2,
              ),
              metadata: { found: false },
            }
          }

          // Walk the revision chain in both directions, bounded so a corrupt
          // cycle cannot loop forever.
          const supersedes_chain: MemRecord.Record[] = []
          let cursor = row.supersedes
          for (let i = 0; i < MAX_CHAIN && cursor !== null; i++) {
            const parent = yield* db
              .select()
              .from(MemRecordTable)
              .where(and(eq(MemRecordTable.id, cursor), eq(MemRecordTable.project_id, session.project_id)))
              .get()
              .pipe(Effect.orDie)
            if (parent === undefined) break
            supersedes_chain.unshift(toRecord(parent))
            cursor = parent.supersedes
          }

          const superseded_by: MemRecord.Record[] = []
          let child = row.id
          for (let i = 0; i < MAX_CHAIN; i++) {
            const next = yield* db
              .select()
              .from(MemRecordTable)
              .where(and(eq(MemRecordTable.supersedes, child), eq(MemRecordTable.project_id, session.project_id)))
              .orderBy(MemRecordTable.time_created, MemRecordTable.id)
              .get()
              .pipe(Effect.orDie)
            if (next === undefined) break
            superseded_by.push(toRecord(next))
            child = next.id
          }

          const source =
            row.source_ref === null
              ? undefined
              : {
                  ref: row.source_ref,
                  retrieve: row.source_ref.startsWith("call_")
                    ? `get_tool_call_details(call_id="${row.source_ref}")`
                    : undefined,
                }

          return {
            title: `Memory ${row.id} v${row.version}`,
            output: JSON.stringify(
              {
                found: true,
                record: toRecord(row),
                supersedes_chain,
                superseded_by,
                source,
              },
              null,
              2,
            ),
            metadata: { found: true },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)

function toRecord(row: typeof MemRecordTable.$inferSelect): MemRecord.Record {
  return {
    id: row.id,
    type: row.type,
    subject: row.subject,
    content: row.content,
    reason: row.reason ?? undefined,
    status: row.status,
    authority: row.authority,
    decided_by: row.decided_by ?? undefined,
    recorded_by: row.recorded_by,
    source_ref: row.source_ref ?? undefined,
    scope: row.scope ?? undefined,
    supersedes: row.supersedes ?? undefined,
    version: row.version,
    time_created: row.time_created,
    time_updated: row.time_updated,
  }
}
