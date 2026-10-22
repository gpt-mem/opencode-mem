import { describe, expect } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Database } from "@opencode/core/database/database"
import { Permission } from "@opencode/core/permission"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionMessageTable, SessionTable } from "@opencode/core/session/sql"
import { SessionMessage } from "@opencode/core/session/message"
import { Tool } from "@opencode/core/tool"
import { GetToolCallDetailsTool } from "@opencode/core/tool/plugin/get-tool-call-details"
import { Project } from "@opencode/schema/project"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"
import { permissionLayer } from "./lib/permission"
import { toolIdentity, executeTool, registerToolPlugin, type ToolExecution } from "./lib/tool"

const assertions: Permission.AssertInput[] = []
const permission = permissionLayer({
  assert: (input) =>
    Effect.sync(() => {
      assertions.push(input)
    }),
})

const detailsNode = makeLocationNode({
  name: "test/get-tool-call-details",
  layer: Layer.effectDiscard(registerToolPlugin(GetToolCallDetailsTool.Plugin)),
  deps: [Tool.node, Database.node, Permission.node, FSUtil.node, Global.node],
})

const sessionID = Session.ID.make("ses_details_v2")
const otherSessionID = Session.ID.make("ses_details_v2_other")

const CALL = "call_shell_1"

// The message column stores the encoded message: dates are epoch millis and the
// tool part keeps the provider call id the retrieval tool looks up.
const assistantData = (callID: string, text: string) => ({
  agent: "build",
  model: { id: "standard", providerID: "ladder" },
  content: [
    {
      type: "tool" as const,
      id: callID,
      name: "shell",
      state: {
        status: "completed" as const,
        input: { command: "cat big.txt" },
        content: [{ type: "text" as const, text }],
      },
      time: { created: 1 },
    },
  ],
  time: { created: 1 },
})

const setup = (rows: { call_id: string; text: string; session?: Session.ID }[]) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values([
        { id: sessionID, project_id: Project.ID.global, slug: "details-v2", directory: "/project", version: "test" },
        {
          id: otherSessionID,
          project_id: Project.ID.global,
          slug: "details-v2-other",
          directory: "/project",
          version: "test",
        },
      ])
      .run()
      .pipe(Effect.orDie)
    let seq = 0
    for (const row of rows) {
      seq++
      yield* db
        .insert(SessionMessageTable)
        .values({
          id: `msg_${seq}` as SessionMessage.ID,
          session_id: row.session ?? sessionID,
          type: "assistant",
          seq,
          data: assistantData(row.call_id, row.text),
        })
        .run()
        .pipe(Effect.orDie)
    }
  })

const call = (input: Record<string, unknown>) => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id: "call_details", name: GetToolCallDetailsTool.name, input },
})

const output = (result: ToolExecution) => {
  if (result.status !== "completed") throw new Error(`tool failed: ${JSON.stringify(result.error)}`)
  return result.output
}

const withDataDir = <A, E, R>(body: (root: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => {
      const layer = AppNodeBuilder.build(
        LayerNode.group([Tool.node, Database.node, FSUtil.node, Global.node, detailsNode]),
        [Permission.node.replace(permission), Global.node.replace(Global.layerWith({ data: tmp.path }))],
      )
      return Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        yield* fs.ensureDir(path.join(tmp.path, "tool-output"))
        return yield* body(tmp.path)
      }).pipe(Effect.provide(layer))
    },
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

describe("get_tool_call_details", () => {
  it.live("returns the stored output of a tool call", () =>
    withDataDir(() =>
      Effect.gen(function* () {
        yield* setup([{ call_id: CALL, text: "hello from the tool" }])
        const registry = yield* Tool.Service
        const result = output(yield* executeTool(registry, call({ call_id: CALL })))
        expect(result.found).toBe(true)
        expect(result.tool).toBe("shell")
        expect(result.output).toBe("hello from the tool")
        expect(result.source).toBe("stored_output")
        expect(result.truncated).toBe(false)
        expect(result.total_chars).toBe("hello from the tool".length)
      }),
    ),
  )

  it.live("returns the original output behind a truncation marker", () =>
    withDataDir((root) =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const original = Array.from({ length: 1_000 }, (_, index) => `line ${index}`).join("\n")
        const managed = path.join(root, "tool-output", "tool_fixture")
        yield* fs.writeFileString(managed, original)
        const marker = `[showing lines 1-2 of 1000; full output saved to ${managed} — read or grep that file instead of re-running the command]`
        yield* setup([{ call_id: CALL, text: `line 0\nline 1\n${marker}` }])
        const registry = yield* Tool.Service
        const result = output(yield* executeTool(registry, call({ call_id: CALL })))
        expect(result.found).toBe(true)
        expect(result.source).toBe("managed_output_file")
        expect(result.managed_path).toBe(managed)
        expect(result.total_chars).toBe(original.length)
        expect(result.output).toBe(original.slice(0, 4000))
        expect(result.truncated).toBe(true)
        expect(result.next_offset).toBe(4000)
      }),
    ),
  )

  it.live("keeps the stored preview when the marker points outside the data directory", () =>
    withDataDir(() =>
      Effect.gen(function* () {
        const marker = `[showing lines 1-1 of 2; full output saved to /etc/passwd — read or grep that file instead of re-running the command]`
        yield* setup([{ call_id: CALL, text: `preview\n${marker}` }])
        const registry = yield* Tool.Service
        const result = output(yield* executeTool(registry, call({ call_id: CALL })))
        expect(result.found).toBe(true)
        expect(result.source).toBe("stored_output")
        expect(result.managed_path).toBeUndefined()
        expect(result.output).toContain("preview")
      }),
    ),
  )

  it.live("pages through a large original with offset", () =>
    withDataDir((root) =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const original = Array.from({ length: 300 }, (_, index) => `line ${index}`).join("\n")
        const managed = path.join(root, "tool-output", "tool_fixture")
        yield* fs.writeFileString(managed, original)
        const marker = `[showing lines 1-2 of 300; full output saved to ${managed} — read or grep that file instead of re-running the command]`
        yield* setup([{ call_id: CALL, text: marker }])
        const registry = yield* Tool.Service
        const result = output(yield* executeTool(registry, call({ call_id: CALL, offset: 10, limit: 20 })))
        expect(result.output).toBe(original.slice(10, 30))
        expect(result.offset).toBe(10)
        expect(result.truncated).toBe(true)
        expect(result.next_offset).toBe(30)
      }),
    ),
  )

  it.live("reports the page scalars before the retrieved text", () =>
    withDataDir((root) =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const original = Array.from({ length: 300 }, (_, index) => `line ${index}`).join("\n")
        const managed = path.join(root, "tool-output", "tool_fixture")
        yield* fs.writeFileString(managed, original)
        const marker = `[showing lines 1-2 of 300; full output saved to ${managed} — read or grep that file instead of re-running the command]`
        yield* setup([{ call_id: CALL, text: marker }])
        const registry = yield* Tool.Service
        const result = output(yield* executeTool(registry, call({ call_id: CALL })))
        const keys = Object.keys(result)
        // The answer of this tool is bounded like any other tool result, so the
        // scalars have to precede the text: otherwise the model reads them back
        // from the saved file and pays an extra call for it.
        expect(keys.indexOf("total_chars")).toBeLessThan(keys.indexOf("output"))
        expect(keys.indexOf("source")).toBeLessThan(keys.indexOf("output"))
      }),
    ),
  )

  it.live("finds a call recorded in another session of the same project", () =>
    withDataDir(() =>
      Effect.gen(function* () {
        yield* setup([{ call_id: CALL, text: "from an earlier session", session: otherSessionID }])
        const registry = yield* Tool.Service
        const result = output(yield* executeTool(registry, call({ call_id: CALL })))
        expect(result.found).toBe(true)
        expect(result.output).toBe("from an earlier session")
      }),
    ),
  )

  it.live("reports an unknown call id", () =>
    withDataDir(() =>
      Effect.gen(function* () {
        yield* setup([{ call_id: CALL, text: "hello" }])
        const registry = yield* Tool.Service
        const result = output(yield* executeTool(registry, call({ call_id: "call_missing" })))
        expect(result.found).toBe(false)
        expect(result.output).toBeUndefined()
      }),
    ),
  )
})
