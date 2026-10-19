import { execFileSync } from "node:child_process"

const BEGIN = "# BEGIN opencode-scheduler"
const END = "# END opencode-scheduler"

export function installCron(id: string, cronExpr: string, command: string): void {
  if (/[\r\n]/.test(cronExpr) || /[\r\n]/.test(command) || /[\r\n]/.test(id)) throw new Error("invalid cron input")
  let existing = ""
  try {
    existing = execFileSync("crontab", ["-l"], { encoding: "utf8" })
  } catch {}
  const lines = existing.split("\n").filter((l) => l.trim() !== "")
  const filtered = lines.filter((l) => !l.includes(`opencode-scheduler:${id}`))
  const next = [...filtered, `${cronExpr} ${command} # opencode-scheduler:${id}`].join("\n") + "\n"
  // write via stdin
  const proc = Bun.spawnSync(["crontab", "-"], { stdin: new TextEncoder().encode(next) })
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString())
}

export function uninstallCron(id?: string): void {
  let existing = ""
  try {
    existing = execFileSync("crontab", ["-l"], { encoding: "utf8" })
  } catch {
    return
  }
  const lines = existing.split("\n").filter((l) => {
    if (!l.includes("opencode-scheduler")) return true
    if (!id) return false
    return !l.includes(`opencode-scheduler:${id}`)
  })
  const next = lines.join("\n") + "\n"
  Bun.spawnSync(["crontab", "-"], { stdin: new TextEncoder().encode(next) })
}
