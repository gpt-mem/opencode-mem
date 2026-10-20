import { expect, test } from "bun:test"
import { ClientApi } from "@opencode/protocol/client"
import { Effect, Result, Schema } from "effect"
import { HttpApi, HttpApiGroup } from "effect/http-api"
import { project, provider, session } from "../utils/app"
import { MockApi } from "../utils/mock-api"
import { createMockServerHandler } from "../utils/mock-server"

// The promise client the app uses parses responses without checking them against the protocol, so a mock
// answer that no server would send reaches the UI unchanged. This contract decodes every answer the mock
// gives with the success schema of the server route it stands in for.
//
// Error bodies are a separate axis: the mock answers with its own error tags, so only successful answers
// are checked here.
const directory = "C:/OpenCode/contract"

const sessionID = "ses_contract"

const projectID = "proj_contract"

const handler = createMockServerHandler({
  provider: provider({ id: "test-model", name: "Test Model" }),
  pageMessages: () => ({ items: [] }),
  directory,
  project: project({ id: projectID, directory, name: "contract" }),
  sessions: [session({ id: sessionID, directory, projectID, title: "Contract" })],
})

type Endpoint = { method: string; path: string; success: ReadonlySet<Schema.Top> }

function endpoints<Id extends string, Groups extends HttpApiGroup.Constraint>(api: HttpApi.HttpApi<Id, Groups>) {
  const found: Endpoint[] = []

  HttpApi.reflect(api, {
    onGroup: () => {},
    onEndpoint: ({ endpoint }) => {
      found.push({ method: endpoint.method, path: endpoint.path, success: endpoint.success })
    },
  })

  return found
}

// Decodes an answer with the success schema of a server route.
function decodeWith(schema: Schema.Top) {
  // SAFETY: an endpoint erases its success schemas to `Schema.Top`, whose decoding services are `any`;
  // the protocol's own schemas decode without services.
  const decode = Schema.decodeUnknownEffect(schema) as (
    input: Schema.Json,
  ) => Effect.Effect<unknown, Schema.SchemaError, never>

  return (input: Schema.Json) => Effect.runPromise(Effect.result(decode(input)))
}

// The ids the canonical scenario knows about; every other path parameter gets a placeholder that answers
// with "not found" instead of a body to check.
const ids = new Map([
  ["sessionID", sessionID],
  ["projectID", projectID],
])

function request(method: string, path: string) {
  const url = path.replace(/:([A-Za-z]+)/g, (_, name: string) => ids.get(name) ?? `probe_${name}`)

  return new Request(`http://127.0.0.1:3000${url}`, {
    method,
    headers: method === "GET" ? undefined : { "content-type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify({}),
  })
}

test("every answer the mock gives satisfies the server schema", async () => {
  const server = new Map(endpoints(ClientApi).map((endpoint) => [`${endpoint.method} ${endpoint.path}`, endpoint]))
  const failures: string[] = []

  for (const route of endpoints(MockApi)) {
    const counterpart = server.get(`${route.method} ${route.path}`)

    if (!counterpart) continue

    const response = await handler.handler(request(route.method, route.path))

    if (!response.ok) continue

    const body = await response.text()

    const parsed = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Json))(body)

    if (Result.isFailure(parsed)) continue

    const decoded = await Promise.all([...counterpart.success].map((schema) => decodeWith(schema)(parsed.success)))

    const rejected = decoded.filter(Result.isFailure)

    if (decoded.length > 0 && rejected.length === decoded.length)
      failures.push(`${route.method} ${route.path}: ${rejected.map((result) => String(result.failure)).join("; ")}`)
  }

  expect(failures).toEqual([])
})
