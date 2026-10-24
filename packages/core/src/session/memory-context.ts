import fs from "fs/promises"
import path from "path"
import { SessionMessage } from "./message.js"
import { Evidence } from "./evidence.js"
import { PII } from "./pii.js"
import { MAX_BYTES } from "../tool-output.js"
import { Global } from "@opencode/util/global"


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
  /** Confirmed cache prefix length for this provider. */
  readonly providerMark?: number
}

/** Tools whose bulk output dominates a tool-heavy session. */
export const DEFAULT_TOOLS = ["shell", "read", "webfetch", "websearch"]

// The v1 line read these flags; on this line they do not exist, so the port
// uses names of its own.
const FLAG_ENABLED = "OPENCODE_V2_MEMORY_CONTEXT"
const FLAG_MIN_CHARS = "OPENCODE_V2_MEMORY_MIN_CHARS"
const FLAG_TOOLS = "OPENCODE_V2_MEMORY_TOOLS"
const FLAG_DEBUG = "OPENCODE_V2_MEMORY_CONTEXT_DEBUG"

const PREVIEW_HEAD = 400
const PREVIEW_TAIL = 200
const SUMMARY_LIMIT = 200

// Memory tools answer with their own compact payloads; compacting them would
// only cost the model a second round trip.
const MEMORY_TOOL_PATTERN = /(operational_memory|get_tool_call_|find_tool_calls|find_pii|find_agent_artifact)/

const enabled = () => process.env[FLAG_ENABLED] === "1" || process.env[FLAG_ENABLED] === "true"

// Debug lines belong to the server log, never to stdout: the server's stdout
// is inherited by the terminal client, so a console.log here would leak
// "[mem-context] ..." into the user's view.
const debug = (line: string) => {
  if (process.env[FLAG_DEBUG] !== "1") return
  fs.appendFile(path.join(Global.Path.log, "memory-context.log"), line + "\n").catch(() => {})
}

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

const serializeContent = (content: SessionMessage.ToolStateCompleted["content"]) =>
  content
    .map((item) =>
      item.type === "text"
        ? item.text
        : `[${item.mime}${item.name === undefined ? "" : `: ${item.name}`}]`,
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
    const filePath = inputString(input, "path") ?? inputString(input, "filePath")
    if (filePath !== undefined) return `file=${filePath.slice(0, SUMMARY_LIMIT)}`
  }
  return undefined
}

const toolMarker = (
  input: {
    readonly kind: Kind
    readonly name: string
    readonly callID: string
    readonly messageID: string
    readonly sessionID?: string
    readonly text: string
    readonly summary?: string
    readonly pii?: string
  },
): string => {
  const lines: (string | undefined)[] = [
    "[mem:compacted tool result]",
    `kind=${input.kind} tool=${input.name} call_id=${input.callID} status=success`,
    input.summary,
    input.pii,
    `preview=${preview(Evidence.body(input.text))}`,
    ...evidenceLines(input.text, input.sessionID, input.messageID),
    `retrieve=get_tool_call_details(call_id="${input.callID}")`,
  ]
  return lines.filter((line): line is string => line !== undefined).join("\n")
}

const preview = (text: string): string => {
  const lines = text.split("\n")
  if (lines.length <= 3) return text
  const head = lines.slice(0, PREVIEW_HEAD).join("\n")
  const tail = lines.slice(-PREVIEW_TAIL).join("\n")
  return `${head}\n...\n${tail}`
}

const evidenceLines = (text: string, sessionID?: string, messageID?: string): string[] => {
  const evidence = Evidence.parse(Evidence.body(text))
  return evidence.map((e) => {
    const parts: string[] = [`${e.kind}`, `text=${e.text.slice(0, 60)}`]
    if (e.path) parts.push(`path=${e.path}`)
    if (e.line) parts.push(`line=${e.line}`)
    if (e.section) parts.push(`section=${e.section}`)
    if (e.code) parts.push(`code=${e.code}`)
    if (sessionID && messageID) parts.push(`session=${sessionID} message=${messageID}`)
    return `[${parts.join(" ")}]: ${e.text}`
  })
}

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
  options: Options & { providerMark?: number } = {},
): readonly SessionMessage.Info[] => {
  if (!(options.enabled ?? enabled())) return messages
  const minChars = options.minOutputChars ?? minOutputChars()
  const allowed = options.tools ?? tools()
  let count = 0
  // providerMark is a MESSAGE INDEX, not a byte count: messages[0..mark) were
  // sent verbatim and are cached by the provider, so they stay raw; the suffix
  // from mark onward is eligible for marker compression. This is the invariant
  // that keeps the provider's cached prefix append-only (ARCHITECTURE §13).
  const mark = options.providerMark ?? 0

  const projected = messages.map((message, index): SessionMessage.Info => {
    if (message.type !== "assistant") return message
    // Messages before the mark are part of the verbatim cached prefix — never
    // compact them, or the provider's prefix mutates and the next request
    // resends them verbatim (issue #29: cost fdmark ≈ off).
    if (mark > 0 && index < mark) return message
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
      count++
      // Non-text parts (an image, a PDF) carry information the marker cannot
      // stand in for, so they stay in the model view next to the marker.
      const files = item.state.content.filter((part) => part.type !== "text")
      const compacted: SessionMessage.ToolStateCompleted["content"] = [
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
        ...files,
      ]
      return {
        ...item,
        state: {
          ...item.state,
          content: compacted,
        },
      }
    })
    return changed ? { ...message, content } : message
  })

  debug(
    `[mem-context] session=${options.sessionID ?? "?"} compacted=${count} min_chars=${minChars} tools=${[...allowed].join(",")} mark=${mark}`,
  )
  return projected
}

export const SessionMemoryContext = {
  project,
}