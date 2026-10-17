import { spawn } from "node:child_process"
import { acquireLock, releaseLock } from "./supervisor"

export type SupervisedResult = { status: "success" | "timeout" | "error"; exitCode: number | null; error?: string }

export async function runSupervised(opts: {
  command: string
  workdir?: string
  timeoutMs: number
  lockFile: string
  onOutput?: (chunk: string) => void
}): Promise<SupervisedResult> {
  const lock = acquireLock(opts.lockFile)
  if (!lock.acquired) return { status: "error", exitCode: null, error: "already running" }

  return await new Promise<SupervisedResult>((resolve) => {
    const child = spawn("/bin/sh", ["-c", opts.command], { cwd: opts.workdir, stdio: ["ignore", "pipe", "pipe"] })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill("SIGTERM") } catch {}
    }, opts.timeoutMs)

    child.stdout?.on("data", (d) => opts.onOutput?.(d.toString()))
    child.stderr?.on("data", (d) => opts.onOutput?.(d.toString()))

    child.on("close", (code) => {
      clearTimeout(timer)
      releaseLock(opts.lockFile)
      if (timedOut) resolve({ status: "timeout", exitCode: code })
      else if (code === 0) resolve({ status: "success", exitCode: code })
      else resolve({ status: "error", exitCode: code })
    })

    child.on("error", (err) => {
      clearTimeout(timer)
      releaseLock(opts.lockFile)
      resolve({ status: "error", exitCode: null, error: err.message })
    })
  })
}
