export * as SessionMemoryContext from "./memory-context.js"

import { SessionMessage } from "./message.js"
import { Evidence } from "./evidence.js"
import { PII } from "./pii.js"
import { MAX_BYTES } from "../tool-output.js"

export type Kind = "bash" | "url" | "artifact" | "generic"

export type Options = {
  /** Compact eligible tool results instead of sending them in full. */
  readonly enabled?: boolean
  /** Minimum serialized output size that earns a compact marker. */
  readonly minOutputChars?: number
  /** Tools whose bulk output is cheap to re-retrieve on demand. */
  readonly tools?: ReadonlySet<string>
  /** Session the history belongs to, named in the marker. */
  readonly sessionID?: string
}

/** Tools whose bulk output dominates a tool-heavy session. */
export const DEFAULT_TOOLS = ["shell", "read", "webfetch", "websearch"]

// The v1 line read these flags; on this line they do not exist, so the port
// uses names of its own.
const FLAG_ENABLED = "OPENCODE_V2_MEMORY_CONTEXT"
const FLAG_MIN_CHARS = "OPENCODE_V2_MEMORY_MIN_CHARS"
const FLAG_TOOLS = "OPENCODE_V2_MEMORY_TOOLS"

const PREVIEW_HEAD = 400
const PREVIEW_TAIL = 200
const SUMMARY_LIMIT = 200

// Memory tools answer with their own compact payloads; compacting them would
// only cost the model a second round trip.
const MEMORY_TOOL_PATTERN = /(operational_memory|get_tool_call_|find_tool_calls|find_pii|find_agent_artifact)/

const enabled = () => process.env[FLAG_ENABLED] === "1" || process.env[FLAG_ENABLED] === "true"

const minOutputChars = () => {
  const value = Number(process.env[FLAG_MIN_CHARS])
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : MAX_BYTES
}

const tools = () => {
  const raw = process.env[FLAG_TOOLS]
  if (raw === undefined || raw.trim() === "") return new Set(DEFAULT_TOOLS)
  return new Set(
    raw
      .split(",")
      .map((tool) => tool.trim())
      .filter((tool) => tool !== ""),
  )
}

const serializeContent = (content: readonly { readonly type: string; readonly text?: string }[]) =>
  content
    .map((item) =>
      item.type === "text"
        ? (item.text ?? "")
        : `[${"mime" in item && typeof item.mime === "string" ? item.mime : "file"}${
            "name" in item && typeof item.name === "string" && item.name !== "" ? `: ${item.name}` : ""
          }]`,
    )
    .join("\n")

const inputString = (input: Record<string, unknown>, key: string) => {
  const value = input[key]
  return typeof value === "string" ? value : undefined
}

const detectKind = (name: string, input: Record<string, unknown>, text: string): Kind => {
  if (name === "shell" || name === "bash") return "bash"
  if (name === "webfetch" || name === "websearch") return "url"
  const path = inputString(input, "path") ?? inputString(input, "filePath")
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
    const path = inputString(input, "path") ?? inputString(input, "filePath")
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

// State what retrieval actually returns: the stored text may be only a preview
// whose full output lives in the managed tool-output store.
const evidenceLines = (text: string, sessionID: string | undefined, messageID: string) => {
  const ref = Evidence.classify(text)
  if (ref.kind === "managed_output_file" && ref.path !== undefined)
    return [
      `stored=managed_output_file path=${ref.path}`,
      "the stored text is a preview; the full output lives in the managed tool-output store and is retrieved by the call id below",
    ]
  return [
    `original=session ${sessionID ?? "?"} message ${messageID}`,
    "full text kept in the session history",
  ]
}

const toolMarker = (input: {
  readonly kind: Kind
  readonly name: string
  readonly callID: string
  readonly messageID: string
  readonly sessionID?: string
  readonly text: string
  readonly summary?: string
  readonly pii?: string
}) =>
  [
    "[mem:compacted tool result]",
    `kind=${input.kind} tool=${input.name} call_id=${input.callID} status=success`,
    input.summary,
    input.pii,
    `preview=${preview(Evidence.body(input.text))}`,
    ...evidenceLines(input.text, input.sessionID, input.messageID),
    `retrieve=get_tool_call_details(call_id="${input.callID}")`,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n")

/**
 * Replace the bulk output of an eligible tool result with a compact marker.
 *
 * The projection only touches the model-visible view of the history: the
 * session history keeps the original output, and the marker names the call id
 * that retrieves it (get_tool_call_details). Because the marker is a pure
 * function of the stored output, the projected history is append-only — the
 * provider's cached prefix never changes under it.
 */
export const project = (
  messages: readonly SessionMessage.Info[],
  options: Options = {},
): readonly SessionMessage.Info[] => {
  if (!(options.enabled ?? enabled())) return messages
  const minChars = options.minOutputChars ?? minOutputChars()
  const allowed = options.tools ?? tools()
  return messages.map((message): SessionMessage.Info => {
    if (message.type !== "assistant") return message
    let changed = false
    const content = message.content.map((item) => {
      if (item.type !== "tool") return item
      if (item.state.status !== "completed") return item
      if (item.executed === true) return item
      if (MEMORY_TOOL_PATTERN.test(item.name)) return item
      if (!allowed.has(item.name)) return item
      // Without a call id the original cannot be retrieved later.
      if (item.id === "") return item
      const text = serializeContent(item.state.content)
      if (text.length < minChars) return item
      const kind = detectKind(item.name, item.state.input, text)
      const summary = kindSummary(kind, item.state.input)
      const pii = PII.tag(text)
      changed = true
      return {
        ...item,
        state: {
          ...item.state,
          content: [
            {
              type: "text",
              text: toolMarker({
                kind,
                name: item.name,
                callID: item.id,
                messageID: message.id,
                ...(options.sessionID === undefined ? {} : { sessionID: options.sessionID }),
                text,
                ...(summary === undefined ? {} : { summary }),
                ...(pii === undefined ? {} : { pii }),
              }),
            },
          ] as const,
        },
      }
    })
    return changed ? { ...message, content } : message
  })
}
