import { readFile } from "fs/promises"
import { Effect, Schema } from "effect"
import { and, eq, sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { PartTable } from "@opencode-ai/core/session/sql"
import { Evidence } from "@opencode-ai/core/session/evidence"
import * as Tool from "./tool"

const DEFAULT_MAX_CHARS = 8000
const HARD_MAX_CHARS = 200_000

export const Parameters = Schema.Struct({
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

type Metadata = { found: boolean }

// truncated means "more content remains after this window" so the model can
// page a large original with offset instead of hitting a silent dead end.
const window = (text: string, offset: number, max: number) => {
  const slice = text.slice(offset, offset + max)
  return { text: slice, truncated: offset + slice.length < text.length }
}

// When the stored text is only a truncation notice, the full output lives in the
// managed tool-output file; read it there and window the real content. A missing
// file degrades to the bounded_stored_output branch, never to a tool failure.
type RetrieveOutput = {
  found: true
  call_id: string
  tool: string | undefined
  status: string
  command?: string
  output: string
  truncated: boolean
  total_chars: number
  offset?: number
  source: string
  managed_path?: string
  note?: string
}

const retrieve = (
  text: string,
  callID: string,
  tool: string | undefined,
  status: string,
  command: string | undefined,
  offset: number,
  maxChars: number,
): Effect.Effect<RetrieveOutput> =>
  Effect.gen(function* () {
    const ref = Evidence.classify(text)
    if (ref.kind !== "managed_output_file" || ref.path === undefined) {
      const output = window(text, offset, maxChars)
      return {
        found: true as const,
        call_id: callID,
        tool,
        status,
        ...(command === undefined ? {} : { command }),
        output: output.text,
        truncated: output.truncated,
        total_chars: text.length,
        ...(offset > 0 ? { offset } : {}),
        source: ref.kind,
      }
    }
    const managedPath = ref.path
    const content = yield* Effect.tryPromise({
      try: () => readFile(managedPath, "utf8"),
      catch: (error) => error,
    }).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (content !== undefined) {
      const output = window(content, offset, maxChars)
      return {
        found: true as const,
        call_id: callID,
        tool,
        status,
        ...(command === undefined ? {} : { command }),
        output: output.text,
        truncated: output.truncated,
        total_chars: content.length,
        ...(offset > 0 ? { offset } : {}),
        source: "managed_output_file",
        managed_path: managedPath,
      }
    }
    const output = window(text, offset, maxChars)
    return {
      found: true as const,
      call_id: callID,
      tool,
      status,
      ...(command === undefined ? {} : { command }),
      output: output.text,
      truncated: output.truncated,
      total_chars: text.length,
      ...(offset > 0 ? { offset } : {}),
      source: "bounded_stored_output",
      managed_path: managedPath,
      note: "The managed tool-output file is no longer available (retention cleanup); only the stored preview remains.",
    }
  })

const extract = (
  data: unknown,
  callID: string,
  maxChars: number,
  offset: number,
): Effect.Effect<RetrieveOutput | undefined> => {
  if (typeof data !== "object" || data === null) return Effect.succeed(undefined)
  const part = data as {
    type?: string
    callID?: string
    tool?: string
    state?: { status?: string; output?: string; error?: string; input?: Record<string, unknown> }
  }
  if (part.type !== "tool" || part.callID !== callID) return Effect.succeed(undefined)
  const state = part.state
  const command = typeof state?.input?.command === "string" ? state.input.command : undefined
  if (state?.status === "error") {
    const text = [state.error, state.output].filter((piece): piece is string => typeof piece === "string").join("\n")
    return retrieve(text, callID, part.tool, "error", command, offset, maxChars)
  }
  const text = typeof state?.output === "string" ? state.output : ""
  return retrieve(text, callID, part.tool, state?.status ?? "completed", command, offset, maxChars)
}

export const GetToolCallDetailsTool = Tool.define<typeof Parameters, Metadata, Database.Service>(
  "get_tool_call_details",
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = database.db

    return {
      description:
        "Retrieve the full original output of a previous tool call in this session by its call_id. " +
        "Use this when a tool result was compacted to a [mem:compacted tool result] marker. " +
        "When truncated is true more content remains: call again with offset (and max_chars or full) to page through the rest. " +
        "`source` says what the returned output actually is: `managed_output_file` means the full output lives in a managed tool-output file; `bounded_stored_output` means only the stored preview remains.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "get_tool_call_details",
            patterns: ["*"],
            always: ["*"],
            metadata: {},
          })
          const maxChars = params.full === true ? HARD_MAX_CHARS : params.max_chars ?? DEFAULT_MAX_CHARS
          const offset = Math.max(0, Math.floor(params.offset ?? 0))
          const rows = yield* db
            .select({ data: PartTable.data })
            .from(PartTable)
            .where(
              and(
                eq(PartTable.session_id, ctx.sessionID),
                sql`json_extract(${PartTable.data}, '$.type') = 'tool'`,
                sql`json_extract(${PartTable.data}, '$.callID') = ${params.call_id}`,
              ),
            )
            .limit(1)
            .all()
            .pipe(Effect.orDie)
          const row = rows[0]
          const found = row === undefined ? undefined : yield* extract(row.data, params.call_id, maxChars, offset)
          const output = found ?? { found: false as const, call_id: params.call_id, source: "unavailable" }
          return {
            title: output.found ? `found ${output.tool ?? "tool"}` : "not found",
            output: JSON.stringify(output, null, 2),
            metadata: { found: output.found },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
