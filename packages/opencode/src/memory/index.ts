import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { MemRecordTable } from "@opencode-ai/core/session/sql"
import { Effect, Layer, Context } from "effect"
import { Global } from "@opencode-ai/core/global"

export const standardDataPath = () => Global.Path.data

export interface Interface {
  readonly init: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Memory") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const init = Effect.fn("Memory.init")(function* () {
      // The operational-memory store lives on the standard agent data path and
      // is created lazily by the database layer; keep init intentionally
      // lightweight so memory problems can never block tool registration.
      yield* Effect.void
    })
    return Service.of({ init })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Database.node],
})

export * as Memory from "."
