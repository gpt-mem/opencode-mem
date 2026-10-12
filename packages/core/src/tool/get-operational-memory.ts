export * as GetOperationalMemoryTool from "./get-operational-memory"

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

export const name = "get_operational_memory"

export const Input = Schema.Struct({
  id: Schema.String.annotate({
    description: "Memory record id (mem_...), e.g. from search_operational_memory or a put result",
  }),
})

export const Output = Schema.Struct({
  found: Schema.Boolean,
  record: Schema.optional(MemRecord.Record),
  supersedes_chain: Schema.optional(Schema.Array(MemRecord.Record)),
  superseded_by: Schema.optional(Schema.Array(MemRecord.Record)),
  source: Schema.optional(Schema.Struct({ ref: Schema.String, retrieve: Schema.optional(Schema.String) })),
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
            "Fetch one operational memory by id with full provenance: authority (user vs agent), decided_by, " +
            "recorded_by, source_ref, timestamps, and the whole revision chain — records this one supersedes " +
            "and records that supersede it. When source_ref points at a tool call, the response includes the " +
            "exact get_tool_call_details invocation to load the original utterance. Use " +
            "search_operational_memory to find ids first.",
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
              const result = yield* MemRecordStore.getWithChain(db, {
                sessionID: context.sessionID,
                id: input.id,
              })
              if (!result.found) {
                if (result.reason === "no_project") {
                  return { found: false, error: `Session ${context.sessionID} not found` }
                }
                return { found: false, error: `No memory ${input.id} in this project — try search_operational_memory` }
              }
              return {
                found: true,
                record: result.record,
                supersedes_chain: result.supersedes_chain,
                superseded_by: result.superseded_by,
                source: result.source,
              }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure
                  ? error
                  : new ToolFailure({ message: `Unable to load operational memory in session ${context.sessionID}` }),
              ),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/get-operational-memory",
  layer,
  deps: [ToolRegistry.node, PermissionV2.node, Database.node],
})
