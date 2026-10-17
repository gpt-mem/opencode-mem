import { execFileSync } from "node:child_process"
import { sanitizeId } from "./index"

export function installSchtasks(name: string, cronExpr: string, command: string): void {
  const safe = sanitizeId(name)
  if (/[\r\n"]/.test(command)) throw new Error("invalid command")
  execFileSync("schtasks", ["/Create", "/TN", `\\OpenCode\\${safe}`, "/TR", `"${command}"`, "/SC", "DAILY", "/ST", "09:00", "/F"], { stdio: "ignore" })
}

export function uninstallSchtasks(name: string): void {
  const safe = sanitizeId(name)
  try { execFileSync("schtasks", ["/Delete", "/TN", `\\OpenCode\\${safe}`, "/F"], { stdio: "ignore" }) } catch {}
}
