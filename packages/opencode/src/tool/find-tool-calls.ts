import { Effect, Schema } from "effect"
import { and, eq, sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { PII } from "@opencode-ai/core/session/pii"
import { PartTable } from "@opencode-ai/core/session/sql"
import { MemoryTools } from "@opencode-ai/core/tool/memory-tools"
import type { SessionID } from "../session/schema"
import * as Tool from "./tool"

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100
const PREVIEW_CHARS = 240
const INPUT_SUMMARY_CHARS = 200
const SNIPPET_CONTEXT = 180

export const Parameters = Schema.Struct({
  tool: Schema.optional(Schema.String.annotate({ description: "Exact tool name to filter by (e.g. bash, read)" })),
  status: Schema.optional(
    Schema.Literals(["pending", "running", "completed", "error"]).annotate({
      description: "Filter by tool call status",
    }),
  ),
  query: Schema.optional(
    Schema.String.annotate({
      description:
        "Regular expression matched against tool input (command/url/path), output text and error message, case-insensitive. " +
        "When it matches the output text, each result includes match_offset and match_snippet so you can answer from the " +
        "snippet or page get_tool_call_details with a small window instead of full=true",
    }),
  ),
  limit: Schema.optional(
    Schema.Number.annotate({
      description: `Maximum results to return, most recent first (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`,
    }),
  ),
  failed: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "When true, only return calls that failed: status=error or a non-zero exit_code (failed Bash with a " +
        "completed status). Default false.",
    }),
  ),
})

type Metadata = { matched: number }

const bound = (text: string, max: number) => (text.length <= max ? text : text.slice(0, max))

// When a query hits the stored tool output, surface a window around the first
// match so the model can answer a needle question (or page get_tool_call_details
// with a small offset window) without re-injecting the full original via
// full=true. match_offset is an index into the same output text that details
// pages over. Input-only matches (command/url) do not set these fields — the
// offset would not line up with the output document.
const matchWindow = (raw: string | undefined, regex: RegExp | undefined) => {
  if (raw === undefined || regex === undefined) return undefined
  const hit = regex.exec(raw)
  if (hit === null) return undefined
  const start = Math.max(0, hit.index - SNIPPET_CONTEXT)
  const end = Math.min(raw.length, hit.index + hit[0].length + SNIPPET_CONTEXT)
  return {
    match_offset: hit.index,
    match_snippet: PII.redact(raw.slice(start, end)).text,
  }
}

const inputSummary = (input: unknown) => {
  if (typeof input === "string") return input === "" ? undefined : bound(PII.redact(input).text, INPUT_SUMMARY_CHARS)
  if (input === null || typeof input !== "object") return undefined
  const entries = Object.entries(input as Record<string, unknown>)
    .map(([key, value]) => {
      if (typeof value === "string") return `${key}=${value}`
      if (typeof value === "number" || typeof value === "boolean") return `${key}=${String(value)}`
      return undefined
    })
    .filter((line): line is string => line !== undefined)
  return entries.length === 0 ? undefined : bound(PII.redact(entries.join(" ")).text, INPUT_SUMMARY_CHARS)
}

export type Candidate = {
  call_id: string
  tool: string
  status: string
  input?: string
  preview?: string
  error?: string
  exit_code?: number
  haystack: string
  raw?: string
  seq: string
}

// The V1 shell tool records its process exit code in part state.metadata.exit;
// only surface a real number so a missing field stays distinct from exit 0.
const metadataExit = (metadata: unknown) => {
  if (typeof metadata !== "object" || metadata === null) return undefined
  const exit = (metadata as { exit?: unknown }).exit
  return typeof exit === "number" ? exit : undefined
}

const candidate = (data: unknown, id: string, includeMemoryTools = false): Candidate | undefined => {
  if (typeof data !== "object" || data === null) return undefined
  const part = data as {
    type?: string
    callID?: string
    tool?: string
    state?: { status?: string; input?: unknown; output?: string; error?: string; metadata?: unknown }
  }
  if (part.type !== "tool" || typeof part.callID !== "string") return undefined
  // Self-indexing guard: memory tools are how this index is queried, so
  // indexing them back would make every search a new match (issue #34).
  // get_tool_call_overview opts in (includeMemoryTools) to still count them,
  // so an inventory never looks like the calls were deleted (issue #48).
  if (!includeMemoryTools && part.tool !== undefined && MemoryTools.names.has(part.tool)) return undefined
  const state = part.state
  const input = inputSummary(state?.input)
  const output = typeof state?.output === "string" ? state.output : undefined
  const error = typeof state?.error === "string" ? state.error : undefined
  const raw = [output, error].filter((piece): piece is string => typeof piece === "string" && piece !== "").join("\n")
  // haystack stays raw (internal, never returned to the model); model-visible
  // fields are redacted.
  const preview = raw === "" ? undefined : bound(PII.redact(raw).text, PREVIEW_CHARS)
  // No stored status is unknown, not pending — pending is an explicit state.
  const status = state?.status ?? "unknown"
  const exitCode = status === "completed" || status === "error" ? metadataExit(state?.metadata) : undefined
  const exitTag = exitCode === undefined ? undefined : `exit_code=${exitCode}`
  return {
    call_id: part.callID,
    tool: part.tool ?? "unknown",
    status,
    ...(input === undefined ? {} : { input }),
    ...(preview === undefined ? {} : { preview }),
    ...(error === undefined ? {} : { error: bound(PII.redact(error).text, PREVIEW_CHARS) }),
    ...(exitCode === undefined ? {} : { exit_code: exitCode }),
    haystack: [input, raw, exitTag].filter((piece): piece is string => piece !== undefined && piece !== "").join("\n"),
    ...(raw === "" ? {} : { raw }),
    seq: id,
  }
}

export const collectCandidates = (
  db: Database.Interface["db"],
  sessionID: SessionID,
  options?: { readonly includeMemoryTools?: boolean },
) =>
  Effect.gen(function* () {
    const rows = yield* db
      .select({ id: PartTable.id, data: PartTable.data })
      .from(PartTable)
      .where(and(eq(PartTable.session_id, sessionID), sql`json_extract(${PartTable.data}, '$.type') = 'tool'`))
      .orderBy(PartTable.time_created)
      .all()
      .pipe(Effect.orDie)
    return rows.flatMap((row) => {
      const item = candidate(row.data, row.id, options?.includeMemoryTools ?? false)
      return item === undefined ? [] : [item]
    })
  })

export const FindToolCallsTool = Tool.define<typeof Parameters, Metadata, Database.Service>(
  "find_tool_calls",
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = database.db

    return {
      description:
        "Search tool calls in this session by tool name, status or pattern. " +
        "Returns compact entries (call_id, status, exit_code, input, preview) so you can locate a call and then load " +
        "its full output with get_tool_call_details(call_id). failed=true returns only error-status calls and " +
        "non-zero-exit Bash. A query that matches tool output also returns match_snippet and " +
        "match_offset — prefer that over full=true when hunting a needle. Compacted [mem:compacted] results are searchable here because " +
        "the originals live in session history. Memory-tool calls are never returned here " +
        "(a query would match its own earlier searches, issue #34); they are counted in " +
        "get_tool_call_overview and load by call_id (issue #48).",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "find_tool_calls",
            patterns: ["*"],
            always: ["*"],
            metadata: {},
          })
          const regex = params.query === undefined ? undefined : new RegExp(params.query, "i")
          const limit = Math.max(1, Math.min(params.limit ?? DEFAULT_LIMIT, MAX_LIMIT))
          const matched = (yield* collectCandidates(db, ctx.sessionID)).filter((item) => {
            if (params.tool !== undefined && item.tool !== params.tool) return false
            if (params.status !== undefined && item.status !== params.status) return false
            if (
              params.failed === true &&
              item.status !== "error" &&
              (item.exit_code === undefined || item.exit_code === 0)
            )
              return false
            if (regex !== undefined && !regex.test(item.haystack)) return false
            return true
          })
          const calls = matched
            .slice(-limit)
            .reverse()
            .map(({ haystack: _haystack, seq: _seq, raw, ...item }) => {
              const window = matchWindow(raw, regex)
              return { ...item, ...(window === undefined ? {} : window) }
            })
          return {
            title: `${matched.length} matching tool calls`,
            output: JSON.stringify({ calls, matched: matched.length }, null, 2),
            metadata: { matched: matched.length },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
