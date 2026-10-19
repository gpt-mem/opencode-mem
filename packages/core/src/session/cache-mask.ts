export * as CacheMask from "./cache-mask.js"

import { Message } from "@opencode/ai"
import { Effect } from "effect"
import { CacheMark } from "./cache-mark.js"
import type { Database } from "../database/database.js"

/** The provider id the Ladder is configured under. */
export const LADDER = "ladder"

/** Trailing messages that always stay verbatim — the model is still working with them. */
export const KEEP_RECENT = 12

/**
 * A confirmed cache boundary older than this is treated as cold: the provider
 * may have dropped the scope it confirmed, and sending a stale variant costs a
 * rejected request. The next confirmed response re-warms the ledger.
 */
export const DEFAULT_IDLE_MS = 10 * 60 * 1000

const number = (raw: string | undefined, fallback: number) => {
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : fallback
}

const enabled = () => process.env.OPENCODE_CACHE_MASK !== "0"

const idleMs = () => number(process.env.OPENCODE_CACHE_MARK_IDLE_MS, DEFAULT_IDLE_MS)

/** The Ladder's cache scope is an opaque, provider-issued id. */
const SCOPE = /^v1_[a-f0-9]{32}$/

export type Projection = {
  readonly messages: ReadonlyArray<Message>
  /** The leading run of messages left byte-identical to the originals. */
  readonly verbatim: number
}

export type Response = {
  readonly rung?: string
  readonly scope?: string
  readonly variant: "default" | "masked"
}

/** The response headers the Ladder reports back about the rung that served the request. */
export const parseHeaders = (headers: Readonly<Record<string, string | undefined>>): Response => {
  const rung = headers["x-ladder-model"]
  const scope = headers["x-ladder-cache-scope"]
  return {
    ...(rung ? { rung } : {}),
    ...(scope && SCOPE.test(scope) ? { scope } : {}),
    variant: headers["x-ladder-cache-variant"] === "masked" ? "masked" : "default",
  }
}

/**
 * The marker keeps the pointer to the saved output: the tool-output store
 * wrote the full payload to a file, so the model can read it instead of
 * re-running the command.
 */
const marker = (name: string, text: string) => {
  const lines = text.split("\n")
  let saved: string | undefined
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]
    if (line !== undefined && line.includes("full output saved to")) {
      saved = line.trim()
      break
    }
  }
  return saved ? `[compacted ${name} output — ${saved}]` : `[compacted ${name} output — re-run the tool if you need it]`
}

/** The text a tool result carries, if any. */
const resultText = (result: { readonly type: string; readonly value: unknown }) => {
  if (result.type === "text") return typeof result.value === "string" ? result.value : ""
  if (result.type === "content" && Array.isArray(result.value))
    return result.value
      .filter(
        (item): item is { readonly type: "text"; readonly text: string } =>
          typeof item === "object" && item !== null && (item as { readonly type?: unknown }).type === "text",
      )
      .map((item) => item.text)
      .join("\n")
  return ""
}

const compact = (message: Message) => {
  if (message.role !== "tool") return message
  const content = message.content.map((part) => {
    if (part.type !== "tool-result") return part
    return { ...part, result: { type: "text" as const, value: marker(part.name, resultText(part.result)) } }
  })
  return Message.make({ ...message, content })
}

/**
 * Compact the settled tool results of a conversation.
 *
 * The messages below `markIndex` stay byte-identical: the provider confirmed
 * that prefix in its cache, and rewriting it would invalidate the cache. The
 * trailing `keepRecent` messages stay verbatim as well — the model is still
 * working with them.
 */
export const project = (
  messages: ReadonlyArray<Message>,
  options: { readonly markIndex?: number; readonly keepRecent?: number } = {},
): Projection => {
  const markIndex = Math.max(0, options.markIndex ?? 0)
  const keepRecent = options.keepRecent ?? KEEP_RECENT
  const floor = Math.min(markIndex, messages.length)
  const tail = Math.max(0, messages.length - keepRecent)
  const projected = messages.map((message, index) => {
    if (index < floor) return message
    if (index >= tail) return message
    return compact(message)
  })
  return { messages: projected, verbatim: CacheMark.verbatimPrefixLength(projected, messages) }
}

export type Observation = { response?: Response }

export type State = {
  /** The ledger key of the provider/model. */
  readonly key: string
  /** The messages both branches were built from. */
  readonly raw: ReadonlyArray<Message>
  /** The branch the provider serves without a confirmed cache scope. */
  readonly fallback: Projection
  /** The branch floored at the confirmed cache boundary. */
  readonly masked?: Projection
  /** The confirmed cache boundary the masked branch is floored at. */
  readonly markIndex: number
  /** The rung the confirmed cache boundary belongs to. */
  readonly rung: string | undefined
  /** The cache scope the confirmed cache boundary belongs to. */
  readonly scope: string | undefined
  /** The response headers of the request this state belongs to. */
  readonly observation: Observation
}

/**
 * Build the two branches the Ladder may serve.
 *
 * The fallback branch compacts every settled tool result. The masked branch
 * compacts only the results above the confirmed cache boundary, so the prefix
 * the provider already cached stays byte-identical and its prefix cache keeps
 * hitting. Both branches are byte-identical above the boundary, so the cache
 * survives the switch between them.
 */
export const apply = Effect.fn("CacheMask.apply")(function* (input: {
  readonly db: Database.Interface["db"]
  readonly providerID: string
  readonly modelID: string
  readonly messages: ReadonlyArray<Message>
}) {
  if (input.providerID !== LADDER) return undefined
  if (!enabled()) return undefined
  const key = `${input.providerID}/${input.modelID}`
  const scoped = yield* CacheMark.latestScoped(input.db, key, input.messages, { idleMs: idleMs() }).pipe(
    Effect.catchDefect(() => Effect.succeed(undefined)),
  )
  const markIndex = scoped?.index ?? 0
  const fallback = project(input.messages, { markIndex: 0 })
  const masked = scoped ? project(input.messages, { markIndex: scoped.index }) : undefined
  return {
    key,
    raw: input.messages,
    fallback,
    masked,
    markIndex,
    rung: scoped?.rung,
    scope: scoped?.scope,
    observation: {} as Observation,
  }
})

/** The body the Ladder expects: the conversation id and the cache variant to serve. */
export const body = (input: {
  readonly sessionID: string
  readonly rung?: string
  readonly scope?: string
  readonly messages: ReadonlyArray<unknown>
}) => ({
  ladder_conversation: input.sessionID,
  ...(input.rung && input.scope
    ? {
        ladder_cache_variant: {
          rung: input.rung,
          cache_scope: input.scope,
          messages: input.messages,
          // The service validates the variant field and rejects the whole request
          // with "invalid ladder_cache_variant" when it is absent.
          variant: "masked",
        },
      }
    : {}),
})

/** The ledger key of a served rung: the provider cache belongs to the rung and its scope. */
export const scopedKey = (key: string, response: Response) =>
  response.rung && response.scope ? `${key}::${response.rung}::${response.scope}` : undefined

/**
 * Record the provider's confirmation of the prefix it cached.
 *
 * The served branch decides the verbatim prefix: the masked branch is floored
 * at the confirmed boundary, the fallback branch compacts everything it can.
 */
export const record = Effect.fn("CacheMask.record")(function* (input: {
  readonly db: Database.Interface["db"]
  readonly state: State
  readonly response: Response | undefined
  readonly usage: {
    readonly input: number
    readonly output: number
    readonly cacheRead: number
    readonly cacheWrite: number
  }
}) {
  if (!input.response) return
  const key = scopedKey(input.state.key, input.response)
  if (!key) return
  const served = input.response.variant === "masked" ? input.state.masked : input.state.fallback
  if (!served) return
  yield* CacheMark.recordUsage(
    input.db,
    key,
    {
      ...input.usage,
      sentCount: served.verbatim,
    },
    input.state.raw,
  )
})

/**
 * A failed attempt leaves the provider cache unverifiable: the TTL outlived
 * the stall, the rung went down, routing moved. Collapse the mark so the next
 * attempt does not resuscitate a prefix nobody may still hold.
 */
export const forget = Effect.fn("CacheMask.forget")(function* (input: {
  readonly db: Database.Interface["db"]
  readonly state: State
  readonly response?: Response
}) {
  const key = input.response ? scopedKey(input.state.key, input.response) : undefined
  // Without a response the rung is unknown, so every confirmation of that
  // provider/model goes — a stale one is worse than none.
  if (key) yield* CacheMark.reset(input.db, key)
  else yield* CacheMark.resetMatching(input.db, input.state.key)
})
