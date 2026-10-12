import { Effect, Schema } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { MemRecord } from "@opencode-ai/core/session/mem-record"
import { MemRecordTable, SessionTable } from "@opencode-ai/core/session/sql"
import { Identifier } from "@/id/id"
import * as Tool from "./tool"

const MAX_ENTRIES = 10

export const Parameters = Schema.Struct({
  entries: Schema.Array(MemRecord.Entry)
    .check(Schema.isMinLength(1))
    .annotate({
      description: `Memory entries to persist (max ${MAX_ENTRIES}). Each needs type, subject and decision/content.`,
    }),
})

type Metadata = { written: number }

export const PutInOperationalMemoryTool = Tool.define<typeof Parameters, Metadata, Database.Service>(
  "put_in_operational_memory",
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = database.db

    return {
      description:
        "Persist typed operational memories (decisions, constraints, failed approaches, user signals) " +
        "so they survive across turns and sessions in this project. Content is PII-redacted before storage; " +
        "the original stays in session history. Agent proposals are recorded with authority=agent — only " +
        "set decided_by when a user (or named person) actually made the decision, never self-assert user " +
        "approval. Retrieve with search_operational_memory.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "put_in_operational_memory",
            patterns: ["*"],
            always: ["*"],
            metadata: {},
          })
          const entries = params.entries.slice(0, MAX_ENTRIES)
          const session = yield* db
            .select({ project_id: SessionTable.project_id })
            .from(SessionTable)
            .where(eq(SessionTable.id, ctx.sessionID))
            .get()
            .pipe(Effect.orDie)
          if (session === undefined) {
            return {
              title: "No project for session",
              output: JSON.stringify({ written: 0, error: `Session ${ctx.sessionID} not found` }, null, 2),
              metadata: { written: 0 },
            }
          }
          const projectID = session.project_id
          const now = Date.now()
          const inserted: MemRecord.Record[] = []

          for (const entry of entries) {
            const raw = entry.decision
            if (raw === undefined || raw.trim() === "") {
              return {
                title: "Rejected: empty decision",
                output: JSON.stringify(
                  { written: 0, error: `Entry type=${entry.type} subject="${entry.subject}" has empty decision` },
                  null,
                  2,
                ),
                metadata: { written: 0 },
              }
            }
            const authority = MemRecord.resolveAuthority({
              decided_by: entry.decided_by,
              recorded_by: ctx.agent,
            })
            const id = Identifier.create("mem", "ascending")
            const row = {
              id,
              project_id: projectID,
              session_id: ctx.sessionID,
              type: entry.type,
              subject: MemRecord.normalizeSubject(entry.subject),
              content: MemRecord.redactContent(raw),
              reason: entry.reason === undefined ? null : MemRecord.redactReason(entry.reason),
              status: "active" as const,
              authority,
              decided_by: entry.decided_by ?? null,
              recorded_by: ctx.agent,
              source_ref: entry.source_ref ?? null,
              scope: entry.scope ?? null,
              supersedes: null,
              version: 1,
              time_created: now,
              time_updated: now,
            }
            yield* db.insert(MemRecordTable).values(row).pipe(Effect.orDie)
            inserted.push(toRecord(row))
          }

          return {
            title: `${inserted.length} memories written`,
            output: JSON.stringify({ written: inserted.length, records: inserted }, null, 2),
            metadata: { written: inserted.length },
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
