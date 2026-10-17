import { describe, expect, test } from "bun:test"
import { generateSystemdUnit, systemdUnitPath } from "../../src/scheduler/systemd"

describe("systemd", () => {
  test("unit path", () => {
    expect(systemdUnitPath("abc")).toContain("systemd/user/abc.service")
  })
  test("unit content", () => {
    const u = generateSystemdUnit({ id: "abc", schedule: "* * * * *", command: "echo hi", workdir: "/tmp" })
    expect(u).toContain("ExecStart")
    expect(u).toContain("WorkingDirectory=/tmp")
  })
})
