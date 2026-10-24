import { describe, expect, test } from "bun:test"
import * as CacheMark from "@opencode/core/session/cache-mark"

const usage = (input: Partial<CacheMark.Usage> & { sentCount: number }): CacheMark.Usage => ({
  input: 100,
  output: 10,
  cacheRead: 0,
  cacheWrite: 0,
  ...input,
})

describe("CacheMark.applyUsage", () => {
  test("no cache activity collapses the mark to zero (free provider)", () => {
    expect(
      CacheMark.applyUsage({ tokens: 5000, index: 9 }, usage({ sentCount: 12, cacheRead: 0, cacheWrite: 0 })),
    ).toEqual({ tokens: 0, index: 0 })
  })

  test("first observation with cache activity marks the whole sent request", () => {
    expect(CacheMark.applyUsage(undefined, usage({ sentCount: 7, cacheRead: 4000, cacheWrite: 0 }))).toEqual({
      tokens: 4000,
      index: 7,
    })
  })

  test("growing cache_read advances the mark to the latest sent request", () => {
    expect(
      CacheMark.applyUsage({ tokens: 4000, index: 7 }, usage({ sentCount: 11, cacheRead: 9000, cacheWrite: 2000 })),
    ).toEqual({ tokens: 11000, index: 11 })
  })

  test("cache_read equal to the confirmed mark keeps growing through cache_write", () => {
    expect(
      CacheMark.applyUsage({ tokens: 4000, index: 7 }, usage({ sentCount: 9, cacheRead: 4000, cacheWrite: 1500 })),
    ).toEqual({ tokens: 5500, index: 9 })
  })

  test("cache_read fell below mark shrinks proportionally", () => {
    expect(
      CacheMark.applyUsage({ tokens: 8000, index: 10 }, usage({ sentCount: 12, cacheRead: 4000, cacheWrite: 0 })),
    ).toEqual({ tokens: 4000, index: 5 })
  })

  test("zero cache_read on existing mark shrinks index proportionally", () => {
    expect(
      CacheMark.applyUsage({ tokens: 8000, index: 10 }, usage({ sentCount: 12, cacheRead: 0, cacheWrite: 500 })),
    ).toEqual({ tokens: 0, index: 0 })
  })

  test("sentCount floors at 0", () => {
    expect(
      CacheMark.applyUsage({ tokens: 1000, index: 5 }, usage({ sentCount: 0, cacheRead: 1000, cacheWrite: 0 })),
    ).toEqual({ tokens: 1000, index: 0 })
  })
})

describe("CacheMark.verbatimPrefixLength", () => {
  test("identical arrays return full length", () => {
    const arr = [{ a: 1 }, { b: 2 }, { c: 3 }]
    expect(CacheMark.verbatimPrefixLength(arr, arr)).toBe(3)
  })

  test("first difference stops the prefix", () => {
    const a = { a: 1 }
    const b = { b: 2 }
    const c = { c: 3 }
    const original = [a, b, c]
    const projected = [a, { b: 99 }, c]
    expect(CacheMark.verbatimPrefixLength(projected, original)).toBe(1)
  })

  test("empty arrays return 0", () => {
    expect(CacheMark.verbatimPrefixLength([], [])).toBe(0)
  })

  test("projected longer than original is limited by original", () => {
    const a = { a: 1 }
    const original = [a]
    const projected = [a, { b: 2 }]
    expect(CacheMark.verbatimPrefixLength(projected, original)).toBe(1)
  })
})

describe("CacheMark.prefixHash", () => {
  test("deterministic for same input", () => {
    expect(CacheMark.prefixHash("hello")).toBe(CacheMark.prefixHash("hello"))
  })

  test("different for different input", () => {
    expect(CacheMark.prefixHash("hello")).not.toBe(CacheMark.prefixHash("world"))
  })

  test("empty string hashes", () => {
    expect(CacheMark.prefixHash("")).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe("CacheMark.messagePrefixHash", () => {
  test("strips description from system messages", () => {
    const messages = [{ type: "system", text: "hi", description: "volatile" }]
    const hash1 = CacheMark.messagePrefixHash(messages)
    const messages2 = [{ type: "system", text: "hi", description: "different" }]
    const hash2 = CacheMark.messagePrefixHash(messages2)
    // description stripped, so hashes equal
    expect(hash1).toBe(hash2)
  })

  test("includes text from user messages", () => {
    const messages1 = [{ type: "user", text: "hello" }]
    const messages2 = [{ type: "user", text: "world" }]
    expect(CacheMark.messagePrefixHash(messages1)).not.toBe(CacheMark.messagePrefixHash(messages2))
  })

  test("non-object items pass through", () => {
    const messages = ["not an object", null, undefined, { type: "user", text: "hi" }]
    expect(() => CacheMark.messagePrefixHash(messages)).not.toThrow()
  })
})