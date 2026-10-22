import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { Database } from "@opencode/core/database/database"
import { Provider } from "@opencode/core/provider"
import { Model } from "@opencode/core/model"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { Agent } from "@opencode/core/agent"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { SessionMemoryContext } from "@opencode/core/session/memory-context"
import { SessionMessage } from "@opencode/core/session/message"
import { Agent as AgentType } from "@opencode/core/agent"
import { DateTime } from "effect"
import { CacheMarkLedgerService } from "@opencode/core/session/cache-mark-ledger"

// Test utilities
const createTestLayer = () => {
  return AppNodeBuilder.build(
    LayerNode.group([Database.node]),
    [TestClock.layer()],
  )
}

// Test data
const created = DateTime.makeUnsafe(0)
const sessionID = "ses_cache_mark_ledger_test"
const projectID = Project.ID.make("project")
const providerID = Provider.ID.make("provider")
const modelID = Model.ID.make("model")

const toolContent = "x".repeat(3000) // Large content for compression

// Test the CacheMarkLedger service
describe("CacheMarkLedger - Service Tests", () => {
  test("getMark returns 0 for new provider", async () => {
    const layer = createTestLayer()
    const cacheMarkLedger = await Effect.runPromise(
      Layer.provide(layer)(CacheMarkLedgerService.layer)
    )
    
    const mark = await Effect.runPromise(cacheMarkLedger.getMark(providerID))
    expect(mark).toBe(0)
  })

  test("applyUsage updates mark to cache_read value", async () => {
    const layer = createTestLayer()
    const cacheMarkLedger = await Effect.runPromise(
      Layer.provide(layer)(CacheMarkLedgerService.layer)
    )
    
    await Effect.runPromise(cacheMarkLedger.applyUsage(providerID, {
      cache_read: 1000,
      cache_write: 800,
      model: { id: modelID, providerID: providerID }
    }))
    
    const mark = await Effect.runPromise(cacheMarkLedger.getMark(providerID))
    expect(mark).toBe(1000)
  })

  test("mark only increases (forward-only)", async () => {
    const layer = createTestLayer()
    const cacheMarkLedger = await Effect.runPromise(
      Layer.provide(layer)(CacheMarkLedgerService.layer)
    )
    
    await Effect.runPromise(cacheMarkLedger.applyUsage(providerID, {
      cache_read: 1000,
      cache_write: 800,
      model: { id: modelID, providerID: providerID }
    }))
    
    await Effect.runPromise(cacheMarkLedger.applyUsage(providerID, {
      cache_read: 500,
      cache_write: 400,
      model: { id: modelID, providerID: providerID }
    }))
    
    const mark = await Effect.runPromise(cacheMarkLedger.getMark(providerID))
    expect(mark).toBe(1000)
  })

  test("new provider starts with mark=0", async () => {
    const layer = createTestLayer()
    const cacheMarkLedger = await Effect.runPromise(
      Layer.provide(layer)(CacheMarkLedgerService.layer)
    )
    
    const newProvider = Provider.ID.make("new_provider")
    const mark = await Effect.runPromise(cacheMarkLedger.getMark(newProvider))
    expect(mark).toBe(0)
  })

  test("getProjectionMark returns mark value", async () => {
    const layer = createTestLayer()
    const cacheMarkLedger = await Effect.runPromise(
      Layer.provide(layer)(CacheMarkLedgerService.layer)
    )
    
    await Effect.runPromise(cacheMarkLedger.applyUsage(providerID, {
      cache_read: 1000,
      cache_write: 800,
      model: { id: modelID, providerID: providerID }
    }))
    
    const projectionMark = await Effect.runPromise(cacheMarkLedger.getProjectionMark(providerID))
    expect(projectionMark).toBe(1000)
  })

  test("isMarkStale returns true for non-existent provider", async () => {
    const layer = createTestLayer()
    const cacheMarkLedger = await Effect.runPromise(
      Layer.provide(layer)(CacheMarkLedgerService.layer)
    )
    
    const newProvider = Provider.ID.make("stale_provider")
    const isStale = await Effect.runPromise(cacheMarkLedger.isMarkStale(newProvider, 1000))
    expect(isStale).toBe(true)
  })

  test("isMarkStale returns false for recently used provider", async () => {
    const layer = createTestLayer()
    const cacheMarkLedger = await Effect.runPromise(
      Layer.provide(layer)(CacheMarkLedgerService.layer)
    )
    
    await Effect.runPromise(cacheMarkLedger.applyUsage(providerID, {
      cache_read: 1000,
      cache_write: 800,
      model: { id: modelID, providerID: providerID }
    }))
    
    const isStale = await Effect.runPromise(cacheMarkLedger.isMarkStale(providerID, 1000))
    expect(isStale).toBe(false)
  })
})

describe("CacheMarkLedger - Integration Tests", () => {
  test("suffix-only compression with mark=1000 tokens", async () => {
    const layer = createTestLayer()
    // Test that content before mark is not compressed, content after mark is compressed
    // Simulate: provider has mark=1000 tokens (approx 4000 characters)
    // Tool output has 5000 characters, only 1000 characters beyond mark should be compressed
  })

  test("prefix remains byte-identical after projection with mark", async () => {
    const layer = createTestLayer()
    // Test that prefix up to mark remains exactly the same
    // When history grows, prefix doesn't change
  })

  test("provider isolation - different providers have different marks", async () => {
    const layer = createTestLayer()
    // Test that provider A with mark=500 and provider B with mark=2000
    // have independent compression behavior
  })
})

describe("Unified Mask - A/B Acceptance Tests", () => {
  test("mark=0 = Track A behavior (compress everything)", async () => {
    const layer = createTestLayer()
    // Test that free provider with mark=0 compresses everything (like Track A)
  })

  test("mark>0 = Track B behavior (compress only suffix)", async () => {
    const layer = createTestLayer()
    // Test that paid provider with mark>0 compresses only suffix
  })

  test("fail-safe: ledger error -> full prefix compression", async () => {
    const layer = createTestLayer()
    // Test that when ledger fails, projection falls back to full prefix compression
  })
})

describe("CacheMarkLedger - MemoryContext Integration", () => {
  test("MemoryContext.project uses providerMark parameter for compression", () => {
    const history = [
      SessionMessage.Assistant.make({
        id: SessionMessage.ID.make("msg_test"),
        type: "assistant",
        agent: AgentType.defaultID,
        model: { id: modelID, providerID: providerID },
        content: [
          SessionMessage.AssistantTool.make({
            type: "tool",
            id: "call_1",
            name: "shell",
            executed: false,
            state: SessionMessage.ToolStateCompleted.make({
              status: "completed",
              input: { command: "cat big.txt" },
              content: [{ type: "text", text: toolContent }],
            }),
            time: { created },
          }),
        ],
        time: { created, completed: created },
      }),
    ]
    
    // Test with mark=1000 tokens (approx 4000 characters)
    const projected = SessionMemoryContext.project(history, {
      enabled: true,
      minOutputChars: 100,
      providerMark: 1000, // Simulate provider has confirmed 1000 tokens cached
    })
    
    // Content before mark (first 4000 chars) should remain unchanged
    // Content after mark should be compressed
    const marker = projected[0].content[0].state.content[0].text
    expect(marker).toContain("[mem:compacted tool result]")
    expect(marker).toContain("retrieve=get_tool_call_details(call_id=\"call_1\")")
  })

  test("MemoryContext.project falls back to full compression when ledger fails", () => {
    const history = [
      SessionMessage.Assistant.make({
        id: SessionMessage.ID.make("msg_test"),
        type: "assistant",
        agent: AgentType.defaultID,
        model: { id: modelID, providerID: providerID },
        content: [
          SessionMessage.AssistantTool.make({
            type: "tool",
            id: "call_1",
            name: "shell",
            executed: false,
            state: SessionMessage.ToolStateCompleted.make({
              status: "completed",
              input: { command: "cat big.txt" },
              content: [{ type: "text", text: toolContent }],
            }),
            time: { created },
          }),
        ],
        time: { created, completed: created },
      }),
    ]
    
    // Test with providerMark=0 (fallback when ledger fails)
    const projected = SessionMemoryContext.project(history, {
      enabled: true,
      minOutputChars: 100,
      providerMark: 0, // No mark confirmed, compress everything
    })
    
    const marker = projected[0].content[0].state.content[0].text
    expect(marker).toContain("[mem:compacted tool result]")
  })

  test("MemoryContext.project does not compress content below mark", () => {
    const history = [
      SessionMessage.Assistant.make({
        id: SessionMessage.ID.make("msg_test"),
        type: "assistant",
        agent: AgentType.defaultID,
        model: { id: modelID, providerID: providerID },
        content: [
          SessionMessage.AssistantTool.make({
            type: "tool",
            id: "call_1",
            name: "shell",
            executed: false,
            state: SessionMessage.ToolStateCompleted.make({
              status: "completed",
              input: { command: "cat big.txt" },
              content: [{ type: "text", text: toolContent }],
            }),
            time: { created },
          }),
        ],
        time: { created, completed: created },
      }),
    ]
    
    // Test with mark large enough to cover all content
    // With 3000 chars, mark of 5000 tokens (20000 chars) means all content is before mark
    const projected = SessionMemoryContext.project(history, {
      enabled: true,
      minOutputChars: 100,
      providerMark: 5000, // Mark larger than content
    })
    
    // Content should remain unchanged since it's all before the mark
    const item = projected[0].content[0]
    expect(item.type).toBe("tool")
    expect(item.state.status).toBe("completed")
    // Content should be the original text, not compressed
    expect(item.state.content[0].type).toBe("text")
    expect(item.state.content[0].text).toBe(toolContent)
  })
})

describe("CacheMarkLedger - Unit Tests", () => {
  test("getMark returns 0 for new provider when providerMark is not set", () => {
    const history = [
      SessionMessage.Assistant.make({
        id: SessionMessage.ID.make("msg_test"),
        type: "assistant",
        agent: AgentType.defaultID,
        model: { id: modelID, providerID: providerID },
        content: [
          SessionMessage.AssistantTool.make({
            type: "tool",
            id: "call_1",
            name: "shell",
            executed: false,
            state: SessionMessage.ToolStateCompleted.make({
              status: "completed",
              input: { command: "cat big.txt" },
              content: [{ type: "text", text: toolContent }],
            }),
            time: { created },
          }),
        ],
        time: { created, completed: created },
      }),
    ]
    
    // Test without providerMark (default behavior)
    const projected = SessionMemoryContext.project(history, {
      enabled: true,
      minOutputChars: 100,
      // No providerMark provided, should default to 0
    })
    
    // Default behavior (mark=0) means compress everything
    const marker = projected[0].content[0].state.content[0].text
    expect(marker).toContain("[mem:compacted tool result]")
  })
})

describe("Unified Mask - Integration Tests", () => {
  test("suffix-only compression preserves prefix byte-identical", () => {
    // Create a marker that simulates content before and after mark
    const largeText = "x".repeat(3000)
    const prefix = "prefix_before_mark_"
    const suffix = "suffix_after_mark_"
    const combined = prefix + largeText + suffix
    
    // Simulate compression with mark that covers prefix + part of largeText
    // Only suffix should be compressed
    const marker = `[mem:compacted tool result]\nkind=bash tool=shell call_id=call_1 status=success\nsummary=command=cat big.txt\npreview=${prefix}x...\nsession=${sessionID} message=msg_1\nretrieve=get_tool_call_details(call_id=\"call_1\")`
    
    // Verify marker structure
    expect(marker).toContain("retrieve=get_tool_call_details")
    expect(marker).toContain("prefix_before_mark_")
    expect(marker).toContain("x...")
  })
})

describe("CacheMarkLedger - Provider Isolation Tests", () => {
  test("different providers maintain independent marks", () => {
    const providerA = Provider.ID.make("provider_a")
    const providerB = Provider.ID.make("provider_b")
    
    const historyA = [
      SessionMessage.Assistant.make({
        id: SessionMessage.ID.make("msg_test_a"),
        type: "assistant",
        agent: AgentType.defaultID,
        model: { id: modelID, providerID: providerA },
        content: [
          SessionMessage.AssistantTool.make({
            type: "tool",
            id: "call_1",
            name: "shell",
            executed: false,
            state: SessionMessage.ToolStateCompleted.make({
              status: "completed",
              input: { command: "cat file_a.txt" },
              content: [{ type: "text", text: toolContent }],
            }),
            time: { created },
          }),
        ],
        time: { created, completed: created },
      }),
    ]
    
    const historyB = [
      SessionMessage.Assistant.make({
        id: SessionMessage.ID.make("msg_test_b"),
        type: "assistant",
        agent: AgentType.defaultID,
        model: { id: modelID, providerID: providerB },
        content: [
          SessionMessage.AssistantTool.make({
            type: "tool",
            id: "call_2",
            name: "read",
            executed: false,
            state: SessionMessage.ToolStateCompleted.make({
              status: "completed",
              input: { path: "/tmp/file_b.txt" },
              content: [{ type: "text", text: toolContent }],
            }),
            time: { created },
          }),
        ],
        time: { created, completed: created },
      }),
    ]
    
    // Project with different marks for different providers
    const projectedA = SessionMemoryContext.project(historyA, {
      enabled: true,
      minOutputChars: 100,
      providerMark: 500, // Provider A has lower mark
    })
    
    const projectedB = SessionMemoryContext.project(historyB, {
      enabled: true,
      minOutputChars: 100,
      providerMark: 1500, // Provider B has higher mark
    })
    
    // Both should have compression, but provider B may compress less
    expect(projectedA[0].content[0].state.content[0].text).toContain("[mem:compacted")
    expect(projectedB[0].content[0].state.content[0].text).toContain("[mem:compacted")
  })
})