import { writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs"
import path from "node:path"

export type LockInfo = { pid: number; startedAt: number }

export function acquireLock(lockFile: string): { acquired: boolean; stale: boolean } {
  mkdirSync(path.dirname(lockFile), { recursive: true })
  if (existsSync(lockFile)) {
    try {
      const info = JSON.parse(readFileSync(lockFile, "utf8")) as LockInfo
      try {
        process.kill(info.pid, 0)
        return { acquired: false, stale: false }
      } catch {
        unlinkSync(lockFile)
      }
    } catch {
      try { unlinkSync(lockFile) } catch {}
    }
  }
  writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), "utf8")
  return { acquired: true, stale: false }
}

export function releaseLock(lockFile: string): void {
  try { if (existsSync(lockFile)) unlinkSync(lockFile) } catch {}
}
