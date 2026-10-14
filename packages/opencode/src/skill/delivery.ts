import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ConfigMCPV1 } from "@opencode-ai/core/v1/config/mcp"
import { Schema } from "effect"
import { Effect, Layer, Context } from "effect"
import { Global } from "@opencode-ai/core/global"
import { MCP } from "@/mcp"
import path from "node:path"

export const Manifest = Schema.Struct({
  repo: Schema.optional(Schema.String),
  commit: Schema.optional(Schema.String),
  cachePath: Schema.String,
  toolFiles: Schema.mutable(Schema.Array(Schema.String)),
}).annotate({ identifier: "SkillDeliveryManifest" })
export type Manifest = Schema.Schema.Type<typeof Manifest>

function candidatePaths() {
  const paths = [
    process.env.OPENCODE_SKILL_MANIFEST,
    path.join(Global.Path.data, "skill-manifest.json"),
    path.join(Global.Path.cache, "skill-manifest.json"),
    path.join(Global.Path.config, "skill-manifest.json"),
  ]
  return paths.filter((value): value is string => typeof value === "string" && value.length > 0) as string[]
}

function resolveToolPath(cachePath: string, file: string) {
  return path.isAbsolute(file) ? file : path.join(cachePath, file)
}

function sanitizeName(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_")
}

export const consumeManifest = Effect.fn("SkillDelivery.consumeManifest")(function* (mcp: MCP.Interface) {
  let manifest: Manifest | undefined
  for (const manifestPath of candidatePaths()) {
    const exists = yield* Effect.promise(() => Bun.file(manifestPath).exists()).pipe(
      Effect.catch(() => Effect.succeed(false)),
    )
    if (!exists) continue
    const decoded = yield* Effect.tryPromise(() => Bun.file(manifestPath).json()).pipe(
      Effect.flatMap((value) => Schema.decodeUnknownEffect(Manifest)(value)),
      Effect.catch(() => Effect.succeed(undefined)),
    )
    if (decoded !== undefined) {
      manifest = decoded
      break
    }
  }

  if (!manifest) return

  for (const file of manifest.toolFiles) {
    const toolPath = resolveToolPath(manifest.cachePath, file)
    const exists = yield* Effect.promise(() => Bun.file(toolPath).exists()).pipe(
      Effect.catch(() => Effect.succeed(false)),
    )
    if (!exists) continue

    const name = `skill_${sanitizeName(path.basename(file, path.extname(file)))}`
    const config: ConfigMCPV1.Info = {
      type: "local",
      command: [process.execPath, toolPath],
      enabled: true,
    }

    yield* mcp.add(name, config).pipe(Effect.catch(() => Effect.void))
  }
})

export interface Interface {
  readonly init: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SkillDelivery") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    const init = Effect.fn("SkillDelivery.init")(function* () {
      yield* consumeManifest(mcp).pipe(Effect.catchCause(() => Effect.void))
    })
    yield* init().pipe(Effect.catchCause((cause) => Effect.logWarning("skill delivery failed", { cause })))
    return Service.of({ init })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [MCP.node],
})

export * as SkillDelivery from "."
