import { execFileSync } from "node:child_process"

export function installSchtasks(name: string, cronExpr: string, command: string): void {
  // Simplified: daily at 09:00 fallback
  execFileSync("schtasks", ["/Create", "/TN", `\\OpenCode\\${name}`, "/TR", command, "/SC", "DAILY", "/ST", "09:00", "/F"], { stdio: "ignore" })
}

export function uninstallSchtasks(name: string): void {
  try { execFileSync("schtasks", ["/Delete", "/TN", `\\OpenCode\\${name}`, "/F"], { stdio: "ignore" }) } catch {}
}
