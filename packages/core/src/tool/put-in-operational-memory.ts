export * as PutInOperationalMemoryTool from "./put-in-operational-memory"

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

export const name = "put_in_operational_memory"

const MAX_ENTRIES = 10

export const Input = Schema.Struct({
  entries: Schema.Array(MemRecord.Entry)
    .check(Schema.isMinLength(1))
    .annotate({
      description: `Memory entries to persist (max ${MAX_ENTRIES}). Each needs type, subject and decision/content.`,
    }),
})

export const Output = Schema.Struct({
  written: Schema.Number,
  records: Schema.optional(Schema.Array(MemRecord.Record)),
  error: Schema.optional(Schema.String),
})
export type Output = typeof Output.Type

export const toModelOutput = (output: Output) => JSON.stringify(output, null, 2)

const writeErrorMessage = (error: MemRecordStore.WriteError): string => {
  switch (error.kind) {
    case "no_project":
      return `Session ${error.sessionID} not found`
    case "empty_decision":
      return `Entry subject="${error.subject}" has empty decision`
    case "supersedes_not_found":
      return `Entry subject="${error.subject}" supersedes unknown record ${error.id} in this project`
    case "supersedes_not_active":
      return (
        `Entry subject="${error.subject}" supersedes ${error.id} with status=${error.status}; ` +
        `only active records can be superseded — supersede the latest active version instead`
      )
  }
}

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    const db = (yield* Database.Service).db

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Persist typed operational memories (decisions, constraints, failed approaches, user signals) " +
            "so they survive across turns and sessions in this project. Content is PII-redacted before storage; " +
            "the original stays in session history. Agent proposals are recorded with authority=agent — only " +
            "set decided_by when a user (or named person) actually made the decision, never self-assert user " +
            "approval. To replace an earlier record pass its id in supersedes — the old record is marked " +
            "superseded and the new one carries version = old.version + 1. Retrieve with " +
            "search_operational_memory or get_operational_memory.",
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
              const entries = input.entries.slice(0, MAX_ENTRIES)
              const result = yield* MemRecordStore.writeBatch(db, {
                sessionID: context.sessionID,
                agent: context.agent,
                entries,
              })
              if (result.ok) return { written: result.records.length, records: result.records }
              return { written: 0, error: writeErrorMessage(result.error) }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure
                  ? error
                  : new ToolFailure({ message: `Unable to write operational memory in session ${context.sessionID}` }),
              ),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/put-in-operational-memory",
  layer,
  deps: [ToolRegistry.node, PermissionV2.node, Database.node],
})
