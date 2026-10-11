import { describe, expect, test } from "bun:test"
import { DateTime } from "effect"
import { Message, Model } from "@opencode-ai/llm"
import * as OpenAIChat from "@opencode-ai/llm/protocols/openai-chat"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { MemoryContext } from "@opencode-ai/core/session/memory-context"
import { toLLMMessages } from "@opencode-ai/core/session/runner/to-llm-message"
import { SessionV2 } from "@opencode-ai/core/session"

// Issue #11 p.5 — protocol pairing: MEM projection must never break the
// tool-call/tool-result contract that providers enforce (every call id has
// exactly one result), and error/interrupted/provider-executed history must
// reach the provider unchanged.
const created = DateTime.makeUnsafe(0)
const sessionID = SessionV2.ID.make("ses_protocol_pairing")
const model = Model.make({ id: "model", provider: "provider", route: OpenAIChat.route })
const id = (value: string) => SessionMessage.ID.make(`msg_${value}`)
// Canary sits in the middle: the compact marker's head/tail preview must not
// contain it, so "not.toContain" really proves the original was dropped.
const bulk = (canary: string) => `${"x".repeat(1000)}\n${canary}\n${"x".repeat(2000)}`

const user = (value: string) =>
  SessionMessage.User.make({ id: id(value), type: "user", text: "go", time: { created } })

const assistant = (value: string, content: SessionMessage.Assistant["content"]) =>
  SessionMessage.Assistant.make({
    id: id(value),
    type: "assistant",
    agent: "build",
    model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
    content,
    time: { created, completed: created },
  })

const completedTool = (args: {
  id: string
  name: string
  text: string
  structured?: Record<string, unknown>
  provider?: { executed: boolean }
}) =>
  SessionMessage.AssistantTool.make({
    type: "tool",
    id: args.id,
    name: args.name,
    ...(args.provider === undefined ? {} : { provider: args.provider }),
    state: SessionMessage.ToolStateCompleted.make({
      status: "completed",
      input: { command: "ls" },
      content: [{ type: "text", text: args.text }],
      structured: args.structured ?? {},
    }),
    time: { created, completed: created },
  })

const errorTool = (args: { id: string; name: string; message: string }) =>
  SessionMessage.AssistantTool.make({
    type: "tool",
    id: args.id,
    name: args.name,
    state: SessionMessage.ToolStateError.make({
      status: "error",
      input: { command: "ls" },
      content: [],
      structured: {},
      error: { type: "unknown", message: args.message },
    }),
    time: { created, completed: created },
  })

const history = [
  user("u1"),
  assistant("a1", [
    completedTool({ id: "call_big", name: "bash", text: bulk("BIG-ORIGINAL"), structured: { secret: "CANARY" } }),
    completedTool({ id: "call_mem", name: "find_tool_calls", text: bulk("MEM-ORIGINAL") }),
    completedTool({ id: "call_hosted", name: "web_search", text: bulk("HOSTED-ORIGINAL"), provider: { executed: true } }),
    errorTool({ id: "call_err", name: "bash", message: "boom" }),
  ]),
  SessionMessage.Shell.make({
    id: id("shell1"),
    type: "shell",
    callID: "shell-1",
    command: "cat big.log",
    output: bulk("SHELL-ORIGINAL"),
    time: { created, completed: created },
  }),
]

const projected = () =>
  MemoryContext.project(history, {
    enabled: true,
    firstDelivery: true,
    sessionID,
    // Include the memory tool in the allowlist on purpose: MEMORY_TOOL_PATTERN
    // must still refuse to compact it.
    firstDeliveryTools: "bash,find_tool_calls",
  })

const toolResults = (messages: readonly Message[]) => {
  const results = new Map<string, unknown>()
  for (const message of messages) {
    if (message.role !== "assistant" && message.role !== "tool") continue
    for (const part of message.content) {
      if (part.type === "tool-result") results.set(part.id, part.result)
    }
  }
  return results
}

const toolCalls = (messages: readonly Message[]) =>
  messages.flatMap((message) =>
    message.role === "assistant" ? message.content.flatMap((part) => (part.type === "tool-call" ? [part] : [])) : [],
  )

describe("MemoryContext protocol pairing (V2)", () => {
  test("every tool call keeps exactly one result and the compacted original is only a marker", () => {
    const messages = toLLMMessages(projected(), model)
    const calls = toolCalls(messages)
    const results = toolResults(messages)

    expect(calls.map((call) => call.id).sort()).toEqual(["call_big", "call_err", "call_hosted", "call_mem"])
    for (const call of calls) expect(results.has(call.id)).toBe(true)

    const big = results.get("call_big") as { type: string; value: string }
    expect(big.type).toBe("text")
    expect(big.value).toContain("[mem:compacted tool result]")
    expect(big.value).toContain('retrieve=get_tool_call_details(call_id="call_big")')
    expect(big.value).not.toContain("BIG-ORIGINAL")
    // structured survives in SQLite history but must not leak into the provider result
    expect(big.value).not.toContain("CANARY")

    expect(results.get("call_mem")).toEqual({ type: "text", value: expect.stringContaining("MEM-ORIGINAL") })
    expect(results.get("call_hosted")).toEqual({ type: "text", value: expect.stringContaining("HOSTED-ORIGINAL") })
    expect(results.get("call_err")).toEqual({
      type: "error",
      value: { error: { type: "unknown", message: "boom" }, content: [], structured: {} },
    })
  })

  test("compact shell output stays a user message with a working retrieval path", () => {
    const messages = toLLMMessages(projected(), model)
    const text = (message: { content: unknown } | undefined) =>
      Array.isArray(message?.content)
        ? message.content
            .flatMap((part) => (part?.type === "text" ? [part.text] : []))
            .join("")
        : String(message?.content ?? "")
    const shell = messages.find((message) => message.role === "user" && text(message).includes("compacted shell output"))
    expect(shell).toBeDefined()
    expect(text(shell)).toContain("[mem:compacted shell output]")
    expect(text(shell)).toContain('retrieve=get_tool_call_details(call_id="shell-1")')
    expect(text(shell)).not.toContain("SHELL-ORIGINAL")
  })

  test("projection is copy-on-write: SQLite-owned history stays byte-identical", () => {
    projected()
    const original = history[1]
    if (original === undefined || original.type !== "assistant") throw new Error("expected assistant")
    const big = original.content[0]
    if (big === undefined || big.type !== "tool" || big.state.status !== "completed") throw new Error("expected tool")
    const text = big.state.content[0]
    if (text === undefined || text.type !== "text") throw new Error("expected text")
    expect(text.text).toContain("BIG-ORIGINAL")
    expect(text.text.length).toBeGreaterThan(3000)
  })
})
