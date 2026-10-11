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
  // Length of the request's verbatim prefix — how many leading messages were
  // sent byte-identical to the raw originals (see verbatimPrefixLength). Not
  // the total projected length: compacted messages were cached as marker
  // bytes, and forcing them back to originals below a grown mark would mutate
  // the provider's cached prefix.
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

// Length of the leading run of messages the projection left untouched. The
// projection returns the original object for unchanged messages, so reference
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

// Mark floor for the next projection.
// - undefined = integrity failure (prefix hash mismatch, or the history shrank
//   below the stored mark): the raw bytes the provider cached no longer match
//   our originals, so the caller must fail safe and send verbatim;
// - 0 = no row yet (the provider has confirmed nothing — same as the free
//   provider case, the whole history is eligible) or a confirmed mark of 0.
// The no-row case used to fail safe to a verbatim send, which defeated
// first-delivery compaction on the very first request and let the provider
// cache the full bulk — the mark then pinned that bulk verbatim forever
// (issue #29 acceptance: fdmark arm cost ≈ off instead of ≈ fd).
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
  if (row === undefined) return 0
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

// Issue #39 (failure ≈ cache death): a request that failed, timed out or was
// aborted leaves the provider cache unverifiable — TTL outlived the stall,
// the rung went down, routing moved. Collapse the mark to zero
// (pending-verification) so the next attempt sends the compact projection
// instead of resuscitating a full verbatim prefix into a cold cache. The next
// confirmed response self-heals the mark through applyUsage (ARCHITECTURE §13).
export const reset = Effect.fn("CacheMark.reset")(function* (
  db: DatabaseService,
  providerID: string,
) {
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
