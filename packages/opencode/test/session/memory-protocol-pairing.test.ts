import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { MemoryContext } from "@opencode-ai/core/session/memory-context"
import { MessageV2 } from "../../src/session/message-v2"
import type { Provider } from "@/provider/provider"
import { SessionID, MessageID, PartID } from "../../src/session/schema"

// Issue #11 p.5 — protocol pairing on the production V1 path: MemoryContext.projectV1
// must keep the tool-call/tool-result contract through MessageV2.toModelMessages —
// every call id stays paired, compacted originals degrade to retrieval markers,
// and error/interrupted/pending/provider-executed history reaches the provider intact.
const sessionID = SessionID.make("session")
const providerID = ProviderV2.ID.make("test")
const model: Provider.Model = {
  id: ModelV2.ID.make("test-model"),
  providerID,
  api: {
    id: "test-model",
    url: "https://example.com",
    npm: "@ai-sdk/openai",
  },
  name: "Test Model",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 0, input: 0, output: 0 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
}

// Canary sits in the middle: the compact marker's head/tail preview must not
// contain it, so "not.toContain" really proves the original was dropped.
const bulk = (canary: string) => `${"x".repeat(1000)}\n${canary}\n${"x".repeat(2000)}`

function userInfo(id: string): SessionV1.User {
  return {
    id,
    sessionID,
    role: "user",
    time: { created: 0 },
    agent: "user",
    model: { providerID, modelID: ModelV2.ID.make("test") },
    tools: {},
    mode: "",
  } as unknown as SessionV1.User
}

function assistantInfo(id: string, parentID: string): SessionV1.Assistant {
  return {
    id,
    sessionID,
    role: "assistant",
    time: { created: 0 },
    parentID,
    modelID: model.api.id,
    providerID: model.providerID,
    mode: "",
    agent: "agent",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  } as unknown as SessionV1.Assistant
}

function basePart(messageID: string, id: string) {
  return {
    id: PartID.make(id.startsWith("prt") ? id : `prt_${id}`),
    sessionID,
    messageID: MessageID.make(messageID.startsWith("msg") ? messageID : `msg_${messageID}`),
  }
}

const input: SessionV1.WithParts[] = [
  {
    info: userInfo("u1"),
    parts: [{ ...basePart("u1", "t1"), type: "text", text: "go" }] as SessionV1.Part[],
  },
  {
    info: assistantInfo("a1", "u1"),
    parts: [
      {
        ...basePart("a1", "p-big"),
        type: "tool",
        callID: "call-1",
        tool: "bash",
        state: {
          status: "completed",
          input: { command: "ls" },
          output: bulk("BIG-ORIGINAL"),
          title: "Bash",
          metadata: {},
          time: { start: 0, end: 1 },
        },
      },
      {
        ...basePart("a1", "p-hosted"),
        type: "tool",
        callID: "call-5",
        tool: "bash",
        state: {
          status: "completed",
          input: { command: "curl" },
          output: bulk("HOSTED-ORIGINAL"),
          title: "Bash",
          metadata: {},
          time: { start: 0, end: 1 },
        },
        metadata: { providerExecuted: true },
      },
      {
        ...basePart("a1", "p-mem"),
        type: "tool",
        callID: "call-6",
        tool: "find_tool_calls",
        state: {
          status: "completed",
          input: {},
          output: bulk("MEM-ORIGINAL"),
          title: "Memory",
          metadata: {},
          time: { start: 0, end: 1 },
        },
      },
      {
        ...basePart("a1", "p-interrupted"),
        type: "tool",
        callID: "call-2",
        tool: "bash",
        state: {
          status: "error",
          input: { command: "sleep 100" },
          error: "Tool execution aborted",
          metadata: { interrupted: true, output: "partial-line" },
          time: { start: 0, end: 1 },
        },
      },
      {
        ...basePart("a1", "p-err"),
        type: "tool",
        callID: "call-3",
        tool: "bash",
        state: {
          status: "error",
          input: { command: "false" },
          error: "nope",
          metadata: {},
          time: { start: 0, end: 1 },
        },
      },
      {
        ...basePart("a1", "p-pending"),
        type: "tool",
        callID: "call-4",
        tool: "bash",
        state: {
          status: "pending",
          input: { command: "hang" },
          time: { start: 0 },
        },
      },
    ] as SessionV1.Part[],
  },
]

const projected = () =>
  MemoryContext.projectV1(input, {
    enabled: true,
    firstDelivery: true,
    // Include the memory tool in the allowlist on purpose: MEMORY_TOOL_PATTERN
    // must still refuse to compact it.
    firstDeliveryTools: "bash,find_tool_calls",
  })

type ModelMessage = { role: string; content: unknown }
const parts = (message: ModelMessage): Array<Record<string, unknown>> =>
  Array.isArray(message.content) ? (message.content as Array<Record<string, unknown>>) : []

// Provider-executed results travel inline in the assistant message; local tool
// results arrive as separate role:"tool" messages. Both shapes count as paired.
const resultText = (messages: readonly ModelMessage[], callID: string) =>
  messages
    .flatMap((message) => parts(message))
    .filter((part) => part.type === "tool-result" && part.toolCallId === callID)
    .map((part) => {
      const output = part.output
      if (typeof output === "string") return output
      if (output !== null && typeof output === "object") {
        const value = (output as { value?: unknown }).value
        if (typeof value === "string") return value
        return JSON.stringify(value ?? output)
      }
      return JSON.stringify(part)
    })
    .join("\n")

describe("MemoryContext protocol pairing (V1)", () => {
  test("projected history keeps every tool call paired with exactly one result", async () => {
    const messages = (await MessageV2.toModelMessages([...projected()], model)) as unknown as ModelMessage[]
    const callIDs = messages
      .flatMap((message) => parts(message))
      .filter((part) => part.type === "tool-call")
      .map((part) => String(part.toolCallId))
    expect(callIDs.sort()).toEqual(["call-1", "call-2", "call-3", "call-4", "call-5", "call-6"])

    const resultIDs = messages
      .flatMap((message) => parts(message))
      .filter((part) => part.type === "tool-result")
      .map((part) => String(part.toolCallId))
    for (const callID of callIDs) expect(resultIDs.filter((id) => id === callID).length).toBeGreaterThanOrEqual(1)
    // Local tools pair through a separate role:"tool" message; provider-executed
    // results stay inline with the call (hosted continuation metadata).
    for (const callID of ["call-1", "call-2", "call-3", "call-4", "call-6"])
      expect(resultIDs.filter((id) => id === callID).length).toBe(1)
    expect(
      messages.some(
        (message) =>
          message.role === "assistant" &&
          parts(message).some((part) => part.type === "tool-result" && part.toolCallId === "call-5"),
      ),
    ).toBe(true)
  })

  test("compacted original degrades to a retrieval marker without leaking the bulk", async () => {
    const messages = (await MessageV2.toModelMessages([...projected()], model)) as unknown as ModelMessage[]
    const text = resultText(messages, "call-1")
    expect(text).toContain("[mem:compacted tool result]")
    expect(text).toContain('retrieve=get_tool_call_details(call_id="call-1")')
    expect(text).not.toContain("BIG-ORIGINAL")
  })

  test("error, interrupted and pending results reach the provider untouched", async () => {
    const messages = (await MessageV2.toModelMessages([...projected()], model)) as unknown as ModelMessage[]
    expect(resultText(messages, "call-2")).toContain("partial-line")
    expect(resultText(messages, "call-3")).toContain("nope")
    expect(resultText(messages, "call-4").toLowerCase()).toContain("interrupted")
  })

  test("provider-executed and memory-tool results stay verbatim", async () => {
    const messages = (await MessageV2.toModelMessages([...projected()], model)) as unknown as ModelMessage[]
    expect(resultText(messages, "call-5")).toContain("HOSTED-ORIGINAL")
    expect(resultText(messages, "call-6")).toContain("MEM-ORIGINAL")
  })

  test("projection is copy-on-write: SQLite-owned history stays byte-identical", () => {
    projected()
    const part = input[1]?.parts[0] as { state: { output: string } }
    expect(part.state.output).toContain("BIG-ORIGINAL")
    expect(part.state.output.length).toBeGreaterThan(3000)
  })
})
