import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { acquireLock, releaseLock } from "../../src/scheduler/supervisor"

describe("supervisor lock", () => {
  test("acquire and release", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sched-"))
    const lock = path.join(dir, "a.lock")
    expect(acquireLock(lock).acquired).toBe(true)
    expect(acquireLock(lock).acquired).toBe(false)
    releaseLock(lock)
    expect(acquireLock(lock).acquired).toBe(true)
    releaseLock(lock)
  })

  test("stale lock recovery", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sched-"))
    const lock = path.join(dir, "b.lock")
    // write a lock with a dead pid
    require("node:fs").writeFileSync(lock, JSON.stringify({ pid: 999999, startedAt: 0 }))
    expect(acquireLock(lock).acquired).toBe(true)
    releaseLock(lock)
  })
})
