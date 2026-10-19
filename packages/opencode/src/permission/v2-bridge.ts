import { makeLocationNode } from "@opencode-ai/core/effect/app-node"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { Effect, Layer } from "effect"
import { Permission } from "@/permission"

// The core tools (bash, read, edit, ...) enforce permissions through the V2 permission
// service, but the V1 line answers permission requests through the V1 service: the CLI, the
// TUI and the ACP client only speak V1. Without a bridge the core tools either hang (nobody
// answers the V2 request) or are denied outright.
//
// The bridge keeps V1 semantics end to end: the V1 ruleset decides, the V1 request flow
// asks, and a rejected request still reaches the model as a tool error.
const layer = Layer.effect(
  PermissionV2.Service,
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const agents = yield* Agent.Service
    const sessions = yield* Session.Service

    const ruleset = Effect.fn("PermissionV2Bridge.ruleset")(function* (input: PermissionV2.AssertInput) {
      const agent = input.agent
        ? yield* agents.get(input.agent).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        : undefined
      const session = yield* sessions
        .get(input.sessionID as unknown as Session.Info["id"])
        .pipe(Effect.catchCause(() => Effect.succeed(undefined)))
      return Permission.merge(agent?.permission ?? [], session?.permission ?? [])
    })

    const ask = Effect.fn("PermissionV2Bridge.ask")(function* (input: PermissionV2.AssertInput) {
      const rules = yield* ruleset(input)
      return yield* permission
        .ask({
          id: input.id as PermissionV1.ID | undefined,
          permission: input.action,
          patterns: input.resources,
          sessionID: input.sessionID as unknown as Session.Info["id"],
          metadata: input.metadata ?? {},
          always: input.save ?? [],
          ruleset: rules,
          tool:
            input.source?.type === "tool"
              ? { messageID: input.source.messageID, callID: input.source.callID }
              : undefined,
        })
        .pipe(
          Effect.catchTag("PermissionDeniedError", (error) => Effect.die(error)),
          Effect.catchTag("PermissionRejectedError", (error) => Effect.die(error)),
          Effect.catchTag("PermissionCorrectedError", (error) => Effect.die(error)),
        )
    })

    const request = (input: PermissionV1.Request): PermissionV2.Request => ({
      id: input.id as unknown as PermissionV2.ID,
      sessionID: input.sessionID as unknown as PermissionV2.Request["sessionID"],
      action: input.permission,
      resources: input.patterns,
      save: input.always,
      metadata: input.metadata,
      source: input.tool ? { type: "tool", messageID: input.tool.messageID, callID: input.tool.callID } : undefined,
    })

    return PermissionV2.Service.of({
      ask: (input) =>
        Effect.gen(function* () {
          const rules = yield* ruleset(input)
          const effects = input.resources.map((resource) => Permission.evaluate(input.action, resource, rules).action)
          const effect = effects.includes("deny") ? "deny" : effects.includes("ask") ? "ask" : "allow"
          if (effect === "ask") yield* ask(input)
          return { id: input.id ?? PermissionV2.ID.create(), effect }
        }),
      assert: (input) => ask(input),
      reply: (input) =>
        permission.reply({
          requestID: input.requestID as unknown as PermissionV1.ID,
          reply: input.reply,
          message: input.message,
        }) as unknown as Effect.Effect<void, PermissionV2.NotFoundError>,
      get: (id) =>
        Effect.gen(function* () {
          const found = (yield* permission.list()).find((item) => item.id === (id as unknown as PermissionV1.ID))
          return found ? request(found) : undefined
        }),
      forSession: (sessionID) =>
        Effect.gen(function* () {
          const found = (yield* permission.list()).filter(
            (item) => item.sessionID === (sessionID as unknown as PermissionV1.Request["sessionID"]),
          )
          return found.map(request)
        }),
      list: () => Effect.map(permission.list(), (items) => items.map(request)),
    })
  }),
)

export const node = makeLocationNode({
  service: PermissionV2.Service,
  layer,
  deps: [Permission.node, Agent.node, Session.node],
})

export * as PermissionV2Bridge from "./v2-bridge"
