export * as SearchOperationalMemoryTool from "./search-operational-memory"

import { Effect, Layer, Schema } from "effect"
import { ToolFailure } from "@opencode-ai/llm"
import { Database } from "../database/database"
import { makeLocationNode } from "../effect/app-node"
import { PermissionV2 } from "../permission"
import { MemRecord } from "../session/mem-record"
import { MemRecordStore } from "../session/mem-record-store"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "search_operational_memory"

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100

export const Input = Schema.Struct({
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

export const Output = Schema.Struct({
  records: Schema.Array(MemRecord.Record),
  matched: Schema.Number,
  filter_matched: Schema.optional(Schema.Number),
  hint: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
})
export type Output = typeof Output.Type

export const toModelOutput = (output: Output) => JSON.stringify(output, null, 2)

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    const db = (yield* Database.Service).db

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Search typed operational memories (decisions, constraints, failed approaches, user signals) " +
            "stored for this project via put_in_operational_memory. Project-scoped: finds records from earlier " +
            "sessions too. Each hit includes authority (user vs agent), decided_by, reason and source_ref so " +
            "provenance is visible. Use this to recover 'what did we decide and why' without re-reading history. " +
            "To list every record of a kind pass type= alone; query is a text regex and usually misses the type label.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: toModelOutput(output) }],
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* permission.assert({
                action: name,
                resources: ["*"],
                save: ["*"],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })
              const result = yield* MemRecordStore.search(db, {
                sessionID: context.sessionID,
                query: input.query,
                type: input.type,
                status: input.status,
                scope: input.scope,
                limit: input.limit,
              })
              if (result === undefined) {
                return { records: [], matched: 0, error: `Session ${context.sessionID} not found` }
              }
              return {
                records: result.records,
                matched: result.matched,
                filter_matched: result.filter_matched,
                hint: result.hint,
              }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure
                  ? error
                  : new ToolFailure({ message: `Unable to search operational memory in session ${context.sessionID}` }),
              ),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/search-operational-memory",
  layer,
  deps: [ToolRegistry.node, PermissionV2.node, Database.node],
})
