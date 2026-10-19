import { describe, expect, it } from "bun:test"
import { Schema } from "effect"
import { SessionDoomLoop } from "@opencode/core/session/runner/doom-loop"
import { Agent } from "@opencode/core/agent"
import { SessionMessage } from "@opencode/schema/session-message"

type Call = {
  readonly id: string
  readonly name: string
  readonly input?: unknown
  readonly output: string
}

const assistant = (calls: ReadonlyArray<Call>) =>
  Schema.decodeUnknownSync(SessionMessage.Assistant)({
    id: SessionMessage.ID.create(),
    type: "assistant",
    agent: Agent.defaultID,
    model: { id: "test-model", providerID: "test" },
    content: calls.map((call) => ({
      type: "tool",
      id: call.id,
      name: call.name,
      state: {
        status: "completed",
        input: call.input ?? {},
        content: [{ type: "text", text: call.output }],
      },
      time: { created: 0 },
    })),
    time: { created: 0, completed: 0 },
  })

const same = (count: number, overrides: Partial<Call> = {}) =>
  Array.from({ length: count }, (_, index) => ({
    id: `call_${index}`,
    name: "bash",
    input: { command: "ls" },
    output: "total 0",
    ...overrides,
  }))

describe("SessionDoomLoop", () => {
  it("warns when the same call repeats", () => {
    const warning = SessionDoomLoop.warning([assistant(same(4))])
    expect(warning).toContain("Doom loop suspected")
    expect(warning).toContain("bash")
  })

  it("stays quiet below the threshold", () => {
    expect(SessionDoomLoop.warning([assistant(same(3))])).toBeUndefined()
  })

  it("stays quiet when the output changed", () => {
    const calls = same(4)
    const last = calls[calls.length - 1]
    expect(SessionDoomLoop.warning([assistant([...calls.slice(0, 3), { ...last, output: "total 1" }])])).toBeUndefined()
  })

  it("stays quiet when the input changed", () => {
    const calls = same(4)
    const last = calls[calls.length - 1]
    expect(
      SessionDoomLoop.warning([assistant([...calls.slice(0, 3), { ...last, input: { command: "pwd" } }])]),
    ).toBeUndefined()
  })

  it("sees the repetition across steps", () => {
    // Every repeated call lives in its own assistant message, which is what a
    // per-turn detector cannot see.
    const messages = same(4).map((call) => assistant([call]))
    expect(SessionDoomLoop.warning(messages)).toContain("Doom loop suspected")
  })

  it("ignores calls that never finished", () => {
    const running = Schema.decodeUnknownSync(SessionMessage.Assistant)({
      id: SessionMessage.ID.create(),
      type: "assistant",
      agent: Agent.defaultID,
      model: { id: "test-model", providerID: "test" },
      content: same(4).map((call) => ({
        type: "tool",
        id: call.id,
        name: call.name,
        state: { status: "running", input: call.input ?? {}, metadata: {} },
        time: { created: 0 },
      })),
      time: { created: 0, completed: 0 },
    })
    expect(SessionDoomLoop.warning([running])).toBeUndefined()
  })
})
