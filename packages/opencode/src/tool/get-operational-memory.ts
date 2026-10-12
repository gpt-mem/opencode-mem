import { Effect, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { MemRecordStore } from "@opencode-ai/core/session/mem-record-store"
import * as Tool from "./tool"

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
          const result = yield* MemRecordStore.getWithChain(db, { sessionID: ctx.sessionID, id: params.id })
          if (!result.found) {
            if (result.reason === "no_project") {
              return {
                title: "No project for session",
                output: JSON.stringify({ found: false, error: `Session ${ctx.sessionID} not found` }, null, 2),
                metadata: { found: false },
              }
            }
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
          return {
            title: `Memory ${result.record.id} v${result.record.version}`,
            output: JSON.stringify(
              {
                found: true,
                record: result.record,
                supersedes_chain: result.supersedes_chain,
                superseded_by: result.superseded_by,
                source: result.source,
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
