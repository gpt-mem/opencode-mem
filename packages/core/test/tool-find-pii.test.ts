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
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { FindPiiTool } from "@opencode-ai/core/tool/find-pii"
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
    LayerNode.group([
      Database.node,
      ToolRegistry.node,
      ToolRegistry.toolsNode,
      FindPiiTool.node,
      FindToolCallsTool.node,
    ]),
    [
      [PermissionV2.node, permission],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    ],
  ),
)

const sessionID = SessionV2.ID.make("ses_find_pii_test")
const emptySessionID = SessionV2.ID.make("ses_find_pii_empty")
const created = DateTime.makeUnsafe(0)
const model = { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") }
const encodeMessage = Schema.encodeSync(SessionMessage.Message)

const assistantRow = (
  id: SessionMessage.ID,
  seq: number,
  content: SessionMessage.Assistant["content"],
  sid = sessionID,
) => {
  const {
    id: _id,
    type,
    ...data
  } = encodeMessage(
    SessionMessage.Assistant.make({ id, type: "assistant", agent: "build", model, content, time: { created } }),
  )
  return { id, session_id: sid, type, seq, time_created: DateTime.toEpochMillis(created), data }
}

const bashCall = (
  id: SessionMessage.ID,
  seq: number,
  callID: string,
  input: Record<string, unknown>,
  text: string,
  sid = sessionID,
) =>
  assistantRow(
    id,
    seq,
    [
      SessionMessage.AssistantTool.make({
        type: "tool",
        id: callID,
        name: "bash",
        state: SessionMessage.ToolStateCompleted.make({
          status: "completed",
          input,
          content: [{ type: "text", text }],
          structured: {},
        }),
        time: { created },
      }),
    ],
    sid,
  )

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values([
      {
        id: sessionID,
        project_id: Project.ID.global,
        slug: "find-pii",
        directory: "/project",
        title: "find-pii",
        version: "test",
      },
      {
        id: emptySessionID,
        project_id: Project.ID.global,
        slug: "find-pii-empty",
        directory: "/project",
        title: "find-pii-empty",
        version: "test",
      },
    ])
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionMessageTable)
    .values([
      bashCall(SessionMessage.ID.make("msg_clean"), 1, "call_clean", { command: "npm test" }, "all tests passed"),
      bashCall(
        SessionMessage.ID.make("msg_mail"),
        2,
        "call_mail",
        { command: "grep -r contact ." },
        "found william.shekspier@example.com in docs/contacts.md",
      ),
      bashCall(
        SessionMessage.ID.make("msg_phone"),
        3,
        "call_phone",
        { command: "cat lead.txt" },
        "callback +7 916 123-45-67 before noon",
      ),
      // The key lives only in the command: input summaries are redacted before
      // they reach the haystack, so the carrier survives as a placeholder.
      bashCall(
        SessionMessage.ID.make("msg_key"),
        4,
        "call_key",
        { command: 'curl -H "Authorization: Bearer ghp_abcdefghij1234567890ABCD" https://api.example.com' },
        "200 ok",
      ),
    ])
    .run()
    .pipe(Effect.orDie)
})

const call = (input: Record<string, unknown>, sid = sessionID) => ({
  sessionID: sid,
  ...toolIdentity,
  call: { type: "tool-call" as const, id: "call_pii", name: FindPiiTool.name, input },
})

const search = (input: Record<string, unknown>) => ({
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

const matches = (output: Record<string, unknown>) => output["matches"] as Record<string, unknown>[]

const ids = (list: Record<string, unknown>[]) => list.map((match) => match["call_id"])

describe("FindPiiTool", () => {
  it.effect("reports every PII carrier newest first", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      const output = parsed(yield* executeTool(registry, call({})))
      expect(output["matched"]).toBe(3)
      expect(ids(matches(output))).toEqual(["call_key", "call_phone", "call_mail"])
      const totals = Object.fromEntries(
        (output["counts"] as Record<string, unknown>[]).map((entry) => [entry["type"], entry["count"]]),
      )
      expect(totals).toEqual({ email: 1, phone: 1, api_key: 1 })
    }),
  )

  it.effect("never returns the PII value itself, only a masked carrier line", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      const raw = yield* executeTool(registry, call({}))
      const text = raw.type === "text" || raw.type === "json" ? String(raw.value) : ""
      expect(text).not.toContain("william.shekspier@example.com")
      expect(text).not.toContain("ghp_abcdefghij")
      expect(text).toContain("[REDACTED:email]")
      expect(text).toContain("[REDACTED:bearer]")
      const output = JSON.parse(text) as Record<string, unknown>
      const mail = matches(output).find((match) => match["call_id"] === "call_mail")
      expect(String(mail?.["evidence"])).toContain("docs/contacts.md")
      expect(String(mail?.["evidence"])).not.toContain("william.shekspier")
    }),
  )

  it.effect("filters by PII type", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      const phone = parsed(yield* executeTool(registry, call({ type: "phone" })))
      expect(phone["matched"]).toBe(1)
      expect(ids(matches(phone))).toEqual(["call_phone"])
      const mail = parsed(yield* executeTool(registry, call({ type: "email" })))
      expect(ids(matches(mail))).toEqual(["call_mail"])
      const none = parsed(yield* executeTool(registry, call({ type: "credit_card" })))
      expect(none["matched"]).toBe(0)
      expect(matches(none).length).toBe(0)
    }),
  )

  it.effect("counts an already-redacted credential carrier from its placeholder", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      const output = parsed(yield* executeTool(registry, call({ type: "api_key" })))
      expect(ids(matches(output))).toEqual(["call_key"])
      const carrier = matches(output)[0]!
      expect(String(carrier["evidence"])).toContain("[REDACTED:bearer]")
      expect(String(carrier["evidence"])).not.toContain("ghp_abcdefghij")
    }),
  )

  it.effect("reports an empty session as zero carriers", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      const output = parsed(yield* executeTool(registry, call({}, emptySessionID)))
      expect(output["matched"]).toBe(0)
      expect(matches(output).length).toBe(0)
    }),
  )

  it.effect("respects limit while reporting the full carrier total", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      const output = parsed(yield* executeTool(registry, call({ limit: 1 })))
      expect(output["matched"]).toBe(3)
      expect(matches(output).length).toBe(1)
      expect(ids(matches(output))).toEqual(["call_key"])
    }),
  )

  it.effect("excludes memory-tool calls so an audit cannot index itself (issue #34)", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      yield* db
        .insert(SessionMessageTable)
        .values([
          assistantRow(SessionMessage.ID.make("msg_pii_audit"), 5, [
            SessionMessage.AssistantTool.make({
              type: "tool",
              id: "call_pii_echo",
              name: FindPiiTool.name,
              state: SessionMessage.ToolStateCompleted.make({
                status: "completed",
                input: { type: "email" },
                content: [{ type: "text", text: "[REDACTED:email] audit marker pii-echo-marker" }],
                structured: {},
              }),
              time: { created },
            }),
          ]),
        ])
        .run()
        .pipe(Effect.orDie)
      const registry = yield* ToolRegistry.Service
      const audited = parsed(yield* executeTool(registry, call({})))
      expect(audited["matched"]).toBe(3)
      expect(ids(matches(audited))).not.toContain("call_pii_echo")
      const indexed = parsed(yield* executeTool(registry, search({ query: "pii-echo-marker" })))
      expect(indexed["matched"]).toBe(0)
    }),
  )
})
