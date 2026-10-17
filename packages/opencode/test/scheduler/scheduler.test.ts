import { describe, expect, test } from "bun:test"
import { cronToCalendar, generateLaunchdPlist } from "../../src/scheduler"

describe("scheduler cronToCalendar", () => {
  test("expands wildcard", () => {
    const c = cronToCalendar("* * * * *")
    expect(c.length).toBe(1)
    expect(c[0]).toEqual({})
  })

  test("specific time", () => {
    const c = cronToCalendar("30 9 * * 1")
    expect(c).toEqual([{ Minute: 30, Hour: 9, Weekday: 1 }])
  })

  test("list expands", () => {
    const c = cronToCalendar("0 9 1,15 * *")
    expect(c.length).toBe(2)
  })
})

describe("generateLaunchdPlist", () => {
  test("contains label and calendar", () => {
    const p = generateLaunchdPlist({ id: "abc", schedule: "0 9 * * *", command: "echo hi" }, 501)
    expect(p).toContain("com.opencode.job.default.abc")
    expect(p).toContain("<key>Hour</key>")
    expect(p).toContain("echo hi")
  })
})
