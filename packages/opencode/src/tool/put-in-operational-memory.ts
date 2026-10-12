import { Effect, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { MemRecord } from "@opencode-ai/core/session/mem-record"
import { MemRecordStore } from "@opencode-ai/core/session/mem-record-store"
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
        "approval. To replace an earlier record pass its id in supersedes — the old record is marked " +
        "superseded and the new one carries version = old.version + 1. Retrieve with " +
        "search_operational_memory or get_operational_memory.",
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
          const result = yield* MemRecordStore.writeBatch(db, { sessionID: ctx.sessionID, agent: ctx.agent, entries })
          if (result.ok) {
            return {
              title: `${result.records.length} memories written`,
              output: JSON.stringify({ written: result.records.length, records: result.records }, null, 2),
              metadata: { written: result.records.length },
            }
          }
          const error = writeErrorMessage(result.error)
          return {
            title: error.title,
            output: JSON.stringify({ written: 0, error: error.detail }, null, 2),
            metadata: { written: 0 },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)

const writeErrorMessage = (error: MemRecordStore.WriteError): { title: string; detail: string } => {
  switch (error.kind) {
    case "no_project":
      return { title: "No project for session", detail: `Session ${error.sessionID} not found` }
    case "empty_decision":
      return { title: "Rejected: empty decision", detail: `Entry subject="${error.subject}" has empty decision` }
    case "supersedes_not_found":
      return {
        title: "Rejected: supersedes target not found",
        detail: `Entry subject="${error.subject}" supersedes unknown record ${error.id} in this project`,
      }
    case "supersedes_not_active":
      return {
        title: "Rejected: supersedes target not active",
        detail:
          `Entry subject="${error.subject}" supersedes ${error.id} with status=${error.status}; ` +
          `only active records can be superseded — supersede the latest active version instead`,
      }
  }
}
