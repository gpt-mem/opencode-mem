import { Effect, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { MemRecord } from "@opencode-ai/core/session/mem-record"
import { MemRecordStore } from "@opencode-ai/core/session/mem-record-store"
import * as Tool from "./tool"

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100

export const Parameters = Schema.Struct({
  query: Schema.optional(
    Schema.String.annotate({
      description:
        "Case-insensitive regular expression matched against subject, content and reason. " +
        "It matches record TEXT, not the type label — to list every record of a kind use type= without query",
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
        "provenance is visible. Use this to recover 'what did we decide and why' without re-reading history. " +
        "To list every record of a kind pass type= alone; query is a text regex and usually misses the type label.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "search_operational_memory",
            patterns: ["*"],
            always: ["*"],
            metadata: {},
          })
          const result = yield* MemRecordStore.search(db, {
            sessionID: ctx.sessionID,
            query: params.query,
            type: params.type,
            status: params.status,
            scope: params.scope,
            limit: params.limit,
          })
          if (result === undefined) {
            return {
              title: "No project for session",
              output: JSON.stringify({ matches: [], matched: 0, error: `Session ${ctx.sessionID} not found` }, null, 2),
              metadata: { matched: 0 },
            }
          }
          return {
            title:
              result.hint === undefined
                ? `${result.matched} matching memories`
                : `${result.matched} matching memories (${result.filter_matched} match the filters)`,
            output: JSON.stringify(
              {
                records: result.records,
                matched: result.matched,
                filter_matched: result.filter_matched,
                hint: result.hint,
              },
              null,
              2,
            ),
            metadata: { matched: result.matched },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
