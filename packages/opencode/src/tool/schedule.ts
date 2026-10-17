import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { installJob, uninstallJob } from "../scheduler/backend"

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
      description: "Install or remove an OS-level scheduled job (launchd/systemd/schtasks/cron).",
      parameters: Parameters,
      execute: (params, _ctx) =>
        Effect.sync(() => {
          if (params.action === "add") {
            if (!params.schedule || !params.command) throw new Error("schedule and command required")
            installJob({ id: params.id, schedule: params.schedule, command: params.command, workdir: params.workdir })
            return { title: `scheduled ${params.id}`, output: `installed ${params.id}`, metadata: { id: params.id } }
          }
          uninstallJob(params.id)
          return { title: `removed ${params.id}`, output: `removed ${params.id}`, metadata: { id: params.id } }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, { id: string }>
  }),
)
