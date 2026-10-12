import { Effect, Schema } from "effect"
import { and, eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { MemRecord } from "@opencode-ai/core/session/mem-record"
import { MemRecordTable, SessionTable } from "@opencode-ai/core/session/sql"
import * as Tool from "./tool"

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100

export const Parameters = Schema.Struct({
  query: Schema.optional(
    Schema.String.annotate({
      description: "Case-insensitive regular expression matched against subject, content and reason",
    }),
  ),
  type: Schema.optional(MemRecord.Type.annotate({ description: "Only return this record type" })),
  status: Schema.optional(
    MemRecord.Status.annotate({ description: "Filter by status (default: active only when no query given)" }),
  ),
  scope: Schema.optional(Schema.String.annotate({ description: "Exact match on the scope tag" })),
  limit: Schema.optional(
    Schema.Number.annotate({
      description: `Maximum records returned, most recent first (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`,
    }),
  ),
})

type Metadata = { matched: number }

export const SearchOperationalMemoryTool = Tool.define<typeof Parameters, Metadata, Database.Service>(
  "search_operational_memory",
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = database.db

    return {
      description:
        "Search typed operational memories (decisions, constraints, failed approaches, user signals) " +
        "stored for this project via put_in_operational_memory. Project-scoped: finds records from earlier " +
        "sessions too. Each hit includes authority (user vs agent), decided_by, reason and source_ref so " +
        "provenance is visible. Use this to recover 'what did we decide and why' without re-reading history.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "search_operational_memory",
            patterns: ["*"],
            always: ["*"],
            metadata: {},
          })
          const limit = Math.max(1, Math.min(params.limit ?? DEFAULT_LIMIT, MAX_LIMIT))
          const session = yield* db
            .select({ project_id: SessionTable.project_id })
            .from(SessionTable)
            .where(eq(SessionTable.id, ctx.sessionID))
            .get()
            .pipe(Effect.orDie)
          if (session === undefined) {
            return {
              title: "No project for session",
              output: JSON.stringify({ matches: [], matched: 0, error: `Session ${ctx.sessionID} not found` }, null, 2),
              metadata: { matched: 0 },
            }
          }

          const conditions = [eq(MemRecordTable.project_id, session.project_id)]
          if (params.type !== undefined) conditions.push(eq(MemRecordTable.type, params.type))
          if (params.scope !== undefined) conditions.push(eq(MemRecordTable.scope, params.scope))
          // Default to active-only so superseded/rejected noise stays out of the way;
          // an explicit status overrides.
          if (params.status !== undefined) conditions.push(eq(MemRecordTable.status, params.status))
          else if (params.query === undefined) conditions.push(eq(MemRecordTable.status, "active"))

          const rows = yield* db
            .select()
            .from(MemRecordTable)
            .where(and(...conditions))
            .orderBy(MemRecordTable.time_created, MemRecordTable.id)
            .all()
            .pipe(Effect.orDie)

          const regex = params.query === undefined ? undefined : new RegExp(params.query, "i")
          const matched = rows.filter((row) => {
            if (regex === undefined) return true
            const haystack = [row.subject, row.content, row.reason ?? ""].join("\n")
            return regex.test(haystack)
          })

          const records = matched.slice(-limit).reverse().map(toRecord)

          return {
            title: `${matched.length} matching memories`,
            output: JSON.stringify({ records, matched: matched.length }, null, 2),
            metadata: { matched: matched.length },
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
