export * as FindPiiTool from "./find-pii"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { makeLocationNode } from "../effect/app-node"
import { PermissionV2 } from "../permission"
import { PII } from "../session/pii"
import { collectCandidates } from "./find-tool-calls"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "find_pii"

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100
const EVIDENCE_LINES = 2

export const Type = Schema.Literals(["email", "phone", "credit_card", "api_key"])

export const Input = Schema.Struct({
  type: Schema.optional(Type.annotate({ description: "Only report carriers of this PII type (e.g. email, api_key)" })),
  limit: Schema.optional(
    Schema.Number.annotate({
      description: `Maximum matching tool calls returned, most recent first (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`,
    }),
  ),
})

export const Match = Schema.Struct({
  call_id: Schema.String,
  tool: Schema.String,
  status: Schema.String,
  message_id: Schema.String,
  seq: Schema.Number,
  types: Schema.Array(Schema.String),
  counts: Schema.Array(Schema.Struct({ type: Schema.String, count: Schema.Number })),
  evidence: Schema.Array(Schema.String),
})

export const Output = Schema.Struct({
  matches: Schema.Array(Match),
  matched: Schema.Number,
  counts: Schema.Array(Schema.Struct({ type: Schema.String, count: Schema.Number })),
})
export type Output = typeof Output.Type

export const toModelOutput = (output: Output) => JSON.stringify(output, null, 2)

const tally = (counts: Readonly<Record<string, number>>) =>
  Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([type, count]) => ({ type, count }))

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    const db = (yield* Database.Service).db

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Audit where PII shows up in this session's tool calls: which call inputs, outputs and errors carry " +
            "emails, phone numbers, credit cards or API keys, including carriers already masked as " +
            "[REDACTED:*]. Detection is not permission to see the value — every hit returns the call_id and the " +
            "surrounding line with the value replaced by a placeholder, so load the raw carrier yourself with " +
            "get_tool_call_details(call_id) when you actually need it. Session-scoped; memory-tool calls are never " +
            "candidates (issue #34) and nothing here is written back to any index.",
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
              const limit = Math.max(1, Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT))
              const carriers = yield* collectCandidates(db, context.sessionID).pipe(
                Effect.map((candidates) =>
                  candidates.flatMap((candidate) => {
                    const scan = PII.scan(candidate.haystack, { evidence: EVIDENCE_LINES })
                    if (scan.types.length === 0) return []
                    if (input.type !== undefined && scan.counts[input.type] === 0) return []
                    return [
                      {
                        call_id: candidate.call_id,
                        tool: candidate.tool,
                        status: candidate.status,
                        message_id: candidate.message_id,
                        seq: candidate.seq,
                        types: [...scan.types],
                        counts: tally(scan.counts),
                        evidence: [...scan.evidence],
                      },
                    ]
                  }),
                ),
              )
              const totals: Record<string, number> = {}
              for (const carrier of carriers)
                for (const entry of carrier.counts) totals[entry.type] = (totals[entry.type] ?? 0) + entry.count
              const matches = carriers.slice(-limit).reverse()
              return { matches, matched: carriers.length, counts: tally(totals) }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure
                  ? error
                  : new ToolFailure({ message: `Unable to audit PII in session ${context.sessionID}` }),
              ),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/find-pii",
  layer,
  deps: [ToolRegistry.node, PermissionV2.node, Database.node],
})
