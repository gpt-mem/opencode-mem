export * as CacheMark from "./cache-mark"

import { Effect } from "effect"
import { eq } from "drizzle-orm"
import type { Database } from "../database/database"
import { ProviderCacheMarkTable } from "./sql"

type DatabaseService = Database.Interface["db"]

export type Usage = {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly sentCount: number
}

export type Mark = {
  readonly tokens: number
  readonly index: number
}

// Pure ledger transition (ARCHITECTURE §13 / issue #29):
// - no cache activity (cacheRead + cacheWrite === 0) → mark collapses to 0:
//   the provider confirmed it holds nothing — track A, the whole history is
//   eligible for compression;
// - stable or growing cache_read (or the first observation) → the request we
//   just sent is (or will be) cached by the next read, so the mark becomes the
//   message count of that request;
// - cache_read fell below the confirmed mark (provider-side eviction) →
//   shrink proportionally; provider prefix caches are prefix-shaped, so the
//   read/mark ratio is a reasonable estimate of what survived.
export const applyUsage = (prev: Mark | undefined, usage: Usage): Mark => {
  const cacheRead = Math.max(0, usage.cacheRead)
  const cacheWrite = Math.max(0, usage.cacheWrite)
  const sentCount = Math.max(0, Math.floor(usage.sentCount))
  if (cacheRead + cacheWrite === 0) return { tokens: 0, index: 0 }
  if (prev === undefined || prev.tokens === 0 || cacheRead >= prev.tokens)
    return { tokens: cacheRead + cacheWrite, index: sentCount }
  return { tokens: cacheRead, index: Math.floor(prev.index * (cacheRead / prev.tokens)) }
}

// Dual FNV-1a 32-bit folded to 64-bit hex. Integrity check for "did anything
// below the mark mutate" — not security; the failure mode of a collision is a
// stale verbatim prefix, which the provider itself would reject with a miss.
export const prefixHash = (serialized: string) => {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < serialized.length; i++) {
    const c = serialized.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193)
    h2 = Math.imul(h2 ^ c, 0x85ebca6b)
  }
  return `${(h1 >>> 0).toString(16).padStart(8, "0")}${(h2 >>> 0).toString(16).padStart(8, "0")}`
}

// Mark floor for the next projection. undefined = fail-safe (ARCHITECTURE §13):
// no ledger row, prefix hash mismatch, or the history shrank below the stored
// mark — the caller must send the history verbatim instead of compressing.
export const markIndexFor = Effect.fn("CacheMark.markIndexFor")(function* (
  db: DatabaseService,
  providerID: string,
  messages: readonly unknown[],
) {
  const row = yield* db
    .select()
    .from(ProviderCacheMarkTable)
    .where(eq(ProviderCacheMarkTable.provider_id, providerID))
    .get()
    .pipe(Effect.orDie)
  if (row === undefined) return undefined
  if (row.mark_index <= 0) return 0
  if (row.mark_index > messages.length) return undefined
  if (row.prefix_hash !== null && row.prefix_hash !== prefixHash(JSON.stringify(messages.slice(0, row.mark_index))))
    return undefined
  return row.mark_index
})

// Record the provider's post-response confirmation. No-op when the response
// carried no usage at all (aborted turn, provider error) — a missing response
// must never clobber a confirmed mark.
export const recordUsage = Effect.fn("CacheMark.recordUsage")(function* (
  db: DatabaseService,
  providerID: string,
  usage: Usage,
  messages: readonly unknown[],
) {
  if (Math.max(0, usage.input) + Math.max(0, usage.output) + Math.max(0, usage.cacheRead) + Math.max(0, usage.cacheWrite) <= 0)
    return
  const existing = yield* db
    .select()
    .from(ProviderCacheMarkTable)
    .where(eq(ProviderCacheMarkTable.provider_id, providerID))
    .get()
    .pipe(Effect.orDie)
  const prev: Mark | undefined =
    existing === undefined ? undefined : { tokens: existing.mark_tokens, index: existing.mark_index }
  const next = applyUsage(prev, usage)
  const hash = next.index > 0 ? prefixHash(JSON.stringify(messages.slice(0, next.index))) : null
  const now = Date.now()
  yield* db
    .insert(ProviderCacheMarkTable)
    .values({
      provider_id: providerID,
      mark_tokens: next.tokens,
      mark_index: next.index,
      prefix_hash: hash,
      last_used_at: now,
    })
    .onConflictDoUpdate({
      target: ProviderCacheMarkTable.provider_id,
      set: { mark_tokens: next.tokens, mark_index: next.index, prefix_hash: hash, last_used_at: now },
    })
    .run()
    .pipe(Effect.orDie)
})
