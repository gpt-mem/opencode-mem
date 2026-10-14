import { describe, expect } from "bun:test"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { Auth } from "@/auth"
import { testEffect } from "../lib/effect"
import { MCP } from "../../src/mcp/index"

const it = testEffect(LayerNode.compile(LayerNode.group([MCP.node, Auth.node])))

const saveMemGPTCredential = Effect.gen(function* () {
  const auth = yield* Auth.Service
  yield* auth.set("mem-gpt", { type: "api", key: "test-user-token" })
}).pipe(Effect.provide(LayerNode.compile(Auth.node)))

const serve = Effect.acquireRelease(
  Effect.promise(async () => {
    const requests: Headers[] = []
    const protocol = new Server({ name: "headers", version: "1.0.0" }, { capabilities: { tools: {} } })
    protocol.setRequestHandler(ListToolsRequestSchema, () => Promise.resolve({ tools: [] }))
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      enableJsonResponse: true,
    })
    await protocol.connect(transport)
    const http = Bun.serve({
      port: 0,
      fetch(request) {
        requests.push(new Headers(request.headers))
        return transport.handleRequest(request)
      },
    })
    return {
      requests,
      url: http.url.toString(),
      close: async () => {
        await http.stop(true)
        await protocol.close()
      },
    }
  }),
  (server) => Effect.promise(server.close),
)

describe("mcp.headers", () => {
  it.instance("headers are passed to transports when oauth is enabled (default)", () =>
    Effect.gen(function* () {
      const server = yield* serve
      const mcp = yield* MCP.Service
      const result = yield* mcp.add("test-server", {
        type: "remote",
        url: server.url,
        headers: {
          Authorization: "Bearer test-token",
          "X-Custom-Header": "custom-value",
        },
      })

      expect(result.status).toMatchObject({ "test-server": { status: "connected" } })
      expect(server.requests.length).toBeGreaterThan(0)
      for (const headers of server.requests) {
        expect(headers.get("authorization")).toBe("Bearer test-token")
        expect(headers.get("x-custom-header")).toBe("custom-value")
      }
    }),
  )

  it.instance("headers are passed to transports when oauth is explicitly disabled", () =>
    Effect.gen(function* () {
      const server = yield* serve
      const mcp = yield* MCP.Service
      const result = yield* mcp.add("test-server-no-oauth", {
        type: "remote",
        url: server.url,
        oauth: false,
        headers: {
          Authorization: "Bearer test-token",
        },
      })

      expect(result.status).toMatchObject({ "test-server-no-oauth": { status: "connected" } })
      expect(server.requests.length).toBeGreaterThan(0)
      for (const headers of server.requests) {
        expect(headers.get("authorization")).toBe("Bearer test-token")
      }
    }),
  )

  it.instance("API credentials referenced by authProviderID are sent as a Bearer token", () =>
    Effect.gen(function* () {
      const server = yield* serve
      yield* saveMemGPTCredential

      const mcp = yield* MCP.Service
      const result = yield* mcp.add("mem-gpt", {
        type: "remote",
        url: server.url,
        oauth: false,
        authProviderID: "mem-gpt",
        headers: {
          Authorization: "Bearer stale-token",
          "X-Custom-Header": "custom-value",
        },
      })

      expect(result.status).toMatchObject({ "mem-gpt": { status: "connected" } })
      expect(server.requests.length).toBeGreaterThan(0)
      for (const headers of server.requests) {
        expect(headers.get("authorization")).toBe("Bearer test-user-token")
        expect(headers.get("x-custom-header")).toBe("custom-value")
      }
    }),
  )

  it.instance("no requestInit when headers are not provided", () =>
    Effect.gen(function* () {
      const server = yield* serve
      const mcp = yield* MCP.Service
      const result = yield* mcp.add("test-server-no-headers", {
        type: "remote",
        url: server.url,
      })

      expect(result.status).toMatchObject({ "test-server-no-headers": { status: "connected" } })
      expect(server.requests.length).toBeGreaterThan(0)
      for (const headers of server.requests) {
        expect(headers.has("authorization")).toBe(false)
        expect(headers.has("x-custom-header")).toBe(false)
      }
    }),
  )
})
