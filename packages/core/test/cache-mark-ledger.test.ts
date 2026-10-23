import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Database } from "@opencode/core/database/database"
import { CacheMarkLedgerService } from "@opencode/core/session/cache-mark-ledger"
import { CacheMarkLedgerEntry } from "@opencode/core/session/cache-mark-ledger-entry"
import { Bus } from "@opencode/core/bus"

// Simple test helper that doesn't use complex layer compilation
describe("CacheMarkLedger - Simple Tests", () => {
  test("getMark returns 0 for new provider", async () => {
    // Create a simple test setup manually
    const layer = AppNodeBuilder.build(
      LayerNode.group([Database.node, CacheMarkLedgerEntry.node, Bus.node]),
      [TestClock.layer()],
    )
    
    const effect = Effect.gen(function* () {
      const ledger = yield* CacheMarkLedgerService
      const providerID = "test-provider-1"
      
      const mark = yield* ledger.getMark(providerID)
      
      expect(mark).toBe(0)
    })
    
    await Effect.runPromise(effect.pipe(Effect.provide(layer)))
  })
  
  test("applyUsage updates mark to cache_read value", async () => {
    const layer = AppNodeBuilder.build(
      LayerNode.group([Database.node, CacheMarkLedgerEntry.node, Bus.node]),
      [TestClock.layer()],
    )
    
    const effect = Effect.gen(function* () {
      const ledger = yield* CacheMarkLedgerService
      const providerID = "test-provider-2"
      const usage = {
        cache_read: 1000,
        cache_write: 500,
        model: {
          id: "model-1",
          providerID,
          variant: "medium",
        }
      }
      
      yield* ledger.applyUsage(providerID, usage)
      
      const mark = yield* ledger.getMark(providerID)
      
      expect(mark).toBe(1000)
    })
    
    await Effect.runPromise(effect.pipe(Effect.provide(layer)))
  })
  
  test("mark only increases (forward-only)", async () => {
    const layer = AppNodeBuilder.build(
      LayerNode.group([Database.node, CacheMarkLedgerEntry.node, Bus.node]),
      [TestClock.layer()],
    )
    
    const effect = Effect.gen(function* () {
      const ledger = yield* CacheMarkLedgerService
      const providerID = "test-provider-3"
      const usage1 = {
        cache_read: 500,
        cache_write: 200,
        model: { id: "model-1", providerID },
      }
      const usage2 = {
        cache_read: 300,
        cache_write: 100,
        model: { id: "model-1", providerID },
      }
      
      yield* ledger.applyUsage(providerID, usage1)
      yield* ledger.applyUsage(providerID, usage2)
      
      const mark = yield* ledger.getMark(providerID)
      
      expect(mark).toBe(500)
    })
    
    await Effect.runPromise(effect.pipe(Effect.provide(layer)))
  })
  
  test("new provider starts with mark=0", async () => {
    const layer = AppNodeBuilder.build(
      LayerNode.group([Database.node, CacheMarkLedgerEntry.node, Bus.node]),
      [TestClock.layer()],
    )
    
    const effect = Effect.gen(function* () {
      const ledger = yield* CacheMarkLedgerService
      const providerID = "test-provider-4"
      
      const mark = yield* ledger.getMark(providerID)
      
      expect(mark).toBe(0)
    })
    
    await Effect.runPromise(effect.pipe(Effect.provide(layer)))
  })
  
  test("getProjectionMark returns mark value", async () => {
    const layer = AppNodeBuilder.build(
      LayerNode.group([Database.node, CacheMarkLedgerEntry.node, Bus.node]),
      [TestClock.layer()],
    )
    
    const effect = Effect.gen(function* () {
      const ledger = yield* CacheMarkLedgerService
      const providerID = "test-provider-5"
      
      const mark = yield* ledger.getProjectionMark(providerID)
      
      expect(mark).toBe(0)
    })
    
    await Effect.runPromise(effect.pipe(Effect.provide(layer)))
  })
  
  test("isMarkStale returns true for non-existent provider", async () => {
    const layer = AppNodeBuilder.build(
      LayerNode.group([Database.node, CacheMarkLedgerEntry.node, Bus.node]),
      [TestClock.layer()],
    )
    
    const effect = Effect.gen(function* () {
      const ledger = yield* CacheMarkLedgerService
      const providerID = "test-provider-6"
      const maxIdleMs = 3600000
      
      const isStale = yield* ledger.isMarkStale(providerID, maxIdleMs)
      
      expect(isStale).toBe(true)
    })
    
    await Effect.runPromise(effect.pipe(Effect.provide(layer)))
  })
  
  test("isMarkStale returns false for recently used provider", async () => {
    const layer = AppNodeBuilder.build(
      LayerNode.group([Database.node, CacheMarkLedgerEntry.node, Bus.node]),
      [TestClock.layer()],
    )
    
    const effect = Effect.gen(function* () {
      const ledger = yield* CacheMarkLedgerService
      const providerID = "test-provider-7"
      const maxIdleMs = 3600000
      
      const usage = {
        cache_read: 1000,
        cache_write: 500,
        model: { id: "model-1", providerID },
      }
      
      yield* ledger.applyUsage(providerID, usage)
      
      const isStale = yield* ledger.isMarkStale(providerID, maxIdleMs)
      
      expect(isStale).toBe(false)
    })
    
    await Effect.runPromise(effect.pipe(Effect.provide(layer)))
  })
})