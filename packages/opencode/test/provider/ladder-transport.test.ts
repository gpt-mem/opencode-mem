import { describe, expect, test } from "bun:test"
import { LadderTransport } from "@/provider/ladder-transport"

describe("Ladder transport", () => {
  test("forwards one targeted projection and captures streaming response headers", async () => {
    const scope = `v1_${"a".repeat(32)}`
    const observed: Record<string, unknown>[] = []
    const replies: LadderTransport.Response[] = []
    const request = LadderTransport.register({
      variant: { rung: "opencode-go/mimo-v2.6-flash", scope, messages: [{ role: "user", content: "masked" }] },
      onResponse: (response) => replies.push(response),
    })
    try {
      await LadderTransport.fetchRequest(
        "https://ladder.example/v1/chat/completions",
        {
          method: "POST",
          headers: { ...LadderTransport.header(request.id), "x-session-affinity": "session-1" },
          body: JSON.stringify({ model: "service", messages: [{ role: "user", content: "compact" }] }),
        },
        async (_input, init) => {
          expect(new Headers(init?.headers).has("x-opencode-ladder-request")).toBe(false)
          observed.push(JSON.parse(String(init?.body)))
          return new Response("", {
            headers: {
              "x-ladder-model": "opencode-go/mimo-v2.6-flash",
              "x-ladder-cache-scope": scope,
              "x-ladder-cache-variant": "masked",
            },
          })
        },
      )
      expect(observed[0]).toEqual({
        model: "service",
        messages: [{ role: "user", content: "compact" }],
        ladder_conversation: "session-1",
        ladder_cache_variant: {
          rung: "opencode-go/mimo-v2.6-flash",
          cache_scope: scope,
          messages: [{ role: "user", content: "masked" }],
        },
      })
      expect(replies).toEqual([{ rung: "opencode-go/mimo-v2.6-flash", scope, variant: "masked" }])
    } finally {
      request.close()
    }
  })

  test("does not forward an overlarge variant", async () => {
    const request = LadderTransport.register({
      variant: {
        rung: "opencode-go/mimo-v2.6-flash",
        scope: `v1_${"a".repeat(32)}`,
        messages: [{ role: "user", content: "x".repeat(2_000_001) }],
      },
      onResponse: () => {},
    })
    try {
      await LadderTransport.fetchRequest(
        "https://ladder.example/v1/chat/completions",
        {
          method: "POST",
          headers: LadderTransport.header(request.id),
          body: JSON.stringify({ model: "service", messages: [{ role: "user", content: "compact" }] }),
        },
        async (_input, init) => {
          expect(JSON.parse(String(init?.body)).ladder_cache_variant).toBeUndefined()
          return new Response("", { status: 200 })
        },
      )
    } finally {
      request.close()
    }
  })

  test("retries a retired rung with the compact default after Ladder rejects the variant", async () => {
    const observed: boolean[] = []
    const replies: LadderTransport.Response[] = []
    const request = LadderTransport.register({
      variant: {
        rung: "opencode-go/old",
        scope: `v1_${"a".repeat(32)}`,
        messages: [{ role: "user", content: "masked" }],
      },
      onResponse: (response) => replies.push(response),
    })
    try {
      const response = await LadderTransport.fetchRequest(
        "https://ladder.example/v1/chat/completions",
        {
          method: "POST",
          headers: LadderTransport.header(request.id),
          body: JSON.stringify({ model: "service", messages: [{ role: "user", content: "compact" }] }),
        },
        async (_input, init) => {
          observed.push(!!JSON.parse(String(init?.body)).ladder_cache_variant)
          if (observed.length === 1)
            return Response.json({ error: { message: "invalid ladder_cache_variant" } }, { status: 400 })
          return new Response("", { headers: { "x-ladder-model": "opencode-go/new" } })
        },
      )
      expect(response.status).toBe(200)
      expect(observed).toEqual([true, false])
      expect(replies).toEqual([{ rung: "opencode-go/new", variant: "default" }])
    } finally {
      request.close()
    }
  })
})
