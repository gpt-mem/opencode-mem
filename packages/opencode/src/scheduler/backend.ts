import { platform } from "node:os"
import * as launchd from "./launchd"
import * as systemd from "./systemd"
import * as cron from "./cron"
import * as schtasks from "./schtasks"

export type JobLike = { id: string; schedule: string; command: string; workdir?: string }

export function installJob(job: JobLike, scope = "default"): void {
  if (platform() === "darwin") { launchd.installLaunchd(job as any, scope); return }
  if (platform() === "linux") {
    try { return systemd.installSystemd(job) } catch { return cron.installCron(job.schedule, job.command) }
  }
  if (platform() === "win32") return schtasks.installSchtasks(job.id, job.schedule, job.command)
  throw new Error(`unsupported platform ${platform()}`)
}

export function uninstallJob(id: string, scope = "default"): void {
  if (platform() === "darwin") return launchd.uninstallLaunchd(scope, id)
  if (platform() === "linux") return systemd.uninstallSystemd(id)
  if (platform() === "win32") return schtasks.uninstallSchtasks(id)
}
