import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Database } from "@opencode/core/database/database"
import { CacheMarkLedgerService, node as CacheMarkLedgerNode } from "@opencode/core/session/cache-mark-ledger"
import { Bus } from "@opencode/core/bus"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, CacheMarkLedgerNode]),
  ),
)

// Test the CacheMarkLedger service with proper database context
describe("CacheMarkLedger - Unit Ledger Basics", () => {
  it.effect("getMark returns 0 for new provider", () => Effect.gen(function* () {
    const ledger = yield* CacheMarkLedgerService
    const providerID = "test-provider-1"
    
    const mark = yield* ledger.getMark(providerID)
    
    expect(mark).toBe(0)
  }))
  
  it.effect("applyUsage updates mark to cache_read value", () => Effect.gen(function* () {
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
  }))
  
  it.effect("mark only increases (forward-only)", () => Effect.gen(function* () {
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
  }))
  
  it.effect("new provider starts with mark=0", () => Effect.gen(function* () {
    const ledger = yield* CacheMarkLedgerService
    const providerID = "test-provider-4"
    
    const mark = yield* ledger.getMark(providerID)
    
    expect(mark).toBe(0)
  }))
  
  it.effect("getProjectionMark returns mark value", () => Effect.gen(function* () {
    const ledger = yield* CacheMarkLedgerService
    const providerID = "test-provider-5"
    
    const mark = yield* ledger.getProjectionMark(providerID)
    
    expect(mark).toBe(0)
  }))
  
  it.effect("isMarkStale returns true for non-existent provider", () => Effect.gen(function* () {
    const ledger = yield* CacheMarkLedgerService
    const providerID = "test-provider-6"
    const maxIdleMs = 3600000
    
    const isStale = yield* ledger.isMarkStale(providerID, maxIdleMs)
    
    expect(isStale).toBe(true)
  }))
  
  it.effect("isMarkStale returns false for recently used provider", () => Effect.gen(function* () {
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
  }))
})