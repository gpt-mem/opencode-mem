import { Context, Effect, Layer } from "effect"
import { Database } from "../database/database.js"
import { ProviderCacheMarkTable } from "./sql.js"
import { eq } from "drizzle-orm"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import * as CacheMark from "./cache-mark.js"

// Types
export type ProviderID = string

export interface CacheMarkLedger {
  /** Get the current mark (number of tokens confirmed as cached) for a provider */
  getMark(providerID: ProviderID): Effect.Effect<number, Error, Database.Database.Service>

  /**
   * Apply a usage event from a provider response.
   * This is called after each provider response to update the mark based on cache_read.
   */
  applyUsage(
    providerID: ProviderID,
    usage: {
      input: number
      output: number
      cache_read: number
      cache_write: number
      sentCount: number
    },
    messages: readonly unknown[],
  ): Effect.Effect<void, Error, Database.Database.Service>

  /**
   * Get the mark index for use in memory context projection.
   * Returns the message index floor:
   * - 0 = whole history eligible (free track)
   * - messages.length = verbatim (compression off, integrity failure)
   * - n = keep messages[0..n-1] verbatim, compress suffix from n onward
   */
  getProjectionMark(providerID: ProviderID, messages: readonly unknown[]): Effect.Effect<number, Error, Database.Database.Service>

  /**
   * Check if a provider's mark is stale (not used for a long time)
   * Returns true if the mark is stale (should be reset to 0)
   */
  isMarkStale(providerID: ProviderID, maxIdleMs: number): Effect.Effect<boolean, Error, Database.Database.Service>

  /** Reset the mark for a provider (used on request failure) */
  reset(providerID: ProviderID): Effect.Effect<void, Error, Database.Database.Service>
}

export class CacheMarkLedgerImpl implements CacheMarkLedger {
  getMark(providerID: ProviderID): Effect.Effect<number, Error, Database.Database.Service> {
    return Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const [row] = yield* db
        .select()
        .from(ProviderCacheMarkTable)
        .where(eq(ProviderCacheMarkTable.provider_id, providerID))
        .execute()

      return row?.mark_tokens ?? 0
    })
  }

  applyUsage(
    providerID: ProviderID,
    usage: {
      input: number
      output: number
      cache_read: number
      cache_write: number
      sentCount: number
    },
    messages: readonly unknown[],
  ): Effect.Effect<void, Error, Database.Database.Service> {
    return Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* CacheMark.recordUsage(db, providerID, {
        input: usage.input,
        output: usage.output,
        cacheRead: usage.cache_read,
        cacheWrite: usage.cache_write,
        sentCount: usage.sentCount,
      }, messages)
    })
  }

  getProjectionMark(providerID: ProviderID, messages: readonly unknown[]): Effect.Effect<number, Error, Database.Database.Service> {
    return Effect.gen(function* () {
      const db = (yield* Database.Service).db
      // mid-turn: no idle reset
      return yield* CacheMark.markIndexFor(db, providerID, messages, { idleMs: 0 })
    })
  }

  isMarkStale(providerID: ProviderID, maxIdleMs: number): Effect.Effect<boolean, Error, Database.Database.Service> {
    return Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const [row] = yield* db
        .select()
        .from(ProviderCacheMarkTable)
        .where(eq(ProviderCacheMarkTable.provider_id, providerID))
        .execute()

      if (!row?.last_used_at) return true

      const now = Date.now()
      const idleMs = now - row.last_used_at
      return idleMs > maxIdleMs
    })
  }

  reset(providerID: ProviderID): Effect.Effect<void, Error, Database.Database.Service> {
    return Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* CacheMark.reset(db, providerID)
    })
  }
}

// Service
export class CacheMarkLedgerService extends Context.Service<CacheMarkLedgerService, CacheMarkLedger>()(
  "@opencode/CacheMarkLedger"
) {
  static readonly layer = Layer.effect(
    CacheMarkLedgerService,
    Effect.gen(function* () {
      yield* Database.Service
      return new CacheMarkLedgerImpl()
    })
  )
}

// Helper to run ledger operations with database context
export const runLedger = <T, E>(
  effect: Effect.Effect<T, E, Database.Database.Service>
): Effect.Effect<T, E, Database.Database.Service> => {
  return effect
}

export const node = makeLocationNode({
  service: CacheMarkLedgerService,
  layer: CacheMarkLedgerService.layer,
  deps: [Database.node],
})