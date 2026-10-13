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
