import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { generateLaunchdPlist } from "./index"
import type { Job } from "./index"

export type Scope = string

export function launchdLabel(scope: Scope, id: string) {
  return `com.opencode.job.${scope}.${id}`
}

export function launchdPlistPath(scope: Scope, id: string) {
  return path.join(homedir(), "Library", "LaunchAgents", `${launchdLabel(scope, id)}.plist`)
}

export function installLaunchd(job: Job, scope: Scope = "default"): string {
  const label = launchdLabel(scope, job.id)
  const file = launchdPlistPath(scope, job.id)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, generateLaunchdPlist(job, 0, scope), "utf8")
  const uid = process.getuid?.() ?? 501
  execFileSync("launchctl", ["bootstrap", `gui/${uid}`, file], { stdio: "ignore" })
  return file
}

export function uninstallLaunchd(scope: Scope, id: string): void {
  const label = launchdLabel(scope, id)
  const file = launchdPlistPath(scope, id)
  const uid = process.getuid?.() ?? 501
  try {
    execFileSync("launchctl", ["bootout", `gui/${uid}/${label}`], { stdio: "ignore" })
  } catch {}
  try {
    if (existsSync(file)) rmSync(file)
  } catch {}
}

export function runLaunchdNow(scope: Scope, id: string): void {
  const label = launchdLabel(scope, id)
  const uid = process.getuid?.() ?? 501
  execFileSync("launchctl", ["kickstart", "-k", `gui/${uid}/${label}`], { stdio: "ignore" })
}
