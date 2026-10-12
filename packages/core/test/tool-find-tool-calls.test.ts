import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer, Schema } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { ModelV2 } from "@opencode-ai/core/model"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Global } from "@opencode-ai/core/global"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { FindToolCallsTool } from "@opencode-ai/core/tool/find-tool-calls"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { testEffect } from "./lib/effect"
import { toolIdentity, executeTool } from "./lib/tool"

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: () => Effect.void,
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, ToolRegistry.node, ToolRegistry.toolsNode, FindToolCallsTool.node]),
    [
      [PermissionV2.node, permission],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    ],
  ),
)

const sessionID = SessionV2.ID.make("ses_find_tool_calls_test")
const created = DateTime.makeUnsafe(0)
const model = { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") }
const encodeMessage = Schema.encodeSync(SessionMessage.Message)

const assistantRow = (id: SessionMessage.ID, seq: number, content: SessionMessage.Assistant["content"]) => {
  const {
    id: _id,
    type,
    ...data
  } = encodeMessage(
    SessionMessage.Assistant.make({ id, type: "assistant", agent: "build", model, content, time: { created } }),
  )
  return { id, session_id: sessionID, type, seq, time_created: DateTime.toEpochMillis(created), data }
}

const shellRow = (id: SessionMessage.ID, seq: number, callID: string, command: string, output: string) => {
  const {
    id: _id,
    type,
    ...data
  } = encodeMessage(
    SessionMessage.Shell.make({
      id,
      type: "shell",
      callID,
      command,
      output,
      time: { created },
    }),
  )
  return { id, session_id: sessionID, type, seq, time_created: DateTime.toEpochMillis(created), data }
}

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "find-tool-calls",
      directory: "/project",
      title: "find-tool-calls",
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionMessageTable)
    .values([
      assistantRow(SessionMessage.ID.make("msg_call_1"), 1, [
        SessionMessage.AssistantTool.make({
          type: "tool",
          id: "call_bash_ok",
          name: "bash",
          state: SessionMessage.ToolStateCompleted.make({
            status: "completed",
            input: { command: "npm test" },
            content: [{ type: "text", text: "all tests passed" }],
            structured: { exit: 0 },
          }),
          time: { created },
        }),
      ]),
      assistantRow(SessionMessage.ID.make("msg_call_2"), 2, [
        SessionMessage.AssistantTool.make({
          type: "tool",
          id: "call_bash_fail",
          name: "bash",
          state: SessionMessage.ToolStateError.make({
            status: "error",
            input: { command: "npm run build" },
            content: [{ type: "text", text: "tsc failed" }],
            structured: {},
            error: { type: "unknown", message: "exit code 2" },
          }),
          time: { created },
        }),
      ]),
      assistantRow(SessionMessage.ID.make("msg_call_3"), 3, [
        SessionMessage.AssistantTool.make({
          type: "tool",
          id: "call_read",
          name: "read",
          state: SessionMessage.ToolStateCompleted.make({
            status: "completed",
            input: { filePath: "/project/package.json" },
            content: [{ type: "text", text: '{"name":"app"}' }],
            structured: {},
          }),
          time: { created },
        }),
      ]),
      shellRow(SessionMessage.ID.make("msg_shell_1"), 4, "call_shell_1", "git status", "nothing to commit"),
      assistantRow(SessionMessage.ID.make("msg_call_4"), 5, [
        SessionMessage.AssistantTool.make({
          type: "tool",
          id: "call_secret",
          name: "bash",
          state: SessionMessage.ToolStateCompleted.make({
            status: "completed",
            input: { command: 'curl -H "Authorization: Bearer ghp_abcdefghij1234567890ABCD" https://api.example.com' },
            content: [{ type: "text", text: "deploy failed with key sk-proj-abcdef1234567890ABCDEF" }],
            structured: {},
          }),
          time: { created },
        }),
      ]),
      assistantRow(SessionMessage.ID.make("msg_call_needle"), 6, [
        SessionMessage.AssistantTool.make({
          type: "tool",
          id: "call_long_log",
          name: "bash",
          state: SessionMessage.ToolStateCompleted.make({
            status: "completed",
            input: { command: "cat app.log" },
            content: [
              { type: "text", text: `${"heartbeat\n".repeat(80)}DEPLOY-CODE-NEEDLE = X7Q9-M3KT\n${"ok\n".repeat(40)}` },
            ],
            structured: { exit: 1 },
          }),
          time: { created },
        }),
      ]),
    ])
    .run()
    .pipe(Effect.orDie)
})

const call = (input: Record<string, unknown>) => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id: "call_search", name: FindToolCallsTool.name, input },
})

const parsed = (result: { type: string; value: unknown }) => {
  if (result.type !== "text" && result.type !== "json") throw new Error(`unexpected result type: ${result.type}`)
  return typeof result.value === "string"
    ? (JSON.parse(result.value) as Record<string, unknown>)
    : (result.value as Record<string, unknown>)
}

const callsOf = (output: Record<string, unknown>) => output["calls"] as Record<string, unknown>[]

describe("FindToolCallsTool", () => {
  it.effect("returns all calls newest first when unfiltered", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      const output = parsed(yield* executeTool(registry, call({})))
      expect(output["matched"]).toBe(6)
      const calls = callsOf(output)
      expect(calls.length).toBe(6)
      expect(calls[0]!["tool"]).toBe("bash")
      expect(calls[0]!["call_id"]).toBe("call_long_log")
      const shell = calls.find((candidate) => candidate["call_id"] === "call_shell_1")
      expect(String(shell?.["input"])).toContain("git status")
    }),
  )

  it.effect("filters by tool name and status", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      const output = parsed(yield* executeTool(registry, call({ tool: "bash", status: "error" })))
      expect(output["matched"]).toBe(1)
      const calls = callsOf(output)
      expect(calls[0]!["call_id"]).toBe("call_bash_fail")
      expect(calls[0]!["status"]).toBe("error")
      expect(String(calls[0]!["error"])).toContain("exit code 2")
    }),
  )

  it.effect("query regex matches input, output and error text", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      const byInput = callsOf(parsed(yield* executeTool(registry, call({ query: "npm (test|run)" }))))
      expect(byInput.map((candidate) => candidate["call_id"])).toEqual(["call_bash_fail", "call_bash_ok"])
      const byOutput = callsOf(parsed(yield* executeTool(registry, call({ query: "nothing to commit" }))))
      expect(byOutput.length).toBe(1)
      expect(byOutput[0]!["tool"]).toBe("bash")
      const byError = callsOf(parsed(yield* executeTool(registry, call({ query: "exit code" }))))
      expect(byError.map((candidate) => candidate["call_id"])).toEqual(["call_bash_fail"])
    }),
  )

  it.effect("respects limit and reports total matched", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      const output = parsed(yield* executeTool(registry, call({ tool: "bash", limit: 1 })))
      expect(output["matched"]).toBe(5)
      const calls = callsOf(output)
      expect(calls.length).toBe(1)
      expect(calls[0]!["call_id"]).toBe("call_long_log")
    }),
  )

  it.effect("offset pages past the most-recent limit window", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      const page1 = parsed(yield* executeTool(registry, call({ tool: "bash", limit: 2 })))
      expect(callsOf(page1).map((candidate) => candidate["call_id"])).toEqual(["call_long_log", "call_secret"])
      const page2 = parsed(yield* executeTool(registry, call({ tool: "bash", limit: 2, offset: 2 })))
      expect(page2["matched"]).toBe(5)
      expect(callsOf(page2).map((candidate) => candidate["call_id"])).toEqual(["call_shell_1", "call_bash_fail"])
      const page3 = parsed(yield* executeTool(registry, call({ tool: "bash", limit: 2, offset: 4 })))
      expect(callsOf(page3).map((candidate) => candidate["call_id"])).toEqual(["call_bash_ok"])
      const past = parsed(yield* executeTool(registry, call({ tool: "bash", offset: 10 })))
      expect(past["matched"]).toBe(5)
      expect(callsOf(past).length).toBe(0)
    }),
  )

  it.effect("bounds long previews", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      const output = parsed(yield* executeTool(registry, call({ query: "all tests passed" })))
      const calls = callsOf(output)
      expect(calls[0]!["call_id"]).toBe("call_bash_ok")
      expect(String(calls[0]!["preview"]).length).toBeLessThanOrEqual(240)
    }),
  )

  it.effect("returns empty result for no matches", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      const output = parsed(yield* executeTool(registry, call({ tool: "webfetch" })))
      expect(output["matched"]).toBe(0)
      expect(callsOf(output).length).toBe(0)
    }),
  )

  it.effect("rejects an invalid query regex", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      const result = yield* executeTool(registry, call({ query: "(unclosed" }))
      expect(result.type).toBe("error")
    }),
  )

  it.effect("redacts secrets in model-visible fields but keeps them searchable", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      const output = parsed(yield* executeTool(registry, call({ tool: "bash", query: "deploy failed" })))
      const entry = callsOf(output).find((candidate) => candidate["call_id"] === "call_secret")
      expect(entry).toBeDefined()
      expect(String(entry?.["preview"])).not.toContain("sk-proj-abcdef")
      expect(String(entry?.["preview"])).toContain("[REDACTED:api_key]")
      expect(String(entry?.["input"])).not.toContain("ghp_abcdefghij")
      expect(String(entry?.["input"])).toContain("[REDACTED:bearer]")
      const bySecret = callsOf(parsed(yield* executeTool(registry, call({ query: "sk-proj-abcdef1234567890ABCDEF" }))))
      expect(bySecret.map((candidate) => candidate["call_id"])).toEqual(["call_secret"])
    }),
  )

  it.effect("excludes memory tool calls so a query cannot index itself (issue #34)", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      yield* db
        .insert(SessionMessageTable)
        .values([
          assistantRow(SessionMessage.ID.make("msg_call_search"), 7, [
            SessionMessage.AssistantTool.make({
              type: "tool",
              id: "call_search_echo",
              name: FindToolCallsTool.name,
              state: SessionMessage.ToolStateCompleted.make({
                status: "completed",
                input: { query: "echo-needle" },
                content: [{ type: "text", text: "no matches for echo-needle" }],
                structured: {},
              }),
              time: { created },
            }),
          ]),
        ])
        .run()
        .pipe(Effect.orDie)
      const registry = yield* ToolRegistry.Service
      const byQuery = parsed(yield* executeTool(registry, call({ query: "echo-needle" })))
      expect(byQuery["matched"]).toBe(0)
      const unfiltered = parsed(yield* executeTool(registry, call({})))
      expect(unfiltered["matched"]).toBe(6)
    }),
  )

  it.effect("query that matches mid-output returns match_snippet and match_offset", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      const output = parsed(yield* executeTool(registry, call({ query: "DEPLOY-CODE-NEEDLE" })))
      expect(output["matched"]).toBe(1)
      const entry = callsOf(output)[0]
      expect(entry?.["call_id"]).toBe("call_long_log")
      expect(typeof entry?.["match_offset"]).toBe("number")
      expect(Number(entry?.["match_offset"])).toBeGreaterThan(200)
      expect(String(entry?.["match_snippet"])).toContain("DEPLOY-CODE-NEEDLE = X7Q9-M3KT")
      expect(String(entry?.["match_snippet"]).length).toBeLessThanOrEqual(180 * 2 + 40)
      expect(String(entry?.["preview"])).not.toContain("X7Q9-M3KT")
    }),
  )

  it.effect("input-only query match does not set match_offset", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      const output = parsed(yield* executeTool(registry, call({ query: "npm (test|run)" })))
      for (const entry of callsOf(output)) {
        expect(entry["match_offset"]).toBeUndefined()
        expect(entry["match_snippet"]).toBeUndefined()
      }
    }),
  )

  it.effect("surfaces exit_code from structured bash output and failed=true selects non-zero/error", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      const byExit = parsed(yield* executeTool(registry, call({ query: "exit_code=" })))
      const exitById = new Map(callsOf(byExit).map((candidate) => [candidate["call_id"], candidate["exit_code"]]))
      expect(exitById.get("call_bash_ok")).toBe(0)
      expect(exitById.get("call_long_log")).toBe(1)
      expect(exitById.has("call_bash_fail")).toBe(false)
      expect(exitById.has("call_shell_1")).toBe(false)

      const failed = parsed(yield* executeTool(registry, call({ failed: true })))
      expect(
        callsOf(failed)
          .map((candidate) => candidate["call_id"])
          .sort(),
      ).toEqual(["call_bash_fail", "call_long_log"])
    }),
  )

  it.effect("failed=true keeps error-status calls even without an exit_code", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      const failed = parsed(yield* executeTool(registry, call({ tool: "bash", failed: true })))
      const calls = callsOf(failed)
      expect(calls.map((candidate) => candidate["call_id"])).toContain("call_bash_fail")
      expect(calls.every((candidate) => candidate["call_id"] !== "call_bash_ok")).toBe(true)
      expect(calls.every((candidate) => candidate["call_id"] !== "call_secret")).toBe(true)
    }),
  )

  it.effect("truncation-notice output matches but never sets match_offset (details pages the managed file)", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      yield* db
        .insert(SessionMessageTable)
        .values([
          assistantRow(SessionMessage.ID.make("msg_call_notice"), 8, [
            SessionMessage.AssistantTool.make({
              type: "tool",
              id: "call_managed_notice",
              name: "bash",
              state: SessionMessage.ToolStateCompleted.make({
                status: "completed",
                input: { command: "cat huge.bin" },
                content: [
                  {
                    type: "text",
                    text: `...output truncated...\n\nFull output saved to: ${Global.Path.data}/tool-output/tool_find_test_managed\n\npreview`,
                  },
                ],
                structured: {},
              }),
              time: { created },
            }),
          ]),
        ])
        .run()
        .pipe(Effect.orDie)
      const registry = yield* ToolRegistry.Service
      const output = parsed(yield* executeTool(registry, call({ query: "truncated" })))
      const entry = callsOf(output).find((candidate) => candidate["call_id"] === "call_managed_notice")
      expect(entry).toBeDefined()
      expect(entry?.["match_offset"]).toBeUndefined()
      expect(entry?.["match_snippet"]).toBeUndefined()
    }),
  )
})
