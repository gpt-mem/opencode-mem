export * as OperationalMemoryTool from "./operational-memory.js"

import { ToolFailure } from "@opencode/ai"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Tool } from "@opencode/schema/tool"
import { Effect, Schema } from "effect"
import { Database } from "../../database/database.js"
import { Permission } from "../../permission.js"
import { MemRecord } from "../../session/mem-record.js"
import { MemRecordStore } from "../../session/mem-record-store.js"

export const putName = "put_in_operational_memory"
export const searchName = "search_operational_memory"
export const getName = "get_operational_memory"

const MAX_ENTRIES = 10
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100

const toContent = (output: unknown) => JSON.stringify(output, null, 2)

const PutInput = Schema.Struct({
  entries: Schema.Array(MemRecord.Entry)
    .check(Schema.isMinLength(1))
    .annotate({
      description: `Memory entries to persist (max ${MAX_ENTRIES}). Each needs type, subject and decision/content.`,
    }),
})

const PutOutput = Schema.Struct({
  written: Schema.Number,
  records: Schema.optional(Schema.Array(MemRecord.Record)),
  error: Schema.optional(Schema.String),
})

const SearchInput = Schema.Struct({
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

const SearchOutput = Schema.Struct({
  records: Schema.Array(MemRecord.Record),
  matched: Schema.Number,
  filter_matched: Schema.optional(Schema.Number),
  hint: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
})

const GetInput = Schema.Struct({
  id: Schema.String.annotate({
    description: "Memory record id (mem_...), e.g. from search_operational_memory or a put result",
  }),
})

const GetOutput = Schema.Struct({
  found: Schema.Boolean,
  record: Schema.optional(MemRecord.Record),
  supersedes_chain: Schema.optional(Schema.Array(MemRecord.Record)),
  superseded_by: Schema.optional(Schema.Array(MemRecord.Record)),
  source: Schema.optional(Schema.Struct({ ref: Schema.String, retrieve: Schema.optional(Schema.String) })),
  error: Schema.optional(Schema.String),
})

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

export const Plugin = {
  id: "opencode.tool.operational-memory",
  effect: Effect.fn("OperationalMemoryTool.Plugin")(function* (ctx: Context) {
    const db = (yield* Database.Service).db
    const permission = yield* Permission.Service

    const assert = (name: string, context: Tool.Context) =>
      permission.assert({
        action: name,
        resources: ["*"],
        save: ["*"],
        sessionID: context.sessionID,
        agent: context.agent,
        source: { type: "tool", messageID: context.messageID, id: context.id },
      })

    yield* ctx.tool
      .transform((editor) => {
        editor.add({
          name: putName,
          options: { codemode: false },
          description:
            "Persist typed operational memories (decisions, constraints, failed approaches, user signals) " +
            "so they survive across turns and sessions in this project. Content is PII-redacted before storage; " +
            "the original stays in session history. Agent proposals are recorded with authority=agent — only " +
            "set decided_by when a user (or named person) actually made the decision, never self-assert user " +
            "approval. To replace an earlier record pass its id in supersedes — the old record is marked " +
            "superseded and the new one carries version = old.version + 1. Retrieve with " +
            "search_operational_memory or get_operational_memory.",
          input: PutInput,
          output: PutOutput,
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* assert(putName, context)
              const result = yield* MemRecordStore.writeBatch(db, {
                sessionID: context.sessionID,
                agent: context.agent,
                entries: input.entries.slice(0, MAX_ENTRIES),
              })
              const output = result.ok
                ? { written: result.records.length, records: result.records }
                : { written: 0, error: writeErrorMessage(result.error) }
              return { output, content: toContent(output) }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure
                  ? error
                  : new ToolFailure({ message: `Unable to write operational memory in session ${context.sessionID}` }),
              ),
            ),
        })
        editor.add({
          name: searchName,
          options: { codemode: false },
          description:
            "Search typed operational memories (decisions, constraints, failed approaches, user signals) " +
            "stored for this project via put_in_operational_memory. Project-scoped: finds records from earlier " +
            "sessions too. Each hit includes authority (user vs agent), decided_by, reason and source_ref so " +
            "provenance is visible. Use this to recover 'what did we decide and why' without re-reading history. " +
            "To list every record of a kind pass type= alone; query is a text regex and usually misses the type label.",
          input: SearchInput,
          output: SearchOutput,
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* assert(searchName, context)
              const result = yield* MemRecordStore.search(db, {
                sessionID: context.sessionID,
                query: input.query,
                type: input.type,
                status: input.status,
                scope: input.scope,
                limit: input.limit,
              })
              const output =
                result === undefined
                  ? { records: [], matched: 0, error: `Session ${context.sessionID} not found` }
                  : {
                      records: result.records,
                      matched: result.matched,
                      filter_matched: result.filter_matched,
                      hint: result.hint,
                    }
              return { output, content: toContent(output) }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure
                  ? error
                  : new ToolFailure({ message: `Unable to search operational memory in session ${context.sessionID}` }),
              ),
            ),
        })
        editor.add({
          name: getName,
          options: { codemode: false },
          description:
            "Fetch one operational memory by id with full provenance: authority (user vs agent), decided_by, " +
            "recorded_by, source_ref, timestamps, and the whole revision chain — records this one supersedes " +
            "and records that supersede it. When source_ref points at a tool call, the response includes the " +
            "exact get_tool_call_details invocation to load the original utterance. Use " +
            "search_operational_memory to find ids first.",
          input: GetInput,
          output: GetOutput,
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* assert(getName, context)
              const result = yield* MemRecordStore.getWithChain(db, {
                sessionID: context.sessionID,
                id: input.id,
              })
              const output = result.found
                ? {
                    found: true,
                    record: result.record,
                    supersedes_chain: result.supersedes_chain,
                    superseded_by: result.superseded_by,
                    source: result.source,
                  }
                : result.reason === "no_project"
                  ? { found: false, error: `Session ${context.sessionID} not found` }
                  : { found: false, error: `No memory ${input.id} in this project — try search_operational_memory` }
              return { output, content: toContent(output) }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure
                  ? error
                  : new ToolFailure({ message: `Unable to load operational memory in session ${context.sessionID}` }),
              ),
            ),
        })
      })
      .pipe(Effect.orDie)
  }),
}

