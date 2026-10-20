import { expect, test } from "bun:test"
import { ClientApi } from "@opencode/protocol/client"
import { MockApi } from "../utils/mock-api"
import { MOCK_API_UNCOVERED_ROUTES } from "../utils/mock-api.uncovered"

// The e2e mock is a hand-written subset of the server API. Nothing in the mock is derived from the
// protocol, so a server route that moves or disappears leaves the mock serving a fiction and the whole
// app e2e suite keeps passing. These two contracts keep the mock honest.
function routes(api: { groups: Record<string, { endpoints: Record<string, { method: string; path: string }> }> }) {
  return Object.values(api.groups).flatMap((group) =>
    Object.values(group.endpoints).map((endpoint) => `${endpoint.method} ${endpoint.path}`),
  )
}

const serverRoutes = new Set(routes(ClientApi))
const mockRoutes = routes(MockApi)

test("every mocked route exists on the server API", () => {
  expect(mockRoutes.filter((route) => !serverRoutes.has(route)).sort()).toEqual([])
})

test("every server route the mock skips is listed", () => {
  expect([...serverRoutes].filter((route) => !mockRoutes.includes(route)).sort()).toEqual(
    [...MOCK_API_UNCOVERED_ROUTES].sort(),
  )
})
