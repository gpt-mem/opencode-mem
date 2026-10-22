import { describe, expect, test } from "bun:test"
import { Model } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import { SessionMemoryContext } from "@opencode/core/session/memory-context"
import { SessionMessage } from "@opencode/core/session/message"
import { Agent } from "@opencode/core/agent"
import { DateTime } from "effect"

const created = DateTime.makeUnsafe(0)
const messageID = (value: string) => SessionMessage.ID.make(`msg_${value}`)
const model = Model.Ref.make({ id: Model.ID.make("model"), providerID: Provider.ID.make("provider") })

const tool = (input: {
  readonly id: string
  readonly name?: string
  readonly text: string
  readonly status?: "completed" | "error"
  readonly executed?: boolean
  readonly toolInput?: Record<string, unknown>
  readonly file?: { readonly uri: string; readonly mime: string; readonly name?: string }
}) =>
  SessionMessage.AssistantTool.make({
    type: "tool",
    id: input.id,
    name: input.name ?? "shell",
    ...(input.executed === undefined ? {} : { executed: input.executed }),
    state:
      input.status === "error"
        ? SessionMessage.ToolStateError.make({
            status: "error",
            input: input.toolInput ?? {},
            error: { type: "unknown", message: "failed" },
          })
        : SessionMessage.ToolStateCompleted.make({
            status: "completed",
            input: input.toolInput ?? {},
            content:
              input.file === undefined
                ? [{ type: "text" as const, text: input.text }]
                : [
                    { type: "text" as const, text: input.text },
                    {
                      type: "file" as const,
                      uri: input.file.uri,
                      mime: input.file.mime,
                      ...(input.file.name === undefined ? {} : { name: input.file.name }),
                    },
                  ],
          }),
    time: { created },
  })

const assistant = (value: string, content: SessionMessage.Assistant["content"]) =>
  SessionMessage.Assistant.make({
    id: messageID(value),
    type: "assistant",
    agent: Agent.defaultID,
    model,
    content,
    time: { created, completed: created },
  })

const markerOf = (message: SessionMessage.Info) => {
  if (message.type !== "assistant") return undefined
  const item = message.content[0]
  if (item?.type !== "tool" || item.state.status !== "completed") return undefined
  return item.state.content[0]?.type === "text" ? item.state.content[0].text : undefined
}

const large = "x".repeat(3000)

describe("SessionMemoryContext", () => {
  test("compacts an eligible tool result into a marker that names the call id", () => {
    const history = [
      assistant("first", [tool({ id: "call_1", text: large, toolInput: { command: "cat big.txt" } })]),
    ]
    const projected = SessionMemoryContext.project(history, { enabled: true, minOutputChars: 100 })
    const marker = markerOf(projected[0]) ?? ""
    expect(marker).toContain("[mem:compacted tool result]")
    expect(marker).toContain("kind=bash tool=shell call_id=call_1 status=success")
    expect(marker).toContain("command=cat big.txt")
    expect(marker).toContain(`retrieve=get_tool_call_details(call_id="call_1")`)
    expect(marker.length).toBeLessThan(large.length)
  })

  test("leaves the stored history untouched", () => {
    const original = assistant("first", [tool({ id: "call_1", text: large })])
    const history = [original]
    SessionMemoryContext.project(history, { enabled: true, minOutputChars: 100 })
    expect(original.content[0]?.type === "tool" ? original.content[0].state.status : undefined).toBe("completed")
    expect(
      original.content[0]?.type === "tool" && original.content[0].state.status === "completed"
        ? original.content[0].state.content[0]?.type === "text"
          ? original.content[0].state.content[0].text
          : undefined
        : undefined,
    ).toBe(large)
  })

  test("keeps results below the threshold verbatim", () => {
    const history = [assistant("first", [tool({ id: "call_1", text: "small" })])]
    const projected = SessionMemoryContext.project(history, { enabled: true, minOutputChars: 100 })
    expect(markerOf(projected[0])).toBe("small")
  })

  test("skips failed, provider-executed, memory and non-allowlisted tools", () => {
    const history = [
      assistant("failed", [tool({ id: "call_1", text: large, status: "error" })]),
      assistant("hosted", [tool({ id: "call_2", text: large, executed: true })]),
      assistant("memory", [tool({ id: "call_3", name: "search_operational_memory", text: large })]),
      assistant("other", [tool({ id: "call_4", name: "grep", text: large })]),
    ]
    const projected = SessionMemoryContext.project(history, { enabled: true, minOutputChars: 100 })
    expect(projected.every((message) => !(markerOf(message) ?? "").includes("[mem:compacted"))).toBe(true)
  })

  test("keeps a result without a call id verbatim", () => {
    const history = [assistant("first", [tool({ id: "", text: large })])]
    const projected = SessionMemoryContext.project(history, { enabled: true, minOutputChars: 100 })
    expect(markerOf(projected[0])).toBe(large)
  })

  test("is disabled by default and leaves the history identical", () => {
    const history = [assistant("first", [tool({ id: "call_1", text: large })])]
    expect(SessionMemoryContext.project(history)).toBe(history)
  })

  test("redacts secrets in the preview and tags them", () => {
    const history = [
      assistant("first", [
        tool({ id: "call_1", text: `token sk-abcdefghijklmnopqrstuvwxyz012345 ${large}` }),
      ]),
    ]
    const projected = SessionMemoryContext.project(history, { enabled: true, minOutputChars: 100 })
    const marker = markerOf(projected[0]) ?? ""
    expect(marker).toContain("pii=api_key")
    expect(marker).not.toContain("sk-abcdefghijklmnopqrstuvwxyz012345")
    expect(marker).toContain("[REDACTED:api_key]")
  })

  test("keeps a file part (an image) next to the marker", () => {
    const history = [
      assistant("first", [
        tool({
          id: "call_1",
          name: "read",
          text: large,
          file: { uri: "data:image/png;base64,AAAA", mime: "image/png", name: "shot.png" },
        }),
      ]),
    ]
    const projected = SessionMemoryContext.project(history, { enabled: true, minOutputChars: 100 })
    const item = projected[0]?.type === "assistant" ? projected[0].content[0] : undefined
    const content = item?.type === "tool" && item.state.status === "completed" ? item.state.content : undefined
    expect(content?.some((part) => part.type === "file")).toBe(true)
    expect(content?.some((part) => part.type === "text" && part.text.includes("[mem:compacted tool result]"))).toBe(
      true,
    )
  })

  test("keeps the projected prefix stable when the history grows", () => {
    const first = assistant("first", [tool({ id: "call_1", text: large })])
    const before = SessionMemoryContext.project([first], { enabled: true, minOutputChars: 100 })
    const after = SessionMemoryContext.project(
      [first, assistant("second", [tool({ id: "call_2", text: large })])],
      { enabled: true, minOutputChars: 100 },
    )
    expect(after[0]).toEqual(before[0])
  })

  test("reads the enable flag from the environment", () => {
    const history = [assistant("first", [tool({ id: "call_1", text: large })])]
    process.env.OPENCODE_V2_MEMORY_CONTEXT = "1"
    process.env.OPENCODE_V2_MEMORY_MIN_CHARS = "100"
    try {
      const projected = SessionMemoryContext.project(history)
      expect(markerOf(projected[0])).toContain("[mem:compacted tool result]")
    } finally {
      delete process.env.OPENCODE_V2_MEMORY_CONTEXT
      delete process.env.OPENCODE_V2_MEMORY_MIN_CHARS
    }
  })
})
