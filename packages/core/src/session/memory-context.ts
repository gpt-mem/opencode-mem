export * as MemoryContext from "./memory-context"

import { Flag } from "../flag/flag"
import { PII } from "./pii"
import { MemDebugLog } from "./mem-debug-log"
import { SessionMessage } from "./message"
import { SessionV1 } from "../v1/session"

export type Kind = "bash" | "url" | "artifact" | "generic"

export type Options = {
  readonly sessionID?: string
  readonly enabled?: boolean
  readonly minOutputChars?: number
  readonly keepRecentUserTurns?: number
  readonly keepRecentAssistantTurns?: number
  readonly batchSize?: number
  readonly midTurn?: boolean
  // Issue #23: compact at first delivery — no protected window, every eligible
  // result becomes a retrieval marker the moment it exists. Requires enabled
  // memory context; boundary options (keepRecent*/batchSize/midTurn) do not
  // apply in this mode.
  readonly firstDelivery?: boolean
  readonly firstDeliveryMinChars?: number
  readonly firstDeliveryTools?: string
  // Issue #25 B3 (cache-breaking, opt-in): ID of the user message that opened
  // the currently active intent via a confirmed switch. When set, that message
  // and everything after it stays verbatim while every eligible tool output
  // before it is compacted — the old intent's segment is finalized in one
  // append-only jump instead of sliding one user turn at a time. Falls back to
  // the normal boundary when the message is not in the list.
  readonly intentSwitchMessageID?: string
  // Issue #29: provider cache-mark ledger floor. Messages below this index
  // were confirmed cached by the provider (usage.cache_read post-factum), so
  // they stay byte-identical even when the boundary/first-delivery rules
  // would otherwise compact them — mutating them would invalidate the
  // provider's prefix cache. 0 (default) = no ledger constraint.
  readonly markIndex?: number
}

const DEFAULT_MIN_OUTPUT_CHARS = 2000
const DEFAULT_KEEP_RECENT_USER_TURNS = 2
const DEFAULT_KEEP_RECENT_ASSISTANT_TURNS = 2
const DEFAULT_BATCH_SIZE = 2
const DEFAULT_FIRST_DELIVERY_TOOLS = ["bash", "webfetch", "websearch", "read"]
const PREVIEW_HEAD = 400
const PREVIEW_TAIL = 200
const SUMMARY_LIMIT = 200

const MEMORY_TOOL_PATTERN = /(operational_memory|get_tool_call_|find_tool_calls|find_agent_artifact)/

const serializeContent = (content: SessionMessage.ToolStateCompleted["content"]) =>
  content
    .map((item) =>
      item.type === "text" ? item.text : `[${item.mime}${item.name === undefined ? "" : `: ${item.name}`}]`,
    )
    .join("\n")

const inputString = (input: Record<string, unknown>, key: string) => {
  const value = input[key]
  return typeof value === "string" ? value : undefined
}

const detectKind = (name: string, input: Record<string, unknown>, text: string): Kind => {
  if (name === "bash") return "bash"
  if (name === "webfetch" || name === "websearch") return "url"
  const path = inputString(input, "path") ?? inputString(input, "file_path") ?? inputString(input, "filePath")
  if (path !== undefined && /\.(md|json|xml|html|ya?ml|csv)$/.test(path)) return "artifact"
  if (/^https?:\/\/\S+$/.test(text.trim())) return "url"
  return "generic"
}

const kindSummary = (kind: Kind, input: Record<string, unknown>) => {
  if (kind === "bash") {
    const command = inputString(input, "command")
    if (command !== undefined) return `command=${PII.redact(command).text.slice(0, SUMMARY_LIMIT)}`
  }
  if (kind === "url") {
    const url = inputString(input, "url")
    if (url !== undefined) return `url=${PII.redact(url).text.slice(0, SUMMARY_LIMIT)}`
  }
  if (kind === "artifact") {
    const path = inputString(input, "path") ?? inputString(input, "file_path") ?? inputString(input, "filePath")
    if (path !== undefined) return `path=${path.slice(0, SUMMARY_LIMIT)}`
  }
  return undefined
}

const preview = (text: string) => {
  const clean = PII.redact(text).text
  return clean.length <= PREVIEW_HEAD + PREVIEW_TAIL + 16
    ? clean
    : `${clean.slice(0, PREVIEW_HEAD)}\n...\n${clean.slice(-PREVIEW_TAIL)}`
}

type MarkerArgs = {
  readonly kind: Kind
  readonly name: string
  readonly callID: string
  readonly messageID: string
  readonly sessionID?: string
  readonly text: string
  readonly summary?: string
  readonly outputPaths?: readonly string[]
  readonly pii?: string
}

const toolMarker = (args: MarkerArgs) =>
  [
    "[mem:compacted tool result]",
    `kind=${args.kind} tool=${args.name} call_id=${args.callID} status=success`,
    args.summary,
    args.pii,
    `preview=${preview(args.text)}`,
    args.outputPaths && args.outputPaths.length > 0
      ? `output_paths=${args.outputPaths.slice(0, 5).join(",")}`
      : undefined,
    `original=session ${args.sessionID ?? "?"} message ${args.messageID} (full text kept in SQLite history)`,
    `retrieve=get_tool_call_details(call_id="${args.callID}")`,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n")

type ShellArgs = {
  readonly command: string
  readonly callID: string
  readonly messageID: string
  readonly sessionID?: string
  readonly text: string
  readonly pii?: string
}

const shellMarker = (args: ShellArgs) =>
  [
    "[mem:compacted shell output]",
    `command=${PII.redact(args.command).text.slice(0, SUMMARY_LIMIT)}`,
    `call_id=${args.callID} status=success`,
    args.pii,
    `preview=${preview(args.text)}`,
    `original=session ${args.sessionID ?? "?"} message ${args.messageID} (full output kept in SQLite history)`,
    `retrieve=get_tool_call_details(call_id="${args.callID}")`,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n")

// Issue #29 P1: with the ledger enabled, first-delivery compaction is the
// policy — the mark floors the confirmed prefix and the fresh tail is
// compacted on arrival (B0 = ledger-политика). Bare CACHE_MARK in boundary
// mode degenerates to no-compaction on caching providers because the mark
// grows to cover the whole verbatim prefix, including the protected window
// (live e2e on ladder/free). FIRST_DELIVERY alone still selects the mode on
// ledger-less setups (zero-cache providers, FD-only acceptance runs).
const firstDeliveryPolicy = (options: Options) =>
  options.firstDelivery ?? (Flag.OPENCODE_MEMORY_FIRST_DELIVERY || Flag.OPENCODE_MEMORY_CACHE_MARK)

export const project = (
  messages: readonly SessionMessage.Message[],
  options: Options = {},
): readonly SessionMessage.Message[] => {
  const enabled = options.enabled ?? Flag.OPENCODE_MEMORY_CONTEXT
  if (!enabled) return messages
  const firstDelivery = firstDeliveryPolicy(options)
  const minChars = firstDelivery
    ? resolveFirstDeliveryMinChars(options)
    : (options.minOutputChars ?? DEFAULT_MIN_OUTPUT_CHARS)
  const allow = firstDelivery ? resolveFirstDeliveryTools(options) : undefined

  const userIndices: number[] = []
  const assistantIndices: number[] = []
  messages.forEach((message, index) => {
    if (message.type === "user") userIndices.push(index)
    if (message.type === "assistant") assistantIndices.push(index)
  })
  if (!firstDelivery && userIndices.length === 0) return messages
  // First-delivery mode (issue #23) has no protected window: eligibility is a
  // pure per-message function, so the projected prefix is append-only and the
  // provider prefix cache sees zero invalidations.
  // Intent cut (issue #25 B3, cache-breaking): when a confirmed switch opened
  // the active intent, finalize the closed intent's segment in one jump — the
  // switch message and everything after it stay verbatim, everything eligible
  // before it is compacted. max() keeps the cut subsumed by the sliding window
  // once later user turns move the boundary past the switch point, so the
  // projected prefix stays monotone.
  const boundary = firstDelivery ? Number.POSITIVE_INFINITY : boundaryFor(userIndices, assistantIndices, options)
  const cutIndex =
    firstDelivery || options.intentSwitchMessageID === undefined
      ? -1
      : messages.findIndex((message) => message.id === options.intentSwitchMessageID)
  const protectedFrom = cutIndex > boundary ? cutIndex : boundary
  if (protectedFrom <= 0) return messages
  const markFloor = Math.max(0, options.markIndex ?? 0)

  let compacted = 0
  const projected = messages.map((message, index) => {
    if (index >= protectedFrom) return message
    // Ledger floor (issue #29): below the confirmed cache mark the bytes must
    // stay identical or the provider's prefix cache dies.
    if (index < markFloor) return message
    if (message.type === "shell") {
      // Without a callID the original cannot be retrieved later, so keep the output intact.
      if (message.output.length < minChars || message.callID === "") return message
      if (allow !== undefined && !allow.has("bash")) return message
      compacted++
      const pii = PII.tag(message.output)
      return {
        ...message,
        // The runner renders "Shell command: <command>" next to the output, so
        // the command field itself must be redacted or secrets in curl headers
        // would bypass the compact marker. The original stays in SQLite.
        command: PII.redact(message.command).text,
        output: shellMarker({
          command: message.command,
          callID: message.callID,
          messageID: message.id,
          ...(options.sessionID === undefined ? {} : { sessionID: options.sessionID }),
          text: message.output,
          ...(pii === undefined ? {} : { pii }),
        }),
      }
    }
    if (message.type !== "assistant") return message
    let changed = false
    const content = message.content.map((item) => {
      if (item.type !== "tool") return item
      if (item.state.status !== "completed") return item
      if (item.provider?.executed === true) return item
      if (MEMORY_TOOL_PATTERN.test(item.name)) return item
      if (allow !== undefined && !allow.has(item.name)) return item
      const text = serializeContent(item.state.content)
      if (text.length < minChars) return item
      const kind = detectKind(item.name, item.state.input, text)
      const pii = PII.tag(text)
      changed = true
      compacted++
      return {
        ...item,
        state: {
          ...item.state,
          content: [
            {
              type: "text" as const,
              text: toolMarker({
                kind,
                name: item.name,
                callID: item.id,
                messageID: message.id,
                ...(options.sessionID === undefined ? {} : { sessionID: options.sessionID }),
                text,
                ...(kindSummary(kind, item.state.input) === undefined
                  ? {}
                  : { summary: kindSummary(kind, item.state.input)! }),
                ...(item.state.outputPaths === undefined ? {} : { outputPaths: item.state.outputPaths }),
                ...(pii === undefined ? {} : { pii }),
              }),
            },
          ],
        },
      }
    })
    return changed ? { ...message, content } : message
  })

  if (compacted > 0 && Flag.OPENCODE_MEMORY_CONTEXT_DEBUG)
    MemDebugLog.write(
      "memory-context.log",
      `[mem-context] session=${options.sessionID ?? "?"} compacted=${compacted} first_delivery=${firstDelivery} protected_from=${protectedFrom} intent_cut=${cutIndex >= 0} mark=${markFloor}`,
    )
  return projected
}

// V1 (SessionPrompt) projection: the production run/TUI path converts
// SessionV1.WithParts[] via toModelMessagesEffect and never touches the V2
// runner, so the flag has to hook here as well or compression is dead code.
export const projectV1 = (
  messages: readonly SessionV1.WithParts[],
  options: Options = {},
): readonly SessionV1.WithParts[] => {
  const enabled = options.enabled ?? Flag.OPENCODE_MEMORY_CONTEXT
  if (!enabled) return messages
  const firstDelivery = firstDeliveryPolicy(options)
  const minChars = firstDelivery
    ? resolveFirstDeliveryMinChars(options)
    : (options.minOutputChars ?? DEFAULT_MIN_OUTPUT_CHARS)
  const allow = firstDelivery ? resolveFirstDeliveryTools(options) : undefined

  const userIndices: number[] = []
  const assistantIndices: number[] = []
  messages.forEach((message, index) => {
    if (message.info.role === "user") userIndices.push(index)
    if (message.info.role === "assistant") assistantIndices.push(index)
  })
  if (!firstDelivery && userIndices.length === 0) return messages
  // Same boundary rules as project(), including the intent cut (issue #25 B3):
  // the switch message that opened the active intent protects itself and
  // everything after it, while the closed intent's segment is compacted.
  const boundary = firstDelivery ? Number.POSITIVE_INFINITY : boundaryFor(userIndices, assistantIndices, options)
  const cutIndex =
    firstDelivery || options.intentSwitchMessageID === undefined
      ? -1
      : messages.findIndex((message) => message.info.id === options.intentSwitchMessageID)
  const protectedFrom = cutIndex > boundary ? cutIndex : boundary
  if (protectedFrom <= 0) return messages
  const markFloor = Math.max(0, options.markIndex ?? 0)

  let compacted = 0
  const projected = messages.map((message, index) => {
    if (index >= protectedFrom) return message
    // Ledger floor (issue #29): same cache-mark protection as project().
    if (index < markFloor) return message
    if (message.info.role !== "assistant") return message
    let changed = false
    const parts = message.parts.map((part) => {
      if (part.type !== "tool") return part
      if (part.state.status !== "completed") return part
      if (part.state.time.compacted !== undefined) return part
      if (part.metadata?.providerExecuted === true) return part
      if (MEMORY_TOOL_PATTERN.test(part.tool)) return part
      if (allow !== undefined && !allow.has(part.tool)) return part
      const text = part.state.output
      if (text.length < minChars) return part
      const kind = detectKind(part.tool, part.state.input, text)
      const pii = PII.tag(text)
      changed = true
      compacted++
      return {
        ...part,
        state: {
          ...part.state,
          output: toolMarker({
            kind,
            name: part.tool,
            callID: part.callID,
            messageID: message.info.id,
            ...(options.sessionID === undefined ? {} : { sessionID: options.sessionID }),
            text,
            ...(kindSummary(kind, part.state.input) === undefined
              ? {}
              : { summary: kindSummary(kind, part.state.input)! }),
            ...(pii === undefined ? {} : { pii }),
          }),
        },
      }
    })
    return changed ? { ...message, parts } : message
  })

  if (compacted > 0 && Flag.OPENCODE_MEMORY_CONTEXT_DEBUG)
    MemDebugLog.write(
      "memory-context.log",
      `[mem-context] session=${options.sessionID ?? "?"} compacted=${compacted} first_delivery=${firstDelivery} protected_from=${protectedFrom} intent_cut=${cutIndex >= 0} mark=${markFloor}`,
    )
  return projected
}

// Boundary-mode resolution: first index that must stay verbatim, or 0 when
// nothing can be safely compressed. Two windows qualify:
// - the conversation window: from the Nth-from-last user turn on (needs more
//   than N user turns, otherwise there is no such window at all);
// - the working set: the last N assistant messages, so a single long agent
//   turn (one user prompt, many tool results) can still be compressed — older
//   tool outputs are exactly what the compact markers exist for. This window
//   slides one message per provider step, so it is only used when mid-turn
//   compression is enabled (issue #20); by default the boundary stays at
//   user-turn boundaries and the projected prefix is cache-stable within a turn.
// The earlier (more protective) start wins; when neither window exists there
// is nothing that can be safely compressed.
const protectedStartIndex = (
  userIndices: readonly number[],
  assistantIndices: readonly number[],
  options: Options,
): number | undefined => {
  const keepUserTurns = options.keepRecentUserTurns ?? DEFAULT_KEEP_RECENT_USER_TURNS
  const keepAssistantTurns = options.keepRecentAssistantTurns ?? DEFAULT_KEEP_RECENT_ASSISTANT_TURNS
  const conversationWindow =
    userIndices.length > keepUserTurns ? userIndices[userIndices.length - keepUserTurns] : undefined
  const workingSet =
    resolveMidTurn(options) && assistantIndices.length > keepAssistantTurns
      ? assistantIndices[assistantIndices.length - keepAssistantTurns]
      : undefined
  if (conversationWindow === undefined) return workingSet
  if (workingSet === undefined) return conversationWindow
  return Math.min(conversationWindow, workingSet)
}

const boundaryFor = (
  userIndices: readonly number[],
  assistantIndices: readonly number[],
  options: Options,
): number => {
  const rawProtected = protectedStartIndex(userIndices, assistantIndices, options)
  if (rawProtected === undefined) return 0
  return stableBoundary(rawProtected, resolveBatch(options))
}

// First-delivery threshold (issue #23): separate knob from the historical
// boundary threshold so A/B measurement can tune aggressiveness without
// changing boundary-mode behavior.
const resolveFirstDeliveryMinChars = (options: Options) => {
  const value = Number(options.firstDeliveryMinChars ?? Flag.OPENCODE_MEMORY_FIRST_DELIVERY_MIN_CHARS)
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : DEFAULT_MIN_OUTPUT_CHARS
}

// First-delivery allowlist (issue #23): only tools whose bulk output is cheap
// to re-retrieve on demand. Env override is comma-separated tool names.
const resolveFirstDeliveryTools = (options: Options): ReadonlySet<string> => {
  const raw = options.firstDeliveryTools ?? Flag.OPENCODE_MEMORY_FIRST_DELIVERY_TOOLS
  if (raw === undefined || raw.trim() === "") return new Set(DEFAULT_FIRST_DELIVERY_TOOLS)
  const parsed = raw
    .split(",")
    .map((tool) => tool.trim())
    .filter((tool) => tool !== "")
  return new Set(parsed)
}

// Mid-turn compaction is a prefix edit: the first changed byte invalidates the
// provider's cached prefix from that point on, so every boundary move re-sends
// the still-full tail uncached. Measured on mimo-v2.6-flash (issue #20): the
// sliding working-set boundary cost +70% real dollars despite -45% tokens,
// because cached tokens are ~45x cheaper than uncached ones and mid-turn edits
// convert cached tail into uncached re-sends every step. Two knobs:
// - midTurn (default off): enable the sliding working-set window at all —
//   off means the boundary only moves at user-turn boundaries (cache-stable
//   prefix within a turn, one invalidation per new user message);
// - batchSize: when mid-turn is on, move the boundary in batches so the
//   projected prefix is byte-identical between jumps and the invalidation is
//   paid once per batch instead of once per step (bounded lag of batch-1
//   late messages). Monotone for append-only history: a compacted message
//   never goes back to full text, so the marker set only grows.
const stableBoundary = (raw: number, batch: number) => (batch <= 1 ? raw : Math.floor(raw / batch) * batch)

// Batch size is overridable via OPENCODE_MEMORY_BATCH_SIZE for A/B measurement
// of the token/cost trade-off (issue #20); 1 reproduces the sliding boundary.
const resolveBatch = (options: Options) => {
  const value = options.batchSize ?? Number(Flag.OPENCODE_MEMORY_BATCH_SIZE)
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : DEFAULT_BATCH_SIZE
}

// Mid-turn compression is opt-in: on cache-priced providers it trades cheap
// cached tokens for expensive uncached re-sends (issue #20). Enable it via
// OPENCODE_MEMORY_MIDTURN for providers without prompt caching or when
// shrinking the provider-visible prompt matters more than dollars.
const resolveMidTurn = (options: Options) => options.midTurn ?? Flag.OPENCODE_MEMORY_MIDTURN
