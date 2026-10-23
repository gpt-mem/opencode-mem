import { Context, Effect, Layer } from "effect"
import { Database } from "../database/database.js"
import { ProviderCacheMarkTable } from "./sql.js"
import { eq } from "drizzle-orm"
import { makeLocationNode } from "@opencode/util/effect/app-node"

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
      cache_read: number
      cache_write: number
      model: {
        id: string
        providerID: string
        variant?: string
      }
    }
  ): Effect.Effect<void, Error, Database.Database.Service>

  /**
   * Get the mark for use in memory context projection.
   * Returns null if there's no mark or if there's an error (fail-safe).
   */
  getProjectionMark(providerID: ProviderID): Effect.Effect<number | null, Error, Database.Database.Service>

  /**
   * Check if a provider's mark is stale (not used for a long time)
   * Returns true if the mark is stale (should be reset to 0)
   */
  isMarkStale(providerID: ProviderID, maxIdleMs: number): Effect.Effect<boolean, Error, Database.Database.Service>
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

      // Default to 0 if no mark exists
      return row?.mark_tokens ?? 0
    })
  }

  applyUsage(
    providerID: ProviderID,
    usage: {
      cache_read: number
      cache_write: number
      model: {
        id: string
        providerID: string
        variant?: string
      }
    }
  ): Effect.Effect<void, Error, Database.Database.Service> {
    return Effect.gen(function* () {
      const db = (yield* Database.Service).db

      // Get current mark
      const current = yield* db
        .select()
        .from(ProviderCacheMarkTable)
        .where(eq(ProviderCacheMarkTable.provider_id, providerID))
        .execute()

      const currentMark = current[0]?.mark_tokens ?? 0

      // Determine new mark: use the max of current mark and cache_read
      // This ensures we only move forward, never backward
      const newMark = Math.max(currentMark, usage.cache_read)

      if (newMark !== currentMark) {
        // Calculate prefix hash if we're moving forward
        const prefix_hash = newMark > 0 ? `hash_at_${newMark}` : null

        yield* db
          .insert(ProviderCacheMarkTable)
          .values({
            provider_id: providerID,
            mark_tokens: newMark,
            prefix_hash,
            last_used_at: Date.now(),
          })
          .onConflictDoUpdate({
            target: ProviderCacheMarkTable.provider_id,
            set: {
              mark_tokens: newMark,
              prefix_hash,
              last_used_at: Date.now(),
            },
          })
          .execute()
      } else if (current[0]) {
        // Update last_used_at even if mark didn't change
        yield* db
          .update(ProviderCacheMarkTable)
          .set({ last_used_at: Date.now() })
          .where(eq(ProviderCacheMarkTable.provider_id, providerID))
          .execute()
      }
    })
  }

  getProjectionMark(providerID: ProviderID): Effect.Effect<number | null, Error, Database.Database.Service> {
    const self = this
    return Effect.gen(function* () {
      try {
        return yield* self.getMark(providerID)
      } catch (error) {
        // Fail-safe: if we can't read the mark, return null
        // This will cause the projection to use full prefix compression
        return null
      }
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

      if (!row?.last_used_at) {
        return true
      }

      const now = Date.now()
      const idleMs = now - row.last_used_at
      return idleMs > maxIdleMs
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
