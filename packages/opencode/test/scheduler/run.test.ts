import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { runSupervised } from "../../src/scheduler/run"

describe("runSupervised", () => {
  test("success", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sched-"))
    const r = await runSupervised({ command: "echo hi", timeoutMs: 5000, lockFile: path.join(dir, "x.lock") })
    expect(r.status).toBe("success")
    expect(r.exitCode).toBe(0)
  })

  test("timeout", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sched-"))
    const r = await runSupervised({ command: "sleep 5", timeoutMs: 100, lockFile: path.join(dir, "y.lock") })
    expect(r.status).toBe("timeout")
  })
})
