import { Context, Effect, Layer } from "effect"
import { Database } from "../database/database.js"
import { ProviderCacheMarkTable } from "./sql.js"
import { eq } from "drizzle-orm"

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
  getMark(providerID: ProviderID): Effect.Effect<number, Error> {
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
  ): Effect.Effect<void, Error> {
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
        // In a real implementation, we'd hash the prefix that we've now confirmed as cached
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

  getProjectionMark(providerID: ProviderID): Effect.Effect<number | null, Error> {
    return Effect.gen(function* () {
      try {
        const mark = yield* this.getMark(providerID)
        return mark
      } catch (error) {
        // Fail-safe: if we can't read the mark, return null
        // This will cause the projection to use full prefix compression
        return null
      }
    })
  }

  isMarkStale(providerID: ProviderID, maxIdleMs: number): Effect.Effect<boolean, Error> {
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

// SQL table definition (exported for migration)
export const sqlProviderCacheMarkTable = ProviderCacheMarkTable

// Helper functions for standalone usage (used by memory-context.ts)
export const getProviderMark = async (providerID: string): Promise<number> => {
  // This is a helper function for memory-context.ts integration
  // In a complete implementation, this would use the CacheMarkLedger service
  return 0
}

export const getMarkForProjection = async (providerID: string): Promise<number | null> => {
  // This is a helper function for memory-context.ts integration
  // In a complete implementation, this would use the CacheMarkLedger service
  return null
}

export const applyUsageToLedger = async (providerID: string, usage: {
  cache_read: number
  cache_write: number
  model: {
    id: string
    providerID: string
    variant?: string
  }
}): Promise<void> => {
  // This is a helper function for memory-context.ts integration
  // In a complete implementation, this would use the CacheMarkLedger service
  console.log("[mem-context] Applying usage to ledger:", { providerID, ...usage })
}