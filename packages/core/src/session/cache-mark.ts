// Pure ledger core (ARCHITECTURE §13 / issue #29 / #202)
// Ported from v1 cache-mark.ts, adapted to v2 message shape.

import { Effect } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "../database/database.js"
import { ProviderCacheMarkTable } from "./sql.js"

type DatabaseService = Database.Interface["db"]

export * as CacheMark from "./cache-mark.js"

export type Usage = {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
  /** Length of the request's verbatim prefix — how many leading messages were
   * sent byte-identical to the raw originals (see verbatimPrefixLength). */
  readonly sentCount: number
}

export type Mark = {
  readonly tokens: number
  readonly index: number
}

// Pure ledger transition:
// - no cache activity (cacheRead + cacheWrite === 0) → mark collapses to 0:
//   the provider confirmed it holds nothing — the whole history is
//   eligible for compression (free-provider track A);
// - stable or growing cache_read (or the first observation) → the verbatim
//   prefix of the request we just sent is (or will be) cached by the next
//   read, so the mark becomes that prefix's length;
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

// Length of the leading run of messages the projection left untouched.
// The projection returns the original object for unchanged messages, so reference
// identity is exact: this is the part of the sent request the provider cached
// as raw original bytes — the only part the next projection may floor at.
export const verbatimPrefixLength = (projected: readonly unknown[], original: readonly unknown[]): number => {
  const limit = Math.min(projected.length, original.length)
  let index = 0
  while (index < limit && projected[index] === original[index]) index++
  return index
}

// Dual FNV-1a 32-bit folded to 64-bit hex. Integrity check for "did anything
// below the mark mutate" — not security; the failure mode of a collision is a
// stale verbatim prefix, which the provider itself would reject with a miss.
export const prefixHash = (serialized: string): string => {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < serialized.length; i++) {
    const c = serialized.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193)
    h2 = Math.imul(h2 ^ c, 0x85ebca6b)
  }
  return `${(h1 >>> 0).toString(16).padStart(8, "0")}${(h2 >>> 0).toString(16).padStart(8, "0")}`
}

// A background title/summary job may add display-only metadata to a message after
// it has been sent. That metadata is not part of the provider-visible prompt.
// Keep the integrity check over the original message parts while ignoring it.
// v2: strip `description` from system/synthetic messages (display-only).
export const messagePrefixHash = (messages: readonly unknown[]): string =>
  prefixHash(
    JSON.stringify(
      messages.map((item) => {
        if (!item || typeof item !== "object") return item
        const msg = item as Record<string, unknown>
        // User: no volatile display field in v2
        // System/Synthetic: `description` is display-only, not in model prompt
        if (msg.type === "system" || msg.type === "synthetic") {
          const { description: _description, ...rest } = msg
          return rest
        }
        return item
      }),
    ),
  )

// Mark floor for the next projection.
// - returns messages.length = verbatim (compression off) on integrity failure:
//   hash mismatch, or the history shrank below the stored mark
//   (the raw bytes the provider cached no longer match our originals,
//   so the caller must fail safe and send verbatim);
// - 0 = no row yet (the provider has confirmed nothing — same as the free
//   provider case, the whole history is eligible) or a confirmed mark of 0.
export const markIndexFor = Effect.fn("CacheMark.markIndexFor")(function* (
  db: DatabaseService,
  providerID: string,
  messages: readonly unknown[],
  options?: { readonly idleMs?: number },
) {
  const [row] = yield* db
    .select()
    .from(ProviderCacheMarkTable)
    .where(eq(ProviderCacheMarkTable.provider_id, providerID))
    .execute()

  if (!row) return 0 // no row → whole history eligible (free track A)
  if (row.mark_index <= 0) return 0
  if (row.mark_index > messages.length) return messages.length // history shrunk → verbatim
  if (row.prefix_hash !== null && row.prefix_hash !== messagePrefixHash(messages.slice(0, row.mark_index))) {
    return messages.length // hash mismatch → verbatim (compression off)
  }
  const idleMs = options?.idleMs ?? 0
  if (idleMs > 0 && Date.now() - row.last_used_at >= idleMs) return 0 // cold → eligible
  return row.mark_index
})

// Record the provider's post-response confirmation.
// No-op when the response carried no usage at all (aborted turn, provider error) —
// a missing response must never clobber a confirmed mark.
export const recordUsage = Effect.fn("CacheMark.recordUsage")(function* (
  db: DatabaseService,
  providerID: string,
  usage: Usage,
  messages: readonly unknown[],
) {
  if (
    Math.max(0, usage.input) +
      Math.max(0, usage.output) +
      Math.max(0, usage.cacheRead) +
      Math.max(0, usage.cacheWrite) <=
    0
  ) return
  const [existing] = yield* db
    .select()
    .from(ProviderCacheMarkTable)
    .where(eq(ProviderCacheMarkTable.provider_id, providerID))
    .execute()

  const prev: Mark | undefined = existing === undefined ? undefined : { tokens: existing.mark_tokens, index: existing.mark_index }
  const next = applyUsage(prev, usage)
  const hash = next.index > 0 ? messagePrefixHash(messages.slice(0, next.index)) : null
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

// Issue #39 (failure ≈ cache death): a request that failed, timed out or was
// aborted leaves the provider cache unverifiable — TTL outlived the stall,
// the rung went down, routing moved. Collapse the mark to zero
// (pending-verification) so the next attempt sends the compact projection
// instead of resuscitating a full verbatim prefix into a cold cache.
// The next confirmed response self-heals the mark through recordUsage.
export const reset = Effect.fn("CacheMark.reset")(function* (db: DatabaseService, providerID: string) {
  const now = Date.now()
  yield* db
    .insert(ProviderCacheMarkTable)
    .values({
      provider_id: providerID,
      mark_tokens: 0,
      mark_index: 0,
      prefix_hash: null,
      last_used_at: now,
    })
    .onConflictDoUpdate({
      target: ProviderCacheMarkTable.provider_id,
      set: { mark_tokens: 0, mark_index: 0, prefix_hash: null, last_used_at: now },
    })
    .run()
    .pipe(Effect.orDie)
})
