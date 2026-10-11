export * as GetToolCallDetailsTool from "./get-tool-call-details"

import { and, asc, eq } from "drizzle-orm"
import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { FSUtil } from "../fs-util"
import { makeLocationNode } from "../effect/app-node"
import { SessionMessage } from "../session/message"
import { Evidence } from "../session/evidence"
import { SessionMessageTable } from "../session/sql"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "get_tool_call_details"

const DEFAULT_MAX_CHARS = 8000
const HARD_MAX_CHARS = 200_000

export const Input = Schema.Struct({
  call_id: Schema.String.annotate({ description: "Call ID of the tool call to retrieve (from a compacted marker)" }),
  max_chars: Schema.optional(
    Schema.Number.annotate({ description: `Maximum characters of output text (default ${DEFAULT_MAX_CHARS})` }),
  ),
  offset: Schema.optional(
    Schema.Number.annotate({ description: "Character offset into the original output to start from (default 0)" }),
  ),
  full: Schema.optional(
    Schema.Boolean.annotate({
      description: `Return the complete output up to ${HARD_MAX_CHARS} chars (ignores max_chars); page the rest with offset`,
    }),
  ),
})

export const Output = Schema.Struct({
  found: Schema.Boolean,
  call_id: Schema.String,
  tool: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  command: Schema.optional(Schema.String),
  output: Schema.optional(Schema.String),
  truncated: Schema.optional(Schema.Boolean),
  total_chars: Schema.optional(Schema.Number),
  offset: Schema.optional(Schema.Number),
  message_id: Schema.optional(Schema.String),
  source: Schema.optional(Schema.String),
  managed_path: Schema.optional(Schema.String),
  note: Schema.optional(Schema.String),
})
export type Output = typeof Output.Type

export const toModelOutput = (output: Output) => JSON.stringify(output, null, 2)

const decodeMessage = Schema.decodeUnknownEffect(SessionMessage.Message)

// truncated means "more content remains after this window" so the model can
// page a large original with offset instead of hitting a silent dead end.
const window = (text: string, offset: number, max: number) => {
  const slice = text.slice(offset, offset + max)
  return { text: slice, truncated: offset + slice.length < text.length }
}

// When the stored text is only a truncation notice, the full output lives in the
// managed tool-output file; read it there and window the real content. A missing
// file degrades to the bounded_stored_output branch, never to a tool failure.
const retrieve = (
  fs: FSUtil.Interface,
  text: string,
  callID: string,
  tool: string,
  status: string,
  command: string | undefined,
  offset: number,
  maxChars: number,
  messageID: string,
): Effect.Effect<Output> =>
  Effect.gen(function* () {
    const ref = Evidence.classify(text)
    if (ref.kind !== "managed_output_file" || ref.path === undefined) {
      const output = window(text, offset, maxChars)
      return {
        found: true,
        call_id: callID,
        tool,
        status,
        ...(command !== undefined ? { command } : {}),
        output: output.text,
        truncated: output.truncated,
        total_chars: text.length,
        ...(offset > 0 ? { offset } : {}),
        message_id: messageID,
        source: ref.kind,
      }
    }
    const content = yield* fs
      .existsSafe(ref.path)
      .pipe(
        Effect.flatMap((exists) => (exists ? fs.readFileStringSafe(ref.path) : Effect.succeed(undefined))),
        Effect.catch(() => Effect.succeed(undefined)),
      )
    if (content !== undefined) {
      const output = window(content, offset, maxChars)
      return {
        found: true,
        call_id: callID,
        tool,
        status,
        ...(command !== undefined ? { command } : {}),
        output: output.text,
        truncated: output.truncated,
        total_chars: content.length,
        ...(offset > 0 ? { offset } : {}),
        message_id: messageID,
        source: "managed_output_file",
        managed_path: ref.path,
      }
    }
    const output = window(text, offset, maxChars)
    return {
      found: true,
      call_id: callID,
      tool,
      status,
      ...(command !== undefined ? { command } : {}),
      output: output.text,
      truncated: output.truncated,
      total_chars: text.length,
      ...(offset > 0 ? { offset } : {}),
      message_id: messageID,
      source: "bounded_stored_output",
      managed_path: ref.path,
      note: "The managed tool-output file is no longer available (retention cleanup); only the stored preview remains.",
    }
  })

const extract = (
  fs: FSUtil.Interface,
  message: SessionMessage.Message,
  callID: string,
  maxChars: number,
  offset: number,
): Effect.Effect<Output | undefined> => {
  if (message.type === "shell" && message.callID === callID) {
    return retrieve(fs, message.output, callID, "bash", "completed", message.command, offset, maxChars, message.id)
  }
  if (message.type !== "assistant") return Effect.succeed(undefined)
  const item = message.content.find(
    (content): content is SessionMessage.AssistantTool => content.type === "tool" && content.id === callID,
  )
  if (!item) return Effect.succeed(undefined)
  if (item.state.status === "pending" || item.state.status === "running")
    return Effect.succeed({
      found: true,
      call_id: callID,
      tool: item.name,
      status: item.state.status,
      message_id: message.id,
    })
  const text =
    item.state.status === "error"
      ? `${item.state.error.message}\n\n${item.state.content
          .map((part) => (part.type === "text" ? part.text : `[${part.mime}]`))
          .join("\n")}`
      : item.state.content
          .map((part) => (part.type === "text" ? part.text : `[${part.mime}${part.name === undefined ? "" : `: ${part.name}]`}]))
          .join("\n")
  return retrieve(fs, text, callID, item.name, item.state.status, undefined, offset, maxChars, message.id)
}

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    const db = (yield* Database.Service).db
    const fs = yield* FSUtil.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Retrieve the full original output of a previous tool call in this session by its call_id. " +
            "Use this when a tool result was compacted to a [mem:compacted tool result] marker. " +
            "When truncated is true more content remains: call again with offset (and max_chars or full) to page through the rest. " +
            "`source` says what the returned output actually is: `managed_output_file` means the full output lives in a managed tool-output file; `bounded_stored_output` means only the stored preview remains.",
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
              const maxChars = input.full === true ? HARD_MAX_CHARS : input.max_chars ?? DEFAULT_MAX_CHARS
              const offset = Math.max(0, Math.floor(input.offset ?? 0))
              const rows = yield* db
                .select()
                .from(SessionMessageTable)
                .where(
                  and(
                    eq(SessionMessageTable.session_id, context.sessionID),
                    eq(SessionMessageTable.type, "assistant"),
                  ),
                )
                .orderBy(asc(SessionMessageTable.seq))
                .all()
                .pipe(Effect.orDie)
              for (const row of rows) {
                const message = yield* decodeMessage({ ...row.data, id: row.id, type: row.type }).pipe(
                  Effect.catch(() => Effect.succeed(undefined)),
                )
                if (!message) continue
                const found = yield* extract(fs, message, input.call_id, maxChars, offset)
                if (found) return found
              }
              const shells = yield* db
                .select()
                .from(SessionMessageTable)
                .where(and(eq(SessionMessageTable.session_id, context.sessionID), eq(SessionMessageTable.type, "shell")))
                .orderBy(asc(SessionMessageTable.seq))
                .all()
                .pipe(Effect.orDie)
              for (const row of shells) {
                const message = yield* decodeMessage({ ...row.data, id: row.id, type: row.type }).pipe(
                  Effect.catch(() => Effect.succeed(undefined)),
                )
                if (!message) continue
                const found = yield* extract(fs, message, input.call_id, maxChars, offset)
                if (found) return found
              }
              return { found: false, call_id: input.call_id, source: "unavailable" }
            }).pipe(
              Effect.mapError(() => new ToolFailure({ message: `Unable to retrieve tool call ${input.call_id}` })),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/get-tool-call-details",
  layer,
  deps: [ToolRegistry.node, PermissionV2.node, Database.node, FSUtil.node],
})
