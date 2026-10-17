import { execFileSync } from "node:child_process"

const BEGIN = "# BEGIN opencode-scheduler"
const END = "# END opencode-scheduler"

export function installCron(cronExpr: string, command: string): void {
  let existing = ""
  try { existing = execFileSync("crontab", ["-l"], { encoding: "utf8" }) } catch {}
  const lines = existing.split("\n").filter((l) => l.trim() !== "")
  const filtered = lines.filter((l) => !(l.includes("opencode-scheduler") || l.startsWith(BEGIN) || l.startsWith(END)))
  const next = [...filtered, `${cronExpr} ${command} # opencode-scheduler`, BEGIN, END].join("\n") + "\n"
  // write via stdin
  const proc = Bun.spawnSync(["crontab", "-"], { stdin: new TextEncoder().encode(next) })
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString())
}

export function uninstallCron(): void {
  let existing = ""
  try { existing = execFileSync("crontab", ["-l"], { encoding: "utf8" }) } catch { return }
  const lines = existing.split("\n").filter((l) => !l.includes("opencode-scheduler") && l !== BEGIN && l !== END)
  const next = lines.join("\n") + "\n"
  Bun.spawnSync(["crontab", "-"], { stdin: new TextEncoder().encode(next) })
}
