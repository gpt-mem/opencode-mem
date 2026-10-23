import fs from "fs/promises"
import path from "path"
import { SessionMessage } from "./message.js"
import { PII } from "./pii.js"
import { Global } from "@opencode/util/global"

export type Kind = "bash" | "url" | "artifact" | "generic"

export type UsageContext = {
  readonly providerID: string
  readonly cache_read: number
  readonly cache_write: number
  readonly model: {
    readonly id: string
    readonly providerID: string
    readonly variant?: string
  }
}

export type Options = {
  /** Compact eligible tool results instead of sending them in full. */
  readonly enabled?: boolean
  /** Minimum serialized output size that earns a compact marker. */
  readonly minOutputChars?: number
  /** Tools whose bulk output is cheap to re-retrieve on demand. */
  readonly tools?: ReadonlySet<string>
  /** Session the history belongs to, named in the marker. */
  readonly sessionID?: string
  /** Provider cache mark for selective projection. */
  readonly providerMark?: number
  /** Usage context for cache mark updates. */
  readonly usageContext?: UsageContext
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
  const min = process.env[FLAG_MIN_CHARS]
  if (min === undefined) return PREVIEW_HEAD
  const parsed = parseInt(min, 10)
  if (isNaN(parsed)) return PREVIEW_HEAD
  return parsed
}

const tools = () => {
  const toolsEnv = process.env[FLAG_TOOLS]
  if (toolsEnv === undefined) return new Set(DEFAULT_TOOLS)
  return new Set(toolsEnv.split(",").filter(Boolean))
}

const serializeContent = (content: ReadonlyArray<SessionMessage.ToolStateCompleted["content"][number]>) => content.filter((part) => part.type === "text").map((part) => part.text).join("\n")

const detectKind = (name: string, input: unknown, text: string): Kind | undefined => {
  if (name === "shell") return "bash"
  if (name === "webfetch") return "artifact"
  if (name === "websearch") return "url"
  return undefined
}

const kindSummary = (kind: Kind, input: unknown): string | undefined => {
  if (kind === "bash") {
    const lines = input as { command?: string } | undefined
    return lines?.command?.slice(0, SUMMARY_LIMIT)
  }
  return undefined
}

import { getProviderMark, applyUsageToLedger } from "./cache-mark-ledger.js"

const applyUsageToLedgerImpl = async (usageContext: UsageContext) => {
  if (!usageContext) return
  
  try {
    await applyUsageToLedger(usageContext.providerID, usageContext)
  } catch (error) {
    // Fail-safe: if we can't apply usage, log it but continue
    console.warn("[mem-context] Failed to apply usage to ledger:", error)
  }
}

export const project = (
  messages: readonly SessionMessage.Info[],
  options: Options = {}
): readonly SessionMessage.Info[] => {
  if (!(options.enabled ?? enabled())) return messages
  const minChars = options.minOutputChars ?? minOutputChars()
  const allowed = options.tools ?? tools()
  let count = 0
  
  const projected = messages.map((message): SessionMessage.Info => {
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
      
      let currentMark = 0
      let useMarkBehavior = false
      
      // Use mark-based behavior if providerMark is explicitly provided
      if (options.providerMark !== undefined) {
        currentMark = options.providerMark
        useMarkBehavior = true
      }
      
      // mark=0 means no compression (byte-for-byte, full prefix)
      if (useMarkBehavior && currentMark === 0) return item
      
      // If we're before the mark, don't compress (mark-based behavior)
      if (useMarkBehavior && currentMark > 0) {
        const bytesBeforeMark = currentMark * 4
        const bytesInContent = text.length
        if (bytesInContent <= bytesBeforeMark) {
          return item
        }
      }
      
      const kind = detectKind(item.name, item.state.input, text)
      const summary = kind && kindSummary(kind, item.state.input)
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
  
  // Apply usage context after projection to update the mark
  if (options.usageContext) {
    // Fire and forget - we don't block the projection on ledger updates
    applyUsageToLedgerImpl(options.usageContext).catch((error) => {
      console.warn("[mem-context] Failed to apply usage to ledger:", error)
    })
  }
  
  debug(
    `[mem-context] session=${options.sessionID ?? "?"} compacted=${count} min_chars=${minChars} tools=${[...allowed].join(",")}${options.usageContext ? ` provider=${options.usageContext.providerID} cache_read=${options.usageContext.cache_read}` : ""}`,
  )
  return projected
}

function toolMarker({
  kind,
  name,
  callID,
  messageID,
  sessionID,
  text,
  summary,
  pii,
}: {
  readonly kind?: Kind
  readonly name: string
  readonly callID: string
  readonly messageID: string
  readonly sessionID?: string
  readonly text: string
  readonly summary?: string
  readonly pii?: string
}): string {
  const parts: string[] = []
  if (kind) parts.push(`kind=${kind}`)
  parts.push(`name=${name}`)
  parts.push(`callID=${callID}`)
  parts.push(`messageID=${messageID}`)
  if (sessionID) parts.push(`sessionID=${sessionID}`)
  parts.push(`retrieve=get_tool_call_details(call_id=${callID})`) // Replace with actual tool name
  if (summary) parts.push(`summary=${summary}`)
  if (pii) parts.push(`pii=${pii}`)
  
  return `[mem:compacted tool result: ${parts.join("|")}]\n` + text
}

export { getProviderMark, getMarkForProjection } from "./cache-mark-ledger"

export const SessionMemoryContext = {
  project,
  getProviderMark,
}