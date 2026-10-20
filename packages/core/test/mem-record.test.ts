import { describe, expect, it } from "bun:test"
import { MemRecord } from "../src/session/mem-record.js"

describe("MemRecord.resolveAuthority", () => {
  it("defaults to agent when decided_by is unset", () => {
    expect(MemRecord.resolveAuthority({ recorded_by: "build" })).toBe("agent")
  })

  it("keeps agent when decided_by equals the recording agent", () => {
    expect(MemRecord.resolveAuthority({ decided_by: "build", recorded_by: "build" })).toBe("agent")
  })

  it("elevates to user when a distinct person is named", () => {
    expect(MemRecord.resolveAuthority({ decided_by: "user", recorded_by: "build" })).toBe("user")
    expect(MemRecord.resolveAuthority({ decided_by: "vova", recorded_by: "build" })).toBe("user")
  })

  it("treats empty string as unset", () => {
    expect(MemRecord.resolveAuthority({ decided_by: "", recorded_by: "build" })).toBe("agent")
  })
})

describe("MemRecord.redactContent", () => {
  it("strips credential-like tokens", () => {
    const out = MemRecord.redactContent("token is sk-abcdef1234567890abcdef ok")
    expect(out).not.toContain("sk-abcdef1234567890abcdef")
    expect(out).toContain("[REDACTED:api_key]")
  })

  it("keeps ordinary decision text intact", () => {
    const text = "принято решение форкать опенкод и его развивать"
    expect(MemRecord.redactContent(text)).toBe(text)
  })

  it("bounds long content", () => {
    const out = MemRecord.redactContent("x".repeat(10000))
    expect(out.length).toBeLessThanOrEqual(4000)
  })
})

describe("MemRecord.normalizeSubject", () => {
  it("trims and bounds", () => {
    expect(MemRecord.normalizeSubject("  cache-mark ledger  ")).toBe("cache-mark ledger")
    expect(MemRecord.normalizeSubject("y".repeat(500)).length).toBeLessThanOrEqual(200)
  })
})
