import { describe, expect, test } from "bun:test"
import { launchdLabel, launchdPlistPath } from "../../src/scheduler/launchd"

describe("launchd helpers", () => {
  test("label", () => {
    expect(launchdLabel("default", "abc")).toBe("com.opencode.job.default.abc")
  })
  test("path", () => {
    const p = launchdPlistPath("default", "abc")
    expect(p).toContain("Library/LaunchAgents")
    expect(p).toContain("com.opencode.job.default.abc.plist")
  })
})
