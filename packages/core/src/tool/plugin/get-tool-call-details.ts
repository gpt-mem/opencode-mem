export * as GetToolCallDetailsTool from "./get-tool-call-details.js"

import path from "path"
import { and, asc, eq } from "drizzle-orm"
import { ToolFailure } from "@opencode/ai"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { Tool } from "@opencode/schema/tool"
import { Effect, Schema } from "effect"
import { Database } from "../../database/database.js"
import { Permission } from "../../permission.js"
import { SessionHistory } from "../../session/history.js"
import { SessionMessageTable, SessionTable } from "../../session/sql.js"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"

export const name = "get_tool_call_details"

const DEFAULT_MAX_CHARS = 4_000
const HARD_MAX_CHARS = 20_000

// The truncation marker is the only pointer from a bounded preview back to the
// managed copy of the original output. Its path is trusted only inside the
// OpenCode data directory; anything else is treated as ordinary text.
const MANAGED_OUTPUT = /full output saved to (.+?)(?:\s+—\s|\]$)/m

const Input = Schema.Struct({
  call_id: Schema.String.annotate({
    description: "Tool call id (call_...) exactly as it appears in the session history",
  }),
  offset: Schema.optional(
    Schema.Number.annotate({
      description: "Character offset into the original output to start from (default 0)",
    }),
  ),
  limit: Schema.optional(
    Schema.Number.annotate({
      description: `Maximum characters of the original output to return (default ${DEFAULT_MAX_CHARS}, max ${HARD_MAX_CHARS})`,
    }),
  ),
})

// The response of this tool is bounded by the same output limit as any other tool
// result, so the scalars come first and the retrieved text comes last: the model
// reads the page size and the source without spending a second call on them.
const Output = Schema.Struct({
  found: Schema.Boolean,
  call_id: Schema.String,
  tool: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  total_chars: Schema.optional(Schema.Number),
  truncated: Schema.optional(Schema.Boolean),
  offset: Schema.optional(Schema.Number),
  next_offset: Schema.optional(Schema.Number),
  source: Schema.optional(Schema.String),
  managed_path: Schema.optional(Schema.String),
  note: Schema.optional(Schema.String),
  output: Schema.optional(Schema.String),
})

const toContent = (output: unknown) => JSON.stringify(output, null, 2)

const textOf = (content: readonly { readonly type: string; readonly text?: string }[]) =>
  content
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n")

// truncated means "more content remains after this window", so the model pages
// with next_offset instead of hitting a silent dead end. An offset past the end
// returns an empty window and says so explicitly.
const window = (text: string, offset: number, max: number) => {
  const slice = text.slice(offset, offset + max)
  const truncated = offset + slice.length < text.length
  return {
    output: slice,
    truncated,
    total_chars: text.length,
    offset,
    next_offset: truncated ? offset + slice.length : undefined,
    note:
      offset > 0 && offset >= text.length
        ? `offset ${offset} is past the end of the output (total_chars=${text.length}); window is empty`
        : undefined,
  }
}

export const Plugin = {
  id: "opencode.tool.get-tool-call-details",
  effect: Effect.fn("GetToolCallDetailsTool.Plugin")(function* (ctx: Context) {
    const db = (yield* Database.Service).db
    const permission = yield* Permission.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service

    const assert = (context: Tool.Context) =>
      permission.assert({
        action: name,
        resources: ["*"],
        save: ["*"],
        sessionID: context.sessionID,
        agent: context.agent,
        source: { type: "tool", messageID: context.messageID, id: context.id },
      })

    // Managed output files live under the OpenCode data directory. A marker inside
    // arbitrary tool output could otherwise point anywhere on disk.
    const managed = (candidate: string) => {
      const resolved = path.resolve(candidate)
      const root = path.resolve(global.data)
      return resolved === root || resolved.startsWith(root + path.sep) ? resolved : undefined
    }

    yield* ctx.tool
      .transform((editor) => {
        editor.add({
          name,
          options: { codemode: false },
          description:
            "Retrieve the original output of a tool call by its call id (call_...). Use it when a previous tool " +
            "result was truncated and the full output is needed — the truncation marker names the call id. The " +
            "result is the original text, not the bounded preview, so nothing is hidden by compression. Page a " +
            "large output with offset and limit: the response reports total_chars and next_offset while content " +
            "remains. The call id appears in the session history next to the tool call.",
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* assert(context)
              const offset = Math.max(0, Math.floor(input.offset ?? 0))
              const limit = Math.min(HARD_MAX_CHARS, Math.max(1, Math.floor(input.limit ?? DEFAULT_MAX_CHARS)))
              const notFound = (note: string) => ({
                output: { found: false, call_id: input.call_id, note },
                content: toContent({ found: false, call_id: input.call_id, note }),
              })
              const session = yield* db
                .select({ project_id: SessionTable.project_id })
                .from(SessionTable)
                .where(eq(SessionTable.id, context.sessionID))
                .get()
                .pipe(Effect.orDie)
              if (!session) return notFound(`Session ${context.sessionID} not found`)
              // The call id is provider-generated and unique, so the lookup spans the
              // project: a memory recorded in an earlier session stays retrievable.
              const rows = yield* db
                .select({
                  id: SessionMessageTable.id,
                  session_id: SessionMessageTable.session_id,
                  type: SessionMessageTable.type,
                  seq: SessionMessageTable.seq,
                  time_created: SessionMessageTable.time_created,
                  time_updated: SessionMessageTable.time_updated,
                  data: SessionMessageTable.data,
                })
                .from(SessionMessageTable)
                .innerJoin(SessionTable, eq(SessionMessageTable.session_id, SessionTable.id))
                .where(
                  and(eq(SessionTable.project_id, session.project_id), eq(SessionMessageTable.type, "assistant")),
                )
                .orderBy(asc(SessionMessageTable.seq))
                .all()
                .pipe(Effect.orDie)
              for (const row of rows) {
                const message = yield* SessionHistory.decodeMessageRow(row).pipe(
                  Effect.orElseSucceed(() => undefined),
                )
                if (!message || message.type !== "assistant") continue
                const part = message.content.find((item) => item.type === "tool" && item.id === input.call_id)
                if (!part || part.type !== "tool") continue
                const stored =
                  part.state.status === "completed"
                    ? textOf(part.state.content)
                    : part.state.status === "error"
                      ? textOf(part.state.content ?? [])
                      : ""
                const pointer = MANAGED_OUTPUT.exec(stored)?.[1]
                const managedPath = pointer ? managed(pointer) : undefined
                const original =
                  managedPath === undefined
                    ? undefined
                    : yield* fs.readFileStringSafe(managedPath).pipe(Effect.orElseSucceed(() => undefined))
                const text = original ?? stored
                const page = window(text, offset, limit)
                const output = {
                  found: true,
                  call_id: input.call_id,
                  tool: part.name,
                  status: part.state.status,
                  total_chars: page.total_chars,
                  truncated: page.truncated,
                  offset: page.offset,
                  next_offset: page.next_offset,
                  source: original === undefined ? "stored_output" : "managed_output_file",
                  ...(managedPath !== undefined ? { managed_path: managedPath } : {}),
                  note: page.note,
                  output: page.output,
                }
                return { output, content: toContent(output) }
              }
              return notFound(
                `No tool call ${input.call_id} in this project — call ids appear in the session history next to the tool call`,
              )
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure
                  ? error
                  : new ToolFailure({ message: `Unable to retrieve tool call ${input.call_id}` }),
              ),
            ),
        })
      })
      .pipe(Effect.orDie)
  }),
}
