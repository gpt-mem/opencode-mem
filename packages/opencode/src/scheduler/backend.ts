import { platform } from "node:os"
import { installLaunchd, uninstallLaunchd } from "./launchd"
import { installSystemd, uninstallSystemd } from "./systemd"
import { installCron, uninstallCron } from "./cron"
import { installSchtasks, uninstallSchtasks } from "./schtasks"

export type JobLike = { id: string; schedule: string; command: string; workdir?: string }

export function installJob(job: JobLike, scope = "default"): void {
  if (platform() === "darwin") {
    installLaunchd(job as any, scope)
    return
  }
  if (platform() === "linux") {
    try {
      installSystemd(job)
      return
    } catch {
      installCron(job.id, job.schedule, job.command)
      return
    }
  }
  if (platform() === "win32") {
    installSchtasks(job.id, job.schedule, job.command)
    return
  }
  throw new Error(`unsupported platform ${platform()}`)
}

export function uninstallJob(id: string, scope = "default"): void {
  if (platform() === "darwin") {
    uninstallLaunchd(scope, id)
    return
  }
  if (platform() === "linux") {
    uninstallSystemd(id)
    uninstallCron(id)
    return
  }
  if (platform() === "win32") {
    uninstallSchtasks(id)
    return
  }
}
