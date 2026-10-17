import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { installJob, uninstallJob } from "../scheduler/backend"
import { sanitizeId } from "../scheduler"

export const Parameters = Schema.Struct({
  action: Schema.Literals(["add", "remove"]),
  id: Schema.String,
  schedule: Schema.optional(Schema.String),
  command: Schema.optional(Schema.String),
  workdir: Schema.optional(Schema.String),
})

export const ScheduleTool = Tool.define<typeof Parameters, { id: string }, never>(
  "schedule_job",
  Effect.gen(function* () {
    return {
      description: "Install or remove an OS-level scheduled job (launchd/systemd/cron/schtasks).",
      parameters: Parameters,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "schedule_job",
            patterns: ["*"],
            always: ["*"],
            metadata: {},
          })

          const id = sanitizeId(params.id)
          if (params.action === "add") {
            if (!params.schedule || !params.command) {
              return yield* Effect.die(new Error("schedule and command required"))
            }
            installJob({ id, schedule: params.schedule, command: params.command, workdir: params.workdir })
            return { title: `scheduled ${id}`, output: `installed ${id}`, metadata: { id } }
          }
          uninstallJob(id)
          return { title: `removed ${id}`, output: `removed ${id}`, metadata: { id } }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, { id: string }>
  }),
)
