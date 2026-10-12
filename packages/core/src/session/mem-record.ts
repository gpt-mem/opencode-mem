export * as MemRecord from "./mem-record"

import { Schema } from "effect"
import { PII } from "./pii"

export const Type = Schema.Literals(["decision", "constraint", "failed_approach", "user_signal"])
export type Type = Schema.Schema.Type<typeof Type>

export const Status = Schema.Literals(["active", "superseded", "rejected"])
export type Status = Schema.Schema.Type<typeof Status>

export const Authority = Schema.Literals(["user", "agent"])
export type Authority = Schema.Schema.Type<typeof Authority>

export const Entry = Schema.Struct({
  type: Type.annotate({ description: "Kind of memory record (decision, constraint, failed_approach, user_signal)" }),
  subject: Schema.String.annotate({
    description: "Short topic this record is about, e.g. 'cache-mark ledger', 'fork OpenCode'",
  }),
  decision: Schema.optional(
    Schema.String.annotate({ description: "The decision/content itself. Required for type=decision." }),
  ),
  reason: Schema.optional(Schema.String.annotate({ description: "Why this decision was made" })),
  decided_by: Schema.optional(
    Schema.String.annotate({
      description:
        "Who made the decision (e.g. 'user', 'team', a person). Leave unset for agent proposals — " +
        "an agent proposal must not be recorded as user-approved.",
    }),
  ),
  source_ref: Schema.optional(
    Schema.String.annotate({
      description:
        "Pointer to the authoritative source (tool call_id, message id, file path). " +
        "Recommended so the original can be retrieved later.",
    }),
  ),
  scope: Schema.optional(
    Schema.String.annotate({ description: "Optional task/project tag, e.g. 'issue-13', 'release-v3'" }),
  ),
  supersedes: Schema.optional(
    Schema.String.annotate({
      description:
        "ID of the active record this entry replaces. The old record is marked superseded; " +
        "this one gets version = old.version + 1. The target must be active in this project.",
    }),
  ),
})

export type Entry = Schema.Schema.Type<typeof Entry>

export const Record = Schema.Struct({
  id: Schema.String,
  type: Type,
  subject: Schema.String,
  content: Schema.String,
  reason: Schema.optional(Schema.String),
  status: Status,
  authority: Authority,
  decided_by: Schema.optional(Schema.String),
  recorded_by: Schema.String,
  source_ref: Schema.optional(Schema.String),
  scope: Schema.optional(Schema.String),
  supersedes: Schema.optional(Schema.String),
  version: Schema.Number,
  time_created: Schema.Number,
  time_updated: Schema.Number,
})

export type Record = Schema.Schema.Type<typeof Record>

const MAX_CONTENT = 4000
const MAX_REASON = 2000
const MAX_SUBJECT = 200

const bound = (text: string, max: number) => (text.length <= max ? text : text.slice(0, max))

// Credential-bearing content is stripped before persistence; emails/phones stay
// (tag-only, same policy as compact markers). The original utterance remains in
// session history and is reachable via source_ref.
export const redactContent = (text: string) => PII.redact(bound(text, MAX_CONTENT)).text
export const redactReason = (text: string) => PII.redact(bound(text, MAX_REASON)).text
export const normalizeSubject = (text: string) => bound(text.trim(), MAX_SUBJECT)

// Agent proposals default to authority=agent; only an explicit user decision
// (decided_by set and not the recording agent) is elevated to authority=user.
export const resolveAuthority = (input: { readonly decided_by?: string; readonly recorded_by: string }): Authority => {
  if (input.decided_by === undefined || input.decided_by === "") return "agent"
  if (input.decided_by === input.recorded_by) return "agent"
  return "user"
}
