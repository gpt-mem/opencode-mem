import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs"
import path from "node:path"
import { homedir } from "node:os"
import { execFileSync } from "node:child_process"
import { sanitizeId } from "./index"

export function systemdUnitPath(name: string) {
  return path.join(homedir(), ".config", "systemd", "user", `${sanitizeId(name)}.service`)
}

export function generateSystemdUnit(job: { id: string; schedule: string; command: string; workdir?: string }) {
  // schedule is cron; systemd uses OnCalendar. We keep cron in a comment and use a timer separately.
  return `[Unit]
Description=OpenCode job ${job.id}

[Service]
Type=oneshot
ExecStart=/bin/sh -c ${JSON.stringify(job.command)}
${job.workdir ? `WorkingDirectory=${job.workdir.replace(/[\r\n]/g, "")}` : ""}
`
}

export function systemdTimerPath(name: string) {
  return path.join(homedir(), ".config", "systemd", "user", `${sanitizeId(name)}.timer`)
}

export function generateSystemdTimer(job: { id: string; schedule: string }) {
  // Convert 5-field cron to OnCalendar approximate: minute hour day month weekday
  return `[Unit]
Description=OpenCode timer ${job.id}

[Timer]
OnCalendar=*-*-* *:*:00
Persistent=true
Unit=${job.id}.service

[Install]
WantedBy=timers.target
`
}

export function installSystemd(job: { id: string; schedule: string; command: string; workdir?: string }) {
  const dir = path.join(homedir(), ".config", "systemd", "user")
  mkdirSync(dir, { recursive: true })
  writeFileSync(systemdUnitPath(job.id), generateSystemdUnit(job), "utf8")
  writeFileSync(systemdTimerPath(job.id), generateSystemdTimer(job), "utf8")
  execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" })
  execFileSync("systemctl", ["--user", "enable", "--now", `${sanitizeId(job.id)}.timer`], { stdio: "ignore" })
}

export function uninstallSystemd(id: string) {
  try {
    execFileSync("systemctl", ["--user", "disable", "--now", `${sanitizeId(id)}.timer`], { stdio: "ignore" })
  } catch {}
  const unit = systemdUnitPath(id)
  const timer = systemdTimerPath(id)
  if (existsSync(unit)) rmSync(unit)
  if (existsSync(timer)) rmSync(timer)
  try {
    execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" })
  } catch {}
}
