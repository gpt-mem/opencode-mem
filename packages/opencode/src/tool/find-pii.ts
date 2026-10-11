import { Effect, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { PII } from "@opencode-ai/core/session/pii"
import { collectCandidates } from "./find-tool-calls"
import * as Tool from "./tool"

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100
const EVIDENCE_LINES = 2

export const Parameters = Schema.Struct({
  type: Schema.optional(
    Schema.Literals(["email", "phone", "credit_card", "api_key"]).annotate({
      description: "Only report carriers of this PII type (e.g. email, api_key)",
    }),
  ),
  limit: Schema.optional(
    Schema.Number.annotate({
      description: `Maximum matching tool calls returned, most recent first (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`,
    }),
  ),
})

type Metadata = { matched: number }

const tally = (counts: Readonly<Record<string, number>>) =>
  Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([type, count]) => ({ type, count }))

export const FindPiiTool = Tool.define<typeof Parameters, Metadata, Database.Service>(
  "find_pii",
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = database.db

    return {
      description:
        "Audit where PII shows up in this session's tool calls: which call inputs, outputs and errors carry " +
        "emails, phone numbers, credit cards or API keys, including carriers already masked as " +
        "[REDACTED:*]. Detection is not permission to see the value — every hit returns the call_id and the " +
        "surrounding line with the value replaced by a placeholder, so load the raw carrier yourself with " +
        "get_tool_call_details(call_id) when you actually need it. Session-scoped; memory-tool calls are never " +
        "candidates (issue #34) and nothing here is written back to any index.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "find_pii",
            patterns: ["*"],
            always: ["*"],
            metadata: {},
          })
          const limit = Math.max(1, Math.min(params.limit ?? DEFAULT_LIMIT, MAX_LIMIT))
          const candidates = yield* collectCandidates(db, ctx.sessionID)
          const carriers = candidates.flatMap((candidate) => {
            const scan = PII.scan(candidate.haystack, { evidence: EVIDENCE_LINES })
            if (scan.types.length === 0) return []
            if (params.type !== undefined && scan.counts[params.type] === 0) return []
            return [
              {
                call_id: candidate.call_id,
                tool: candidate.tool,
                status: candidate.status,
                seq: candidate.seq,
                types: [...scan.types],
                counts: tally(scan.counts),
                evidence: [...scan.evidence],
              },
            ]
          })
          const totals: Record<string, number> = {}
          for (const carrier of carriers)
            for (const entry of carrier.counts) totals[entry.type] = (totals[entry.type] ?? 0) + entry.count
          const matches = carriers.slice(-limit).reverse()
          return {
            title: `${carriers.length} tool calls with ${params.type ?? "any"} PII`,
            output: JSON.stringify({ matches, matched: carriers.length, counts: tally(totals) }, null, 2),
            metadata: { matched: carriers.length },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
