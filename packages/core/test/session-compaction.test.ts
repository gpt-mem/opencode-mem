import { expect, test } from "bun:test"
import { DateTime } from "effect"
import { SessionCompaction } from "@opencode-ai/core/session/compaction"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"

test("compaction prompt preserves detailed work state and relevant files", () => {
  const prompt = SessionCompaction.buildPrompt({ context: ["conversation history"] })

  expect(prompt).toStartWith(
    "Here is the conversation so far:\n\n<conversation>\nconversation history\n</conversation>",
  )
  expect(prompt.indexOf("</conversation>")).toBeLessThan(prompt.indexOf("Create a new anchored summary"))
  expect(prompt).toContain("conversation history in the <conversation> tags above")
  expect(prompt).toContain("## Work State\n### Completed")
  expect(prompt).toContain("### Active")
  expect(prompt).toContain("### Blocked")
  expect(prompt).toContain("## Relevant Files")
  expect(prompt).toContain("keep only the latest completed run for that project in the active summary")
  expect(prompt).toContain("ReplacingMergeTree rows")
  expect(prompt).toContain("The latest run is the complete result for its recorded command")
  expect(prompt).toContain("from any runner")
  expect(prompt).toContain("Vitest, Jest, Mocha, Playwright, Cypress, pytest, go test, and cargo test")
  expect(prompt).toContain("Keep the first substantive reasoning block as an explicit initial plan/decision anchor")
  expect(prompt).toContain("Give recent reasoning the most detail, then decrease detail gradually with age")
  expect(prompt).toContain("retain roughly 30% or more of its distinct substantive points when space allows")
  expect(prompt).toContain("semantic guardrail, not a quota for verbatim text or tokens")
  expect(prompt).toContain("Preserve more when older reasoning contains unique evidence")
})

test("compaction prompt gives update instructions for a prior summary", () => {
  const prompt = SessionCompaction.buildPrompt({
    context: ["new conversation"],
    previousSummary: "existing summary",
  })

  expect(prompt.indexOf("<conversation>")).toBeLessThan(prompt.indexOf("<prior-summary>"))
  expect(prompt.indexOf("</prior-summary>")).toBeLessThan(prompt.indexOf("The <prior-summary> summarizes"))
  expect(prompt).toContain(
    "Carry forward objectives, constraints, user directives, decisions, and parallel workstreams from the <prior-summary>",
  )
  expect(prompt).toContain('Move completed work from "Active" to "Completed".')
  expect(prompt).toContain('Update "Objective" and "Next Move" to reflect the current work state.')
  expect(prompt).toContain("carry it forward through every summary update")
})

test("compaction describes tool media without embedding base64", () => {
  const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"
  const serialized = SessionCompaction.serializeToolContent([
    { type: "text", text: "Image read successfully" },
    {
      type: "file",
      uri: `data:image/png;base64,${base64}`,
      mime: "image/png",
      name: "pixel.png",
    },
  ])

  expect(serialized).toBe("Image read successfully\n[Attached image/png: pixel.png]")
  expect(serialized).not.toContain(base64)
})

test("compaction keeps complete source and shell output for the summarizer", () => {
  const sourceTail = "241: export const importantBoundary = true"
  const shellTail = "Tests 1 passed | 152 skipped (153)"
  const source = `${"source-line\n".repeat(250)}${sourceTail}`
  const shell = `${"routine test output\n".repeat(250)}${shellTail}`
  const now = DateTime.makeUnsafe(0)
  const message: SessionMessage.Message = {
    id: SessionMessage.ID.create(),
    type: "assistant",
    agent: "build",
    model: { providerID: ProviderV2.ID.make("test"), id: ModelV2.ID.make("test-model") },
    time: { created: now },
    content: [
      {
        id: "read-call",
        type: "tool",
        name: "read",
        state: {
          status: "completed",
          input: { filePath: "src/session/compaction.ts" },
          content: [{ type: "text", text: source }],
          structured: {},
        },
        time: { created: now, completed: now },
      },
    ],
  }
  const shellMessage: SessionMessage.Message = {
    id: SessionMessage.ID.create(),
    type: "shell",
    callID: "shell-call",
    command: "bun test",
    output: shell,
    time: { created: now, completed: now },
  }

  const serializedSource = SessionCompaction.serializeMessageForCompaction(message)
  const serializedShell = SessionCompaction.serializeMessageForCompaction(shellMessage)

  expect(serializedSource).toContain("src/session/compaction.ts")
  expect(serializedSource).toContain(sourceTail)
  expect(serializedSource).not.toContain("[truncated]")
  expect(serializedShell).toContain(shellTail)
  expect(serializedShell).not.toContain("[truncated]")
})

test("compaction passes long reasoning to the summarizer without truncating its beginning or end", () => {
  const opening = "Initial plan: preserve the first decision anchor."
  const ending = "Later evidence changed the chosen trade-off; keep this conclusion."
  const reasoning = `${opening}\n${"Detailed reasoning step.\n".repeat(12_000)}${ending}`
  const now = DateTime.makeUnsafe(0)
  const message: SessionMessage.Message = {
    id: SessionMessage.ID.create(),
    type: "assistant",
    agent: "build",
    model: { providerID: ProviderV2.ID.make("test"), id: ModelV2.ID.make("test-model") },
    time: { created: now },
    content: [{ id: "reasoning-1", type: "reasoning", text: reasoning, time: { created: now } }],
  }

  const serialized = SessionCompaction.serializeMessageForCompaction(message)

  expect(serialized).toStartWith(`[Assistant reasoning]: ${opening}`)
  expect(serialized).toContain(ending)
  expect(serialized).not.toContain("[truncated]")
})
