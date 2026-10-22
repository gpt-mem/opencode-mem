import { describe, expect } from "bun:test"
import path from "path"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { ToolOutput } from "@opencode/core/tool-output"
import type { Tool } from "@opencode/core/tool"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"

const withStore = <A, E, R>(
  body: (output: ToolOutput.Interface, fs: FSUtil.Interface, root: string) => Effect.Effect<A, E, R>,
  limits?: { maxLines?: number; maxBytes?: number },
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => {
      const layer = AppNodeBuilder.build(LayerNode.group([ToolOutput.node, FSUtil.node]), [
        Global.node.replace(Global.layerWith({ data: tmp.path })),
      ])
      return Effect.gen(function* () {
        const output = yield* ToolOutput.Service
        const fs = yield* FSUtil.Service
        if (limits) yield* output.transform((editor) => editor.configure(limits))
        return yield* body(output, fs, tmp.path)
      }).pipe(Effect.provide(layer))
    },
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

describe("ToolOutput", () => {
  it.live("writes oversized text and returns a bounded preview", () =>
    withStore(
      (service, fs) =>
        Effect.gen(function* () {
          const output = { items: [1, 2, 3] }
          const result = yield* service.truncate({ output, content: [{ type: "text", text: "one\ntwo\nthree" }] })
          expect(result.output).toBe(output)
          expect(result.metadata).toMatchObject({ truncated: true })
          const outputPath = result.metadata?.outputPath
          expect(typeof outputPath).toBe("string")
          if (typeof outputPath !== "string") return
          expect(yield* fs.readFileString(outputPath)).toBe("one\ntwo\nthree")
          expect(result.content).toEqual([
            { type: "text", text: "one\ntwo" },
            {
              type: "text",
              text: `[showing lines 1-2 of 3; full output saved to ${outputPath} — read or grep that file instead of re-running the command]`,
            },
          ])
        }),
      { maxLines: 2, maxBytes: 1_000 },
    ),
  )

  it.live("keeps the default context budget at 2 KiB and spills the rest to a file", () =>
    withStore(
      (service, fs) =>
        Effect.gen(function* () {
          const text = Array.from({ length: 200 }, (_, index) => `line ${index} ${"x".repeat(30)}`).join("\n")
          const result = yield* service.truncate({ content: [{ type: "text", text }] })
          expect(result.metadata).toMatchObject({ truncated: true })
          const outputPath = result.metadata?.outputPath
          if (typeof outputPath !== "string") return
          expect(yield* fs.readFileString(outputPath)).toBe(text)
          const preview = result.content
            .flatMap((item) => (item.type === "text" ? [item.text] : []))
            .filter((value) => !value.startsWith("[showing"))
            .join("")
          expect(Buffer.byteLength(preview)).toBeLessThanOrEqual(ToolOutput.MAX_BYTES)
          expect(ToolOutput.MAX_BYTES).toBe(2 * 1024)
        }),
    ),
  )

  it.live("reports lines shown under the byte limit", () =>
    withStore(
      (output) =>
        Effect.gen(function* () {
          const result = yield* output.truncate({ content: [{ type: "text", text: "one\ntwo" }] })
          expect(result.content).toEqual([
            { type: "text", text: "one" },
            {
              type: "text",
              text: expect.stringMatching(
                /^\[showing lines 1-1 of 2; full output saved to .+ — read or grep that file instead of re-running the command\]$/,
              ),
            },
          ])
        }),
      { maxLines: 100, maxBytes: 5 },
    ),
  )

  it.live("names the retrieval tool in the marker when the call id is known", () =>
    withStore(
      (output) =>
        Effect.gen(function* () {
          const result = yield* output.truncate({ content: [{ type: "text", text: "one\ntwo" }] }, "call_abc")
          expect(result.content).toEqual([
            { type: "text", text: "one" },
            {
              type: "text",
              text: expect.stringMatching(
                /^\[showing lines 1-1 of 2; full output saved to .+ — read or grep that file instead of re-running the command, or retrieve the original output with get_tool_call_details\(call_id="call_abc"\)\]$/,
              ),
            },
          ])
        }),
      { maxLines: 100, maxBytes: 5 },
    ),
  )

  it.live("preserves mixed content ordering", () =>
    withStore(
      (output) =>
        Effect.gen(function* () {
          const file = { type: "file" as const, uri: "file:///image.png", mime: "image/png" }
          const result = yield* output.truncate({
            content: [{ type: "text", text: "before" }, file, { type: "text", text: "after\nomitted" }],
          })
          expect(result.content).toEqual([
            { type: "text", text: "before" },
            file,
            { type: "text", text: "after" },
            { type: "text", text: expect.stringMatching(/^\[showing lines 1-2 of 3; full output saved to .+ — read or grep/) },
          ])
        }),
      { maxLines: 2, maxBytes: 1_000 },
    ),
  )

  it.live("skips results that report a truncation state", () =>
    withStore((output) =>
      Effect.gen(function* () {
        const content: Tool.NormalizedResult["content"] = [{ type: "text", text: "one\ntwo" }]
        const truncated = { content, metadata: { truncated: true, source: "tool" } }
        const retained = { content, metadata: { truncated: false, source: "tool" } }
        expect(yield* output.truncate(truncated)).toBe(truncated)
        expect(yield* output.truncate(retained)).toBe(retained)
      }),
    ),
  )

  it.live("marks results that fit without changing their content", () =>
    withStore((output) =>
      Effect.gen(function* () {
        const content = [{ type: "text" as const, text: "small" }]
        expect(yield* output.truncate({ content })).toEqual({ content, metadata: { truncated: false } })
      }),
    ),
  )

  it.live("does not count a trailing newline as another line", () =>
    withStore(
      (output) =>
        Effect.gen(function* () {
          expect(yield* output.truncate({ content: [{ type: "text", text: "one\ntwo\n" }] })).toEqual({
            content: [{ type: "text", text: "one\ntwo\n" }],
            metadata: { truncated: false },
          })
        }),
      { maxLines: 2, maxBytes: 1_000 },
    ),
  )

  it.live("reports a trailing newline omitted by the byte limit", () =>
    withStore(
      (output) =>
        Effect.gen(function* () {
          const result = yield* output.truncate({ content: [{ type: "text", text: "one\n" }] })
          expect(result.content).toEqual([
            { type: "text", text: "one" },
            { type: "text", text: expect.stringMatching(/^\[showing lines 1-1 of 1; full output saved to .+ — read or grep/) },
          ])
        }),
      { maxLines: 2, maxBytes: 3 },
    ),
  )

  it.live("uses file modification time when IDs wrap", () =>
    withStore((output, fs, root) =>
      Effect.gen(function* () {
        const directory = path.join(root, ToolOutput.DIRECTORY)
        const old = path.join(directory, ToolOutput.fileName(2 ** 36 - 1))
        const recent = path.join(directory, ToolOutput.fileName(2 ** 36 + 1))
        yield* fs.ensureDir(directory)
        yield* fs.writeFileString(old, "old")
        yield* fs.writeFileString(recent, "recent")
        yield* fs.utimes(old, new Date(), new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000))
        yield* output.cleanup()
        expect(yield* fs.exists(old)).toBe(false)
        expect(yield* fs.exists(recent)).toBe(true)
      }),
    ),
  )
})
