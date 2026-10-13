import { describe, expect, test } from "bun:test"
import path from "node:path"
import { DateTime } from "effect"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { MemoryContext } from "@opencode-ai/core/session/memory-context"
import { Global } from "@opencode-ai/core/global"
import { SessionV1 } from "@opencode-ai/core/v1/session"

const created = DateTime.makeUnsafe(0)
const id = (value: string) => SessionMessage.ID.make(`msg_${value}`)
const big = (size = 3000) => "x".repeat(size)

const user = (value: string) =>
  SessionMessage.User.make({ id: id(value), type: "user", text: "prompt", time: { created } })

const completedTool = (args: {
  id: string
  name: string
  content: readonly { type: "text"; text: string }[]
  input?: Record<string, unknown>
}) =>
  SessionMessage.AssistantTool.make({
    type: "tool",
    id: args.id,
    name: args.name,
    state: SessionMessage.ToolStateCompleted.make({
      status: "completed",
      input: args.input ?? {},
      content: args.content,
      structured: {},
    }),
    time: { created },
  })

const assistant = (value: string, content: SessionMessage.Assistant["content"]) =>
  SessionMessage.Assistant.make({
    id: id(value),
    type: "assistant",
    agent: "build",
    model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
    content,
    time: { created, completed: created },
  })

const compact = (messages: readonly SessionMessage.Message[], overrides?: Partial<MemoryContext.Options>) =>
  MemoryContext.project(messages, { enabled: true, minOutputChars: 100, keepRecentUserTurns: 1, ...overrides })

const toolText = (message: SessionMessage.Message, index = 0) => {
  if (message.type !== "assistant") throw new Error("expected assistant")
  const item = message.content[index]
  if (item === undefined || item.type !== "tool") throw new Error("expected tool")
  if (item.state.status !== "completed") throw new Error("expected completed")
  const text = item.state.content[0]
  if (text === undefined || text.type !== "text") throw new Error("expected text content")
  return text.text
}

describe("MemoryContext.project", () => {
  test("disabled flag returns identical array", () => {
    const messages = [user("u1"), assistant("a1", [completedTool({ id: "call_1", name: "bash", content: [{ type: "text", text: big() }] })])]
    expect(MemoryContext.project(messages, { enabled: false })).toBe(messages)
  })

  test("compacts old bash result into retrieval marker", () => {
    const messages = [user("u1"), assistant("a1", [completedTool({ id: "call_1", name: "bash", content: [{ type: "text", text: big() }], input: { command: "npm test" } })]), user("u2")]
    const projected = compact(messages)
    const marker = toolText(projected[1]!)
    expect(marker).toContain("[mem:compacted tool result]")
    expect(marker).toContain("kind=bash")
    expect(marker).toContain("call_id=call_1")
    expect(marker).toContain("command=npm test")
    expect(marker).toContain("get_tool_call_details")
    expect(marker.length).toBeLessThan(1000)
  })

  test("keeps original messages untouched", () => {
    const messages = [user("u1"), assistant("a1", [completedTool({ id: "call_1", name: "bash", content: [{ type: "text", text: big() }] })]), user("u2")]
    const before = toolText(messages[1]!)
    compact(messages)
    expect(toolText(messages[1]!)).toBe(before)
  })

  test("never compacts the protected recent turn", () => {
    const messages = [user("u1"), assistant("a1", [completedTool({ id: "call_1", name: "bash", content: [{ type: "text", text: big() }] })])]
    const projected = compact(messages)
    expect(toolText(projected[1]!)).toBe(big())
  })

  test("compacts inside a single user turn but keeps the assistant working set verbatim", () => {
    const messages = [
      user("u1"),
      assistant("a1", [completedTool({ id: "call_1", name: "read", content: [{ type: "text", text: big() }], input: { path: "file1.txt" } })]),
      assistant("a2", [completedTool({ id: "call_2", name: "read", content: [{ type: "text", text: big() }], input: { path: "file2.txt" } })]),
      assistant("a3", [completedTool({ id: "call_3", name: "bash", content: [{ type: "text", text: big() }], input: { command: "wc -l file2.txt" } })]),
    ]
    const projected = compact(messages, { midTurn: true })
    expect(toolText(projected[1]!)).toContain("[mem:compacted tool result]")
    expect(toolText(projected[1]!)).toContain("call_id=call_1")
    expect(toolText(projected[1]!)).toContain("kind=generic")
    expect(toolText(projected[2]!)).toBe(big())
    expect(toolText(projected[3]!)).toBe(big())
  })

  test("leaves a single user turn intact by default to keep the prefix cache stable", () => {
    const messages = [
      user("u1"),
      assistant("a1", [completedTool({ id: "call_1", name: "read", content: [{ type: "text", text: big() }], input: { path: "file1.txt" } })]),
      assistant("a2", [completedTool({ id: "call_2", name: "read", content: [{ type: "text", text: big() }], input: { path: "file2.txt" } })]),
      assistant("a3", [completedTool({ id: "call_3", name: "bash", content: [{ type: "text", text: big() }], input: { command: "wc -l file2.txt" } })]),
    ]
    expect(JSON.stringify(compact(messages))).toBe(JSON.stringify(messages))
  })

  test("still compacts previous user turns when mid-turn compression is off", () => {
    const messages = [
      user("u1"),
      assistant("a1", [completedTool({ id: "call_1", name: "bash", content: [{ type: "text", text: big() }], input: { command: "npm test" } })]),
      user("u2"),
      assistant("a2", [completedTool({ id: "call_2", name: "bash", content: [{ type: "text", text: big() }], input: { command: "npm run build" } })]),
      user("u3"),
    ]
    const projected = compact(messages, { keepRecentUserTurns: 2 })
    expect(toolText(projected[1]!)).toContain("[mem:compacted tool result]")
    expect(toolText(projected[1]!)).toContain("call_id=call_1")
    expect(toolText(projected[3]!)).toBe(big())
  })

  test("OPENCODE_MEMORY_MIDTURN re-enables the sliding working-set window", () => {
    process.env["OPENCODE_MEMORY_MIDTURN"] = "1"
    try {
      const messages = [
        user("u1"),
        assistant("a1", [completedTool({ id: "call_1", name: "read", content: [{ type: "text", text: big() }], input: { path: "file1.txt" } })]),
        assistant("a2", [completedTool({ id: "call_2", name: "read", content: [{ type: "text", text: big() }], input: { path: "file2.txt" } })]),
        assistant("a3", [completedTool({ id: "call_3", name: "read", content: [{ type: "text", text: big() }], input: { path: "file3.txt" } })]),
      ]
      expect(toolText(compact(messages)[1]!)).toContain("[mem:compacted tool result]")
    } finally {
      delete process.env["OPENCODE_MEMORY_MIDTURN"]
    }
  })

  test("does not compact failed tool results", () => {
    const failed = SessionMessage.AssistantTool.make({
      type: "tool",
      id: "call_err",
      name: "bash",
      state: SessionMessage.ToolStateError.make({
        status: "error",
        input: {},
        content: [{ type: "text", text: big() }],
        structured: {},
        error: { type: "unknown", message: "boom" },
      }),
      time: { created },
    })
    const messages = [user("u1"), assistant("a1", [failed]), user("u2")]
    const projected = compact(messages)
    const item = (projected[1] as SessionMessage.Assistant).content[0]
    if (item === undefined || item.type !== "tool" || item.state.status !== "error") throw new Error("expected error tool")
    expect(item.state.content[0]).toEqual({ type: "text", text: big() })
  })

  test("detects url and artifact kinds", () => {
    const messages = [
      user("u1"),
      assistant("a1", [
        completedTool({ id: "call_u", name: "webfetch", content: [{ type: "text", text: big() }], input: { url: "https://example.com" } }),
      ]),
      assistant("a2", [
        completedTool({ id: "call_j", name: "read", content: [{ type: "text", text: big() }], input: { path: "docs/report.json" } }),
      ]),
      user("u2"),
    ]
    // batchSize 1 keeps the sliding boundary so both old turns compact regardless of parity.
    const projected = compact(messages, { batchSize: 1 })
    expect(toolText(projected[1]!)).toContain("kind=url")
    expect(toolText(projected[1]!)).toContain("url=https://example.com")
    expect(toolText(projected[2]!)).toContain("kind=artifact")
    expect(toolText(projected[2]!)).toContain("path=docs/report.json")
  })

  test("never compacts memory tools", () => {
    const messages = [
      user("u1"),
      assistant("a1", [completedTool({ id: "call_m", name: "search_operational_memory", content: [{ type: "text", text: big() }] })]),
      user("u2"),
      assistant("a2", [completedTool({ id: "call_p", name: "find_pii", content: [{ type: "text", text: big() }] })]),
      user("u3"),
    ]
    const projected = compact(messages)
    expect(toolText(projected[1]!)).toBe(big())
    expect(toolText(projected[3]!)).toBe(big())
  })

  test("compacts large shell output", () => {
    const shell = SessionMessage.Shell.make({
      id: id("sh1"),
      type: "shell",
      callID: "call_sh",
      command: "npm run build",
      output: big(),
      time: { created },
    })
    const messages = [user("u1"), shell, user("u2")]
    const projected = compact(messages)
    const message = projected[1]
    if (message === undefined || message.type !== "shell") throw new Error("expected shell")
    expect(message.output).toContain("[mem:compacted shell output]")
    expect(message.output).toContain("command=npm run build")
    expect(message.command).toBe("npm run build")
  })

  test("respects minOutputChars", () => {
    const messages = [user("u1"), assistant("a1", [completedTool({ id: "call_s", name: "bash", content: [{ type: "text", text: "short" }] })]), user("u2")]
    const projected = compact(messages, { minOutputChars: 2000 })
    expect(toolText(projected[1]!)).toBe("short")
  })

  test("tags PII categories in tool markers", () => {
    const text = `${big()} contact vova@example.com card 4111 1111 1111 1111`
    const messages = [user("u1"), assistant("a1", [completedTool({ id: "call_p", name: "bash", content: [{ type: "text", text }] })]), user("u2")]
    const marker = toolText(compact(messages)[1]!)
    expect(marker).toContain("pii=email,credit_card")
    expect(marker).toContain("retrieve=get_tool_call_details")
  })

  test("omits pii tag for clean output", () => {
    const messages = [user("u1"), assistant("a1", [completedTool({ id: "call_c", name: "bash", content: [{ type: "text", text: big() }] })]), user("u2")]
    expect(toolText(compact(messages)[1]!)).not.toContain("pii=")
  })

  test("tags PII in compacted shell output", () => {
    const shell = SessionMessage.Shell.make({
      id: id("sh2"),
      type: "shell",
      callID: "call_sh2",
      command: "cat contacts.txt",
      output: `${big()}\nadmin@site.org`,
      time: { created },
    })
    const messages = [user("u1"), shell, user("u2")]
    const message = compact(messages)[1]
    if (message === undefined || message.type !== "shell") throw new Error("expected shell")
    expect(message.output).toContain("pii=email")
  })

  test("redacts API keys from tool marker preview", () => {
    const secret = "sk-proj-abcdef1234567890ABCDEF"
    const messages = [
      user("u1"),
      assistant("a1", [completedTool({ id: "call_r", name: "bash", content: [{ type: "text", text: `${big()} token ${secret}` }] })]),
      user("u2"),
    ]
    const marker = toolText(compact(messages)[1]!)
    expect(marker).not.toContain(secret)
    expect(marker).toContain("[REDACTED:api_key]")
    expect(marker).toContain("pii=api_key")
  })

  test("redacts secrets in shell marker command and preview", () => {
    const token = "ghp_abcdefghijklmnopqrstuv123456"
    const shell = SessionMessage.Shell.make({
      id: id("sh3"),
      type: "shell",
      callID: "call_sh3",
      command: `curl -H "Authorization: Bearer ${token}" https://api.example.com`,
      output: `${big()}\nfailed for ${token}`,
      time: { created },
    })
    const messages = [user("u1"), shell, user("u2")]
    const message = compact(messages)[1]
    if (message === undefined || message.type !== "shell") throw new Error("expected shell")
    expect(message.output).not.toContain(token)
    expect(message.output).toContain("[REDACTED:api_key]")
    expect(message.output).toContain("[mem:compacted shell output]")
    expect(message.command).toContain("[REDACTED:bearer]")
    expect(message.command).not.toContain(token)
  })

  test("redacts secret URL params in url kind summary", () => {
    const messages = [
      user("u1"),
      assistant("a1", [
        completedTool({
          id: "call_ur",
          name: "webfetch",
          content: [{ type: "text", text: big() }],
          input: { url: "https://api.example.com/data?api_key=abcdef1234567890&limit=5" },
        }),
      ]),
      user("u2"),
    ]
    const marker = toolText(compact(messages)[1]!)
    expect(marker).not.toContain("abcdef1234567890")
    expect(marker).toContain("api_key=[REDACTED:url_secret]")
    expect(marker).toContain("limit=5")
  })
})

const v1sid = "ses_v1_test"
const v1partBase = (messageID: string, id: string) => ({
  id: `prt_${id}`,
  sessionID: v1sid,
  messageID: `msg_${messageID}`,
})

const v1user = (value: string): SessionV1.WithParts => ({
  info: {
    id: `msg_${value}`,
    sessionID: v1sid,
    role: "user",
    time: { created: 0 },
    agent: "user",
    model: { providerID: "p", modelID: "m" },
  } as unknown as SessionV1.User,
  parts: [{ ...v1partBase(value, `${value}p`), type: "text", text: "prompt" }] as SessionV1.Part[],
})

const v1assistant = (value: string, parts: SessionV1.Part[]): SessionV1.WithParts => ({
  info: {
    id: `msg_${value}`,
    sessionID: v1sid,
    role: "assistant",
    time: { created: 0, completed: 0 },
    parentID: "msg_parent",
    modelID: "m",
    providerID: "p",
    mode: "build",
    agent: "build",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  } as unknown as SessionV1.Assistant,
  parts,
})

const v1tool = (args: {
  id: string
  tool: string
  output: string
  input?: Record<string, unknown>
  status?: string
  metadata?: Record<string, unknown>
}): SessionV1.Part =>
  ({
    ...v1partBase("a", args.id),
    type: "tool",
    callID: args.id,
    tool: args.tool,
    state:
      args.status === "error"
        ? { status: "error", input: args.input ?? {}, error: "boom", time: { start: 0, end: 1 } }
        : {
            status: "completed",
            input: args.input ?? {},
            output: args.output,
            title: args.tool,
            metadata: {},
            time: { start: 0, end: 1 },
          },
    ...(args.metadata === undefined ? {} : { metadata: args.metadata }),
  }) as unknown as SessionV1.Part

const v1toolText = (message: SessionV1.WithParts, index = 0) => {
  const part = message.parts[index]
  if (part === undefined || part.type !== "tool" || part.state.status !== "completed")
    throw new Error("expected completed tool")
  return part.state.output
}

const compactV1 = (messages: readonly SessionV1.WithParts[], overrides?: Partial<MemoryContext.Options>) =>
  MemoryContext.projectV1(messages, { enabled: true, minOutputChars: 100, keepRecentUserTurns: 1, ...overrides })

describe("MemoryContext.projectV1", () => {
  test("measureV1 reports content-free sizes for default and cache-preserving projections", () => {
    const messages = [
      v1user("u1"),
      v1assistant("a1", [v1tool({ id: "call_1", tool: "bash", output: `PRIVATE-${big()}` })]),
      v1user("u2"),
      v1assistant("a2", [v1tool({ id: "call_2", tool: "bash", output: `LATEST-${big()}` })]),
    ]
    const raw = MemoryContext.measureV1(messages)
    const defaultProjection = MemoryContext.projectV1(messages, {
      enabled: true,
      firstDelivery: true,
      firstDeliveryMinChars: 100,
    })
    const cachePreservingMask = MemoryContext.projectV1(messages, {
      enabled: true,
      firstDelivery: true,
      firstDeliveryMinChars: 100,
      markIndex: 3,
    })
    const defaultStats = MemoryContext.measureV1(defaultProjection)
    const maskedStats = MemoryContext.measureV1(cachePreservingMask)

    expect(raw.messageCount).toBe(4)
    expect(raw.completedToolOutputs).toBe(2)
    expect(raw.completedToolOutputChars).toBe(`PRIVATE-${big()}`.length + `LATEST-${big()}`.length)
    expect(raw.outputSizes.map((item) => [item.callID, item.tool, item.chars])).toEqual([
      ["call_1", "bash", `PRIVATE-${big()}`.length],
      ["call_2", "bash", `LATEST-${big()}`.length],
    ])
    expect(raw.historyJsonBytes).toBeGreaterThan(raw.completedToolOutputChars)
    expect(defaultStats.completedToolOutputChars).toBeLessThan(maskedStats.completedToolOutputChars)
    expect(maskedStats.completedToolOutputChars).toBeLessThan(raw.completedToolOutputChars)
    expect(defaultStats.historyJsonBytes).toBeLessThan(maskedStats.historyJsonBytes)
    expect(maskedStats.historyJsonBytes).toBeLessThan(raw.historyJsonBytes)
    expect(JSON.stringify(raw)).not.toContain("PRIVATE-")
    expect(JSON.stringify(raw)).not.toContain("LATEST-")
  })

  test("disabled flag returns identical array", () => {
    const messages = [v1user("u1"), v1assistant("a1", [v1tool({ id: "call_1", tool: "bash", output: big() })])]
    expect(MemoryContext.projectV1(messages, { enabled: false })).toBe(messages)
  })

  test("compacts old V1 tool output into retrieval marker", () => {
    const messages = [
      v1user("u1"),
      v1assistant("a1", [v1tool({ id: "call_1", tool: "bash", output: big(), input: { command: "npm test" } })]),
      v1user("u2"),
    ]
    const marker = v1toolText(compactV1(messages)[1]!)
    expect(marker).toContain("[mem:compacted tool result]")
    expect(marker).toContain("kind=bash")
    expect(marker).toContain("call_id=call_1")
    expect(marker).toContain("command=npm test")
    expect(marker).toContain("retrieve=get_tool_call_details")
    expect(marker.length).toBeLessThan(1000)
  })

  test("keeps V1 originals untouched", () => {
    const messages = [
      v1user("u1"),
      v1assistant("a1", [v1tool({ id: "call_1", tool: "bash", output: big() })]),
      v1user("u2"),
    ]
    const before = v1toolText(messages[1]!)
    compactV1(messages)
    expect(v1toolText(messages[1]!)).toBe(before)
  })

  test("never compacts the protected recent V1 turn", () => {
    const messages = [v1user("u1"), v1assistant("a1", [v1tool({ id: "call_1", tool: "bash", output: big() })])]
    expect(v1toolText(compactV1(messages)[1]!)).toBe(big())
  })

  test("compacts inside a single V1 user turn but keeps the assistant working set verbatim", () => {
    const messages = [
      v1user("u1"),
      v1assistant("a1", [v1tool({ id: "call_1", tool: "read", output: big(), input: { path: "file1.txt" } })]),
      v1assistant("a2", [v1tool({ id: "call_2", tool: "read", output: big(), input: { path: "file2.txt" } })]),
      v1assistant("a3", [v1tool({ id: "call_3", tool: "bash", output: big(), input: { command: "wc -l file2.txt" } })]),
    ]
    const projected = compactV1(messages, { midTurn: true })
    expect(v1toolText(projected[1]!)).toContain("[mem:compacted tool result]")
    expect(v1toolText(projected[1]!)).toContain("call_id=call_1")
    expect(v1toolText(projected[1]!)).toContain("retrieve=get_tool_call_details")
    expect(v1toolText(projected[2]!)).toBe(big())
    expect(v1toolText(projected[3]!)).toBe(big())
  })

  test("does not compact failed V1 tool results", () => {
    const messages = [
      v1user("u1"),
      v1assistant("a1", [v1tool({ id: "call_err", tool: "bash", output: big(), status: "error" })]),
      v1user("u2"),
    ]
    const part = compactV1(messages)[1]!.parts[0]!
    if (part.type !== "tool" || part.state.status !== "error") throw new Error("expected error tool")
    expect(part.state.error).toBe("boom")
  })

  test("does not compact provider-executed V1 tools", () => {
    const messages = [
      v1user("u1"),
      v1assistant("a1", [
        v1tool({ id: "call_pe", tool: "bash", output: big(), metadata: { providerExecuted: true } }),
      ]),
      v1user("u2"),
    ]
    expect(v1toolText(compactV1(messages)[1]!)).toBe(big())
  })

  test("does not compact memory tools in V1", () => {
    const messages = [
      v1user("u1"),
      v1assistant("a1", [v1tool({ id: "call_m", tool: "get_tool_call_details", output: big() })]),
      v1user("u2"),
      v1assistant("a2", [v1tool({ id: "call_p", tool: "find_pii", output: big() })]),
      v1user("u3"),
    ]
    expect(v1toolText(compactV1(messages)[1]!)).toBe(big())
    expect(v1toolText(compactV1(messages)[3]!)).toBe(big())
  })

  test("does not recompact already compacted V1 outputs", () => {
    const messages = [
      v1user("u1"),
      v1assistant("a1", [v1tool({ id: "call_c", tool: "bash", output: "[Old tool result content cleared]" })]),
      v1user("u2"),
    ]
    expect(v1toolText(compactV1(messages)[1]!)).toBe("[Old tool result content cleared]")
  })

  test("respects minOutputChars in V1", () => {
    const messages = [
      v1user("u1"),
      v1assistant("a1", [v1tool({ id: "call_s", tool: "bash", output: "short" })]),
      v1user("u2"),
    ]
    expect(v1toolText(compactV1(messages, { minOutputChars: 2000 })[1]!)).toBe("short")
  })

  test("detects url and artifact kinds in V1", () => {
    const messages = [
      v1user("u1"),
      v1assistant("a1", [
        v1tool({ id: "call_u", tool: "webfetch", output: big(), input: { url: "https://example.com" } }),
      ]),
      v1assistant("a2", [v1tool({ id: "call_j", tool: "read", output: big(), input: { path: "docs/report.json" } })]),
      v1user("u2"),
    ]
    const projected = compactV1(messages, { batchSize: 1 })
    expect(v1toolText(projected[1]!)).toContain("kind=url")
    expect(v1toolText(projected[1]!)).toContain("url=https://example.com")
    expect(v1toolText(projected[2]!)).toContain("kind=artifact")
    expect(v1toolText(projected[2]!)).toContain("path=docs/report.json")
  })

  test("tags PII in V1 markers", () => {
    const messages = [
      v1user("u1"),
      v1assistant("a1", [
        v1tool({ id: "call_p", tool: "bash", output: `${big()} contact vova@example.com card 4111 1111 1111 1111` }),
      ]),
      v1user("u2"),
    ]
    const marker = v1toolText(compactV1(messages)[1]!)
    expect(marker).toContain("pii=email,credit_card")
    expect(marker).toContain("retrieve=get_tool_call_details")
  })

  test("redacts API keys in V1 markers", () => {
    const secret = "sk-proj-abcdef1234567890ABCDEF"
    const messages = [
      v1user("u1"),
      v1assistant("a1", [v1tool({ id: "call_r", tool: "bash", output: `${big()} key ${secret}` })]),
      v1user("u2"),
    ]
    const marker = v1toolText(compactV1(messages)[1]!)
    expect(marker).not.toContain(secret)
    expect(marker).toContain("[REDACTED:api_key]")
    expect(marker).toContain("pii=api_key")
    expect(marker).toContain("retrieve=get_tool_call_details")
  })
})

// Issue #23: compact at first delivery — the projected prefix is append-only
// (marker is a pure function of the stored original), so the provider prefix
// cache sees zero invalidations and uncached bulk never leaves SQLite.
describe("MemoryContext first-delivery", () => {
  const delivery = (messages: readonly SessionMessage.Message[], overrides?: Partial<MemoryContext.Options>) =>
    MemoryContext.project(messages, {
      enabled: true,
      firstDelivery: true,
      firstDeliveryMinChars: 100,
      keepRecentUserTurns: 1,
      ...overrides,
    })

  test("compacts the freshest result that boundary mode protects", () => {
    const messages = [
      user("u1"),
      assistant("a1", [completedTool({ id: "call_1", name: "bash", content: [{ type: "text", text: big() }], input: { command: "npm test" } })]),
    ]
    expect(toolText(compact(messages)[1]!)).toBe(big())
    const marker = toolText(delivery(messages)[1]!)
    expect(marker).toContain("[mem:compacted tool result]")
    expect(marker).toContain("call_id=call_1")
    expect(marker).toContain("retrieve=get_tool_call_details")
  })

  test("projects byte-identical prefix as the turn grows (append-only)", () => {
    const grown = delivery(growth(5))
    expect(JSON.stringify(delivery(growth(6)).slice(0, grown.length))).toBe(JSON.stringify(grown))
    expect(toolText(grown[1]!)).toContain("[mem:compacted tool result]")
  })

  test("projects the same input identically on repeated calls", () => {
    const messages = growth(4)
    expect(JSON.stringify(delivery(messages))).toBe(JSON.stringify(delivery(messages)))
  })

  test("only allowlisted tools are compacted", () => {
    const messages = [
      user("u1"),
      assistant("a1", [completedTool({ id: "call_e", name: "edit", content: [{ type: "text", text: big() }] })]),
      assistant("a2", [completedTool({ id: "call_b", name: "bash", content: [{ type: "text", text: big() }], input: { command: "ls" } })]),
    ]
    const projected = delivery(messages)
    expect(toolText(projected[1]!)).toBe(big())
    expect(toolText(projected[2]!)).toContain("[mem:compacted tool result]")
  })

  test("compacts large shell output at first delivery", () => {
    const shell = SessionMessage.Shell.make({
      id: id("sh1"),
      type: "shell",
      callID: "call_sh",
      command: "npm run build",
      output: big(),
      time: { created },
    })
    const message = delivery([user("u1"), shell])[1]
    if (message === undefined || message.type !== "shell") throw new Error("expected shell")
    expect(message.output).toContain("[mem:compacted shell output]")
    expect(message.output).toContain("retrieve=get_tool_call_details")
  })

  test("shell without callID stays verbatim (no retrieval path)", () => {
    const shell = SessionMessage.Shell.make({
      id: id("sh2"),
      type: "shell",
      callID: "",
      command: "npm run build",
      output: big(),
      time: { created },
    })
    const message = delivery([user("u1"), shell])[1]
    if (message === undefined || message.type !== "shell") throw new Error("expected shell")
    expect(message.output).toBe(big())
  })

  test("does not compact failed results in first-delivery mode", () => {
    const failed = SessionMessage.AssistantTool.make({
      type: "tool",
      id: "call_err",
      name: "bash",
      state: SessionMessage.ToolStateError.make({
        status: "error",
        input: {},
        content: [{ type: "text", text: big() }],
        structured: {},
        error: { type: "unknown", message: "boom" },
      }),
      time: { created },
    })
    const item = (delivery([user("u1"), assistant("a1", [failed])])[1] as SessionMessage.Assistant).content[0]
    if (item === undefined || item.type !== "tool" || item.state.status !== "error") throw new Error("expected error tool")
    expect(item.state.content[0]).toEqual({ type: "text", text: big() })
  })

  test("firstDeliveryMinChars option overrides the threshold", () => {
    const messages = [user("u1"), assistant("a1", [completedTool({ id: "call_s", name: "bash", content: [{ type: "text", text: "short" }] })])]
    expect(toolText(delivery(messages, { firstDeliveryMinChars: 2000 })[1]!)).toBe("short")
  })

  test("OPENCODE_MEMORY_FIRST_DELIVERY_MIN_CHARS env overrides the threshold", () => {
    process.env["OPENCODE_MEMORY_FIRST_DELIVERY_MIN_CHARS"] = "2000"
    try {
      const messages = [user("u1"), assistant("a1", [completedTool({ id: "call_s", name: "bash", content: [{ type: "text", text: "short" }] })])]
      expect(toolText(delivery(messages)[1]!)).toBe("short")
    } finally {
      delete process.env["OPENCODE_MEMORY_FIRST_DELIVERY_MIN_CHARS"]
    }
  })

  test("OPENCODE_MEMORY_FIRST_DELIVERY_TOOLS env overrides the allowlist", () => {
    process.env["OPENCODE_MEMORY_FIRST_DELIVERY_TOOLS"] = "webfetch"
    try {
      const messages = [
        user("u1"),
        assistant("a1", [completedTool({ id: "call_b", name: "bash", content: [{ type: "text", text: big() }], input: { command: "ls" } })]),
        assistant("a2", [completedTool({ id: "call_w", name: "webfetch", content: [{ type: "text", text: big() }], input: { url: "https://example.com" } })]),
      ]
      const projected = delivery(messages)
      expect(toolText(projected[1]!)).toBe(big())
      expect(toolText(projected[2]!)).toContain("kind=url")
    } finally {
      delete process.env["OPENCODE_MEMORY_FIRST_DELIVERY_TOOLS"]
    }
  })

  test("OPENCODE_MEMORY_FIRST_DELIVERY env flag enables the mode", () => {
    process.env["OPENCODE_MEMORY_FIRST_DELIVERY"] = "1"
    process.env["OPENCODE_MEMORY_FIRST_DELIVERY_MIN_CHARS"] = "100"
    try {
      const messages = [user("u1"), assistant("a1", [completedTool({ id: "call_1", name: "bash", content: [{ type: "text", text: big() }], input: { command: "npm test" } })])]
      const projected = MemoryContext.project(messages, { enabled: true })
      expect(toolText(projected[1]!)).toContain("[mem:compacted tool result]")
    } finally {
      delete process.env["OPENCODE_MEMORY_FIRST_DELIVERY"]
      delete process.env["OPENCODE_MEMORY_FIRST_DELIVERY_MIN_CHARS"]
    }
  })

  test("flag off keeps boundary behavior byte-identical", () => {
    const messages = [user("u1"), assistant("a1", [completedTool({ id: "call_1", name: "bash", content: [{ type: "text", text: big() }], input: { command: "npm test" } })])]
    expect(JSON.stringify(delivery(messages, { firstDelivery: false, minOutputChars: 100 }))).toBe(JSON.stringify(compact(messages)))
  })

  // Issue #29 P1: the ledger flag implies first-delivery — bare CACHE_MARK in
  // boundary mode degenerates to no-compaction once the mark covers the
  // verbatim prefix, so B0 is the ledger policy, not a second flag.
  test("OPENCODE_MEMORY_CACHE_MARK implies first-delivery without the FD flag", () => {
    process.env["OPENCODE_MEMORY_CACHE_MARK"] = "1"
    process.env["OPENCODE_MEMORY_FIRST_DELIVERY_MIN_CHARS"] = "100"
    try {
      const messages = [user("u1"), assistant("a1", [completedTool({ id: "call_1", name: "bash", content: [{ type: "text", text: big() }], input: { command: "npm test" } })])]
      const projected = MemoryContext.project(messages, { enabled: true })
      expect(toolText(projected[1]!)).toContain("[mem:compacted tool result]")
    } finally {
      delete process.env["OPENCODE_MEMORY_CACHE_MARK"]
      delete process.env["OPENCODE_MEMORY_FIRST_DELIVERY_MIN_CHARS"]
    }
  })

  test("explicit firstDelivery:false overrides the ledger policy", () => {
    process.env["OPENCODE_MEMORY_CACHE_MARK"] = "1"
    try {
      // Single user turn: boundary mode keeps everything verbatim, so the
      // override is observable as byte-identity with the raw history.
      const messages = [user("u1"), assistant("a1", [completedTool({ id: "call_1", name: "bash", content: [{ type: "text", text: big() }], input: { command: "npm test" } })])]
      const projected = MemoryContext.project(messages, { enabled: true, firstDelivery: false, minOutputChars: 100 })
      expect(JSON.stringify(projected)).toBe(JSON.stringify(messages))
    } finally {
      delete process.env["OPENCODE_MEMORY_CACHE_MARK"]
    }
  })

  test("V1 compacts the freshest result that boundary mode protects", () => {
    const messages = [v1user("u1"), v1assistant("a1", [v1tool({ id: "call_1", tool: "bash", output: big(), input: { command: "npm test" } })])]
    expect(v1toolText(compactV1(messages)[1]!)).toBe(big())
    const marker = v1toolText(
      MemoryContext.projectV1(messages, { enabled: true, firstDelivery: true, firstDeliveryMinChars: 100 })[1]!,
    )
    expect(marker).toContain("[mem:compacted tool result]")
    expect(marker).toContain("retrieve=get_tool_call_details")
  })

  test("V1: OPENCODE_MEMORY_CACHE_MARK implies first-delivery", () => {
    process.env["OPENCODE_MEMORY_CACHE_MARK"] = "1"
    process.env["OPENCODE_MEMORY_FIRST_DELIVERY_MIN_CHARS"] = "100"
    try {
      const messages = [v1user("u1"), v1assistant("a1", [v1tool({ id: "call_1", tool: "bash", output: big(), input: { command: "npm test" } })])]
      const marker = v1toolText(MemoryContext.projectV1(messages, { enabled: true })[1]!)
      expect(marker).toContain("[mem:compacted tool result]")
    } finally {
      delete process.env["OPENCODE_MEMORY_CACHE_MARK"]
      delete process.env["OPENCODE_MEMORY_FIRST_DELIVERY_MIN_CHARS"]
    }
  })

  test("V1 projects byte-identical prefix as the turn grows", () => {
    const v1growth = (steps: number) => {
      const messages: SessionV1.WithParts[] = [v1user("u0")]
      for (let i = 1; i <= steps; i++)
        messages.push(
          v1assistant(`a${i}`, [v1tool({ id: `call_${i}`, tool: "bash", output: big(), input: { command: `step ${i}` } })]),
        )
      return messages
    }
    const options = { enabled: true, firstDelivery: true, firstDeliveryMinChars: 100 }
    const grown = MemoryContext.projectV1(v1growth(5), options)
    expect(JSON.stringify(MemoryContext.projectV1(v1growth(6), options).slice(0, grown.length))).toBe(
      JSON.stringify(grown),
    )
    expect(v1toolText(grown[1]!)).toContain("[mem:compacted tool result]")
  })

  test("V1 respects the tool allowlist", () => {
    const messages = [
      v1user("u1"),
      v1assistant("a1", [v1tool({ id: "call_e", tool: "edit", output: big() })]),
      v1assistant("a2", [v1tool({ id: "call_b", tool: "bash", output: big(), input: { command: "ls" } })]),
    ]
    const projected = MemoryContext.projectV1(messages, { enabled: true, firstDelivery: true, firstDeliveryMinChars: 100 })
    expect(v1toolText(projected[1]!)).toBe(big())
    expect(v1toolText(projected[2]!)).toContain("[mem:compacted tool result]")
  })

  test("V1 does not compact failed results in first-delivery mode", () => {
    const messages = [v1user("u1"), v1assistant("a1", [v1tool({ id: "call_err", tool: "bash", output: big(), status: "error" })])]
    const part = MemoryContext.projectV1(messages, { enabled: true, firstDelivery: true, firstDeliveryMinChars: 100 })[1]!.parts[0]!
    if (part.type !== "tool" || part.state.status !== "error") throw new Error("expected error tool")
    expect(part.state.error).toBe("boom")
  })
})

// Issue #20: mid-turn compaction edits the projected history at an early
// position on every provider step, which invalidates the provider prefix
// cache and re-sends the full tail uncached. The boundary therefore moves
// in batches: between jumps the projection must be byte-identical.
const growth = (steps: number) => {
  const messages: SessionMessage.Message[] = [user("u0")]
  for (let i = 1; i <= steps; i++)
    messages.push(
      assistant(`a${i}`, [
        completedTool({ id: `call_${i}`, name: "bash", content: [{ type: "text", text: big() }], input: { command: `step ${i}` } }),
      ]),
    )
  return messages
}

const markerIDs = (messages: readonly SessionMessage.Message[]) =>
  new Set(
    messages
      .filter((message): message is SessionMessage.Assistant => message.type === "assistant")
      .flatMap((message) => message.content)
      .flatMap((item) => (item.type === "tool" && item.state.status === "completed" ? item.state.content : []))
      .flatMap((part) => (part.type === "text" && part.text.startsWith("[mem:compacted") ? [/call_id=(\S+)/.exec(part.text)?.[1]] : []))
      .filter((value): value is string => value !== undefined),
  )

describe("MemoryContext cache-stable boundary", () => {
  const compactMidTurn = (messages: readonly SessionMessage.Message[], overrides?: Partial<MemoryContext.Options>) =>
    compact(messages, { midTurn: true, ...overrides })

  test("projected prefix is byte-identical between batch jumps", () => {
    const stable = compactMidTurn(growth(5))
    expect(JSON.stringify(compactMidTurn(growth(6)).slice(0, stable.length))).toBe(JSON.stringify(stable))
    expect(toolText(stable[1]!)).toContain("[mem:compacted tool result]")
  })

  test("batchSize 1 reproduces the sliding boundary that changes the prefix every step", () => {
    const sliding = compactMidTurn(growth(5), { batchSize: 1 })
    expect(JSON.stringify(compactMidTurn(growth(6), { batchSize: 1 }).slice(0, sliding.length))).not.toBe(
      JSON.stringify(sliding),
    )
  })

  test("boundary is monotone: compacted results stay compacted as the turn grows", () => {
    let previous = new Set<string>()
    for (let steps = 3; steps <= 10; steps++) {
      const markers = markerIDs(compactMidTurn(growth(steps)))
      for (const callID of previous) expect(markers.has(callID)).toBe(true)
      previous = markers
    }
    expect(previous.size).toBeGreaterThan(0)
  })

  test("OPENCODE_MEMORY_BATCH_SIZE overrides the default batch", () => {
    process.env["OPENCODE_MEMORY_BATCH_SIZE"] = "1"
    try {
      expect(JSON.stringify(compactMidTurn(growth(6)))).toBe(JSON.stringify(compactMidTurn(growth(6), { batchSize: 1 })))
    } finally {
      delete process.env["OPENCODE_MEMORY_BATCH_SIZE"]
    }
  })

  test("V1 projected prefix is byte-identical between batch jumps", () => {
    const v1growth = (steps: number) => {
      const messages: SessionV1.WithParts[] = [v1user("u0")]
      for (let i = 1; i <= steps; i++)
        messages.push(
          v1assistant(`a${i}`, [v1tool({ id: `call_${i}`, tool: "bash", output: big(), input: { command: `step ${i}` } })]),
        )
      return messages
    }
    const stable = compactV1(v1growth(5), { midTurn: true })
    expect(JSON.stringify(compactV1(v1growth(6), { midTurn: true }).slice(0, stable.length))).toBe(
      JSON.stringify(stable),
    )
    expect(v1toolText(stable[1]!)).toContain("[mem:compacted tool result]")
    expect(v1toolText(stable[1]!)).toContain("retrieve=get_tool_call_details")
  })
})

// Issue #25 B3 (cache-breaking, opt-in): a confirmed intent switch finalizes
// the closed intent's segment — the switch user message becomes the boundary,
// so tool outputs the keep-window would protect turn into retrieval markers.
describe("MemoryContext intent cut", () => {
  const cutSession = () => [
    v1user("u1"),
    v1assistant("a1", [v1tool({ id: "call_1", tool: "bash", output: big(), input: { command: "step 1" } })]),
    v1user("u2"),
    v1assistant("a2", [v1tool({ id: "call_2", tool: "bash", output: big(), input: { command: "step 2" } })]),
    v1user("u3"),
    v1assistant("a3", [v1tool({ id: "call_3", tool: "bash", output: big(), input: { command: "step 3" } })]),
  ]

  test("finalizes the closed intent segment that boundary mode protects", () => {
    const messages = cutSession()
    const boundary = compactV1(messages, { keepRecentUserTurns: 2 })
    expect(v1toolText(boundary[3]!)).toBe(big())
    const cut = compactV1(messages, { keepRecentUserTurns: 2, intentSwitchMessageID: "msg_u3" })
    expect(v1toolText(cut[1]!)).toContain("[mem:compacted tool result]")
    expect(v1toolText(cut[3]!)).toContain("[mem:compacted tool result]")
    expect(v1toolText(cut[3]!)).toContain("call_id=call_2")
    expect(v1toolText(cut[3]!)).toContain("retrieve=get_tool_call_details")
    expect(v1toolText(cut[5]!)).toBe(big())
    expect(v1toolText(messages[3]!)).toBe(big())
  })

  test("unknown switch message falls back to the normal boundary", () => {
    const messages = cutSession()
    const normal = compactV1(messages, { keepRecentUserTurns: 2 })
    const fallback = compactV1(messages, { keepRecentUserTurns: 2, intentSwitchMessageID: "msg_missing" })
    expect(JSON.stringify(fallback)).toBe(JSON.stringify(normal))
  })

  test("projected prefix stays byte-identical as the new intent grows", () => {
    const build = (extra: number) => {
      const messages = cutSession()
      for (let i = 1; i <= extra; i++)
        messages.push(
          v1assistant(`b${i}`, [v1tool({ id: `call_b${i}`, tool: "bash", output: big(), input: { command: `b ${i}` } })]),
        )
      return messages
    }
    const options = { enabled: true, minOutputChars: 100, keepRecentUserTurns: 2, intentSwitchMessageID: "msg_u3" }
    const stable = MemoryContext.projectV1(build(1), options)
    expect(JSON.stringify(MemoryContext.projectV1(build(2), options).slice(0, stable.length))).toBe(
      JSON.stringify(stable),
    )
    expect(v1toolText(stable[3]!)).toContain("[mem:compacted tool result]")
    expect(v1toolText(stable[5]!)).toBe(big())
  })

  test("subsumed once the sliding window moves past the switch", () => {
    const messages = [
      ...cutSession(),
      v1user("u4"),
      v1assistant("a4", [v1tool({ id: "call_4", tool: "bash", output: big(), input: { command: "step 4" } })]),
      v1user("u5"),
    ]
    const cut = compactV1(messages, { keepRecentUserTurns: 2, intentSwitchMessageID: "msg_u3" })
    const normal = compactV1(messages, { keepRecentUserTurns: 2 })
    expect(v1toolText(cut[3]!)).toContain("[mem:compacted tool result]")
    expect(v1toolText(cut[5]!)).toContain("[mem:compacted tool result]")
    expect(JSON.stringify(cut)).toBe(JSON.stringify(normal))
  })

  test("V2 projection honors the same switch boundary", () => {
    const messages = [
      user("u1"),
      assistant("a1", [
        completedTool({ id: "call_1", name: "bash", content: [{ type: "text", text: big() }], input: { command: "step 1" } }),
      ]),
      user("u2"),
      assistant("a2", [
        completedTool({ id: "call_2", name: "bash", content: [{ type: "text", text: big() }], input: { command: "step 2" } }),
      ]),
      user("u3"),
      assistant("a3", [
        completedTool({ id: "call_3", name: "bash", content: [{ type: "text", text: big() }], input: { command: "step 3" } }),
      ]),
    ]
    const cut = compact(messages, { keepRecentUserTurns: 2, intentSwitchMessageID: "msg_u3" })
    expect(toolText(cut[1]!)).toContain("[mem:compacted tool result]")
    expect(toolText(cut[3]!)).toContain("[mem:compacted tool result]")
    expect(toolText(cut[3]!)).toContain("call_id=call_2")
    expect(toolText(cut[5]!)).toBe(big())
  })
})

describe("MemoryContext debug log", () => {
  test("debug stats never leak to stdout", () => {
    const original = console.log
    const lines: string[] = []
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "))
    }
    process.env["OPENCODE_MEMORY_CONTEXT_DEBUG"] = "1"
    try {
      const messages = [
        user("u1"),
        assistant("a1", [completedTool({ id: "call_1", name: "bash", content: [{ type: "text", text: big() }] })]),
        user("u2"),
        assistant("a2", [completedTool({ id: "call_2", name: "bash", content: [{ type: "text", text: big() }] })]),
        user("u3"),
        assistant("a3", [completedTool({ id: "call_3", name: "bash", content: [{ type: "text", text: big() }] })]),
      ]
      const projected = compact(messages)
      expect(toolText(projected[1]!)).toContain("[mem:compacted tool result]")
    } finally {
      console.log = original
      delete process.env["OPENCODE_MEMORY_CONTEXT_DEBUG"]
    }
    expect(lines.filter((line) => line.includes("[mem-context]"))).toEqual([])
  })
})

describe("evidence refs", () => {
  const managedNotice = (name: string) =>
    `...output truncated...\n\nFull output saved to: ${path.join(Global.Path.data, "tool-output", name)}\n\npreview output`

  test("managed tool output marker states the managed file", () => {
    const messages = [
      user("u1"),
      assistant("a1", [
        completedTool({
          id: "call_evidence_1",
          name: "bash",
          content: [{ type: "text", text: managedNotice("tool_test_evidence") }],
          input: { command: "ls" },
        }),
      ]),
      user("u2"),
    ]
    const projected = compact(messages, { midTurn: true })
    const text = toolText(projected[1]!)
    expect(text).toContain("stored=managed_output_file path=")
    expect(text).toContain(`path=${path.join(Global.Path.data, "tool-output", "tool_test_evidence")}`)
    expect(text).toContain('retrieve=get_tool_call_details(call_id="call_evidence_1")')
    expect(text).not.toContain("full text kept in SQLite")
  })

  test("plain large tool result keeps the full_original wording", () => {
    const messages = [
      user("u1"),
      assistant("a1", [
        completedTool({ id: "call_evidence_2", name: "bash", content: [{ type: "text", text: big() }] }),
      ]),
      user("u2"),
    ]
    const projected = compact(messages, { midTurn: true })
    const text = toolText(projected[1]!)
    expect(text).toContain("stored=full_original")
    expect(text).toContain("(full text kept in SQLite history)")
    expect(text).toContain("retrieve=get_tool_call_details")
  })

  test("does not compact when the pointer is outside the managed directory", () => {
    const messages = [
      user("u1"),
      assistant("a1", [
        completedTool({
          id: "call_evidence_3",
          name: "bash",
          content: [
            {
              type: "text",
              text: "...output truncated...\n\nFull output saved to: /tmp/evil-output\n\npreview output",
            },
          ],
          input: { command: "ls" },
        }),
      ]),
      user("u2"),
    ]
    const projected = compact(messages, { midTurn: true })
    expect(projected[1]).toEqual(messages[1])
  })

  test("does not compact a V2 tool result with an empty call id", () => {
    const messages = [
      user("u1"),
      assistant("a1", [completedTool({ id: "", name: "bash", content: [{ type: "text", text: big() }] })]),
      user("u2"),
    ]
    const projected = compact(messages, { midTurn: true })
    expect(projected[1]).toEqual(messages[1])
  })

  test("does not compact a V1 tool part with an empty call id", () => {
    const messages: SessionV1.WithParts[] = [
      v1user("u1"),
      v1assistant("a1", [v1tool({ id: "", tool: "bash", output: big() })]),
      v1user("u2"),
    ]
    const projected = compactV1(messages, { midTurn: true })
    expect(projected[1]).toEqual(messages[1])
  })

  test("does not compact a V1 tool part when the pointer is outside the managed directory", () => {
    const messages: SessionV1.WithParts[] = [
      v1user("u1"),
      v1assistant("a1", [
        v1tool({ id: "call_evidence_4", tool: "bash", output: "Full output saved to: /tmp/evil-output\n\npreview" }),
      ]),
      v1user("u2"),
    ]
    const projected = compactV1(messages, { midTurn: true })
    expect(projected[1]).toEqual(messages[1])
  })

  test("shell output with a notice inside the managed directory", () => {
    const shell = SessionMessage.Shell.make({
      id: id("sh_evidence"),
      type: "shell",
      callID: "call_sh_evidence",
      command: "npm run build",
      output: managedNotice("tool_shell_evidence"),
      time: { created },
    })
    const projected = compact([user("u1"), shell, user("u2")], { midTurn: true })
    const message = projected[1]!
    if (message.type !== "shell") throw new Error("expected shell")
    expect(message.output).toContain("stored=managed_output_file")
    expect(message.output).toContain(`path=${path.join(Global.Path.data, "tool-output", "tool_shell_evidence")}`)
    expect(message.output).toContain("retrieve=get_tool_call_details")
    expect(message.output).not.toContain("full output kept in SQLite")
  })
})
