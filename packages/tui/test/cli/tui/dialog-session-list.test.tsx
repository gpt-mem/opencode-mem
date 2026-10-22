/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { onMount } from "solid-js"
import { DialogSessionList } from "../../../src/component/dialog-session-list"
import { ConfigProvider } from "../../../src/config"
import { ArgsProvider } from "../../../src/context/args"
import { ClientProvider } from "../../../src/context/client"
import { DataProvider, useData } from "../../../src/context/data"
import { Keymap } from "../../../src/context/keymap"
import { LocalProvider } from "../../../src/context/local"
import { LocationProvider } from "../../../src/context/location"
import { PermissionProvider } from "../../../src/context/permission"
import { RouteProvider, useRoute } from "../../../src/context/route"
import { TuiAppProvider } from "../../../src/context/runtime"
import { SessionTabsProvider } from "../../../src/context/session-tabs"
import { StorageProvider, useStorage } from "../../../src/context/storage"
import { ThemeProvider } from "../../../src/context/theme"
import { DialogProvider, useDialog } from "../../../src/ui/dialog"
import { ToastProvider } from "../../../src/ui/toast"
import { createApi, createEventStream, createFetch, json } from "../../fixture/tui-client"
import { emptyThemeSource, tmpdir } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

test("scopes sessions to the active session location", async () => {
  const active = "/tmp/opencode/project-b"
  const events = createEventStream()
  const requestedProjects: string[] = []
  const calls = createFetch((url) => {
    if (url.pathname === "/api/location") {
      const directory = url.searchParams.get("location[directory]") ?? process.cwd()
      const project = directory === active ? "proj_b" : "proj_a"
      return json({ directory, project: { id: project, directory, canonical: directory } })
    }
    if (url.pathname !== "/api/session") return undefined
    // Family syncs list children by parentID; only project-scoped list requests matter here.
    const parentID = url.searchParams.get("parentID")
    if (parentID && parentID !== "null") return json({ data: [], cursor: {} })
    const project = url.searchParams.get("project") ?? ""
    requestedProjects.push(project)
    return json({
      data: [
        {
          id: project === "proj_b" ? "ses_b" : "ses_a",
          projectID: project,
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1, updated: 2 },
          title: project === "proj_b" ? "Project B session" : "Project A session",
          location: { directory: project === "proj_b" ? active : process.cwd() },
        },
      ],
      cursor: {},
    })
  }, events)
  const temporary = await tmpdir()
  let storage!: ReturnType<typeof useStorage>

  function Probe() {
    const data = useData()
    const dialog = useDialog()
    const route = useRoute()
    storage = useStorage()
    onMount(() => {
      data.session.remember({
        id: "ses_active",
        projectID: "proj_b",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 1, updated: 3 },
        title: "Active session",
        location: { directory: active },
      })
      route.navigate({ type: "session", sessionID: "ses_active" })
      dialog.replace(() => <DialogSessionList />)
    })
    return null
  }

  const app = await testRender(
    () => (
      <TestTuiContexts paths={{ state: temporary.path }}>
        <TuiAppProvider value={{ name: "test", version: "test", channel: "test" }}>
          <StorageProvider>
            <ArgsProvider>
              <ConfigProvider config={createTuiResolvedConfig()}>
                <Keymap.Provider>
                  <ToastProvider>
                    <RouteProvider>
                      <ClientProvider api={createApi(calls.fetch)}>
                        <PermissionProvider>
                          <DataProvider directory={process.cwd()}>
                            <LocationProvider>
                              <SessionTabsProvider>
                                <ThemeProvider mode="dark" source={emptyThemeSource}>
                                  <LocalProvider>
                                    <DialogProvider>
                                      <Probe />
                                    </DialogProvider>
                                  </LocalProvider>
                                </ThemeProvider>
                              </SessionTabsProvider>
                            </LocationProvider>
                          </DataProvider>
                        </PermissionProvider>
                      </ClientProvider>
                    </RouteProvider>
                  </ToastProvider>
                </Keymap.Provider>
              </ConfigProvider>
            </ArgsProvider>
          </StorageProvider>
        </TuiAppProvider>
      </TestTuiContexts>
    ),
    { width: 100, height: 30, kittyKeyboard: true },
  )
  app.renderer.start()

  try {
    const frame = await app.waitForFrame((value) => value.includes("Project B session"))
    expect(frame).not.toContain("Project A session")
    expect(requestedProjects.at(-1)).toBe("proj_b")
  } finally {
    app.renderer.destroy()
    await storage.flush()
    await temporary[Symbol.asyncDispose]()
  }
})

test("scopes sessions to the repository, not to the folder", async () => {
  const active = "/tmp/opencode/project-b/packages/core"
  const events = createEventStream()
  const requests: URL[] = []
  const calls = createFetch((url) => {
    if (url.pathname === "/api/location") {
      const directory = url.searchParams.get("location[directory]") ?? process.cwd()
      const project = directory === active ? "proj_b" : "proj_a"
      return json({ directory, project: { id: project, directory, canonical: directory } })
    }
    if (url.pathname !== "/api/session") return undefined
    const parentID = url.searchParams.get("parentID")
    if (parentID && parentID !== "null") return json({ data: [], cursor: {} })
    requests.push(url)
    return json({
      data: [
        {
          id: "ses_b",
          projectID: "proj_b",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1, updated: 2 },
          title: "Nested folder session",
          location: { directory: active },
        },
      ],
      cursor: {},
    })
  }, events)
  const temporary = await tmpdir()
  let storage!: ReturnType<typeof useStorage>

  function Probe() {
    const data = useData()
    const dialog = useDialog()
    const route = useRoute()
    storage = useStorage()
    onMount(() => {
      data.session.remember({
        id: "ses_active",
        projectID: "proj_b",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 1, updated: 3 },
        title: "Active session",
        location: { directory: active },
      })
      route.navigate({ type: "session", sessionID: "ses_active" })
      dialog.replace(() => <DialogSessionList />)
    })
    return null
  }

  const app = await testRender(
    () => (
      <TestTuiContexts paths={{ state: temporary.path }}>
        <TuiAppProvider value={{ name: "test", version: "test", channel: "test" }}>
          <StorageProvider>
            <ArgsProvider>
              <ConfigProvider config={createTuiResolvedConfig()}>
                <Keymap.Provider>
                  <ToastProvider>
                    <RouteProvider>
                      <ClientProvider api={createApi(calls.fetch)}>
                        <PermissionProvider>
                          <DataProvider directory={process.cwd()}>
                            <LocationProvider>
                              <SessionTabsProvider>
                                <ThemeProvider mode="dark" source={emptyThemeSource}>
                                  <LocalProvider>
                                    <DialogProvider>
                                      <Probe />
                                    </DialogProvider>
                                  </LocalProvider>
                                </ThemeProvider>
                              </SessionTabsProvider>
                            </LocationProvider>
                          </DataProvider>
                        </PermissionProvider>
                      </ClientProvider>
                    </RouteProvider>
                  </ToastProvider>
                </Keymap.Provider>
              </ConfigProvider>
            </ArgsProvider>
          </StorageProvider>
        </TuiAppProvider>
      </TestTuiContexts>
    ),
    { width: 100, height: 30, kittyKeyboard: true },
  )
  app.renderer.start()

  try {
    await app.waitForFrame((value) => value.includes("Nested folder session"))
    const request = requests.at(-1)!
    // The repository is the scope, so the request must not narrow the list to
    // a folder inside it.
    expect(request.searchParams.get("project")).toBe("proj_b")
    expect(request.searchParams.has("subpath")).toBe(false)
    expect(request.searchParams.has("directory")).toBe(false)
  } finally {
    app.renderer.destroy()
    await storage.flush()
    await temporary[Symbol.asyncDispose]()
  }
})

test("groups sessions by repository when no repository is selected", async () => {
  const active = "/tmp/opencode/project-a"
  const events = createEventStream()
  const calls = createFetch((url) => {
    if (url.pathname === "/api/location") {
      const directory = url.searchParams.get("location[directory]") ?? process.cwd()
      return json({ directory, project: { id: "proj_a", directory, canonical: directory } })
    }
    if (url.pathname === "/api/project") {
      return json([
        {
          id: "proj_a",
          canonical: "/tmp/opencode/alpha",
          time: { created: 1, updated: 1, active: 1 },
          sandboxes: [],
        },
        {
          id: "proj_b",
          canonical: "/tmp/opencode/beta",
          time: { created: 1, updated: 1, active: 1 },
          sandboxes: [],
        },
      ])
    }
    if (url.pathname !== "/api/session") return undefined
    const parentID = url.searchParams.get("parentID")
    if (parentID && parentID !== "null") return json({ data: [], cursor: {} })
    return json({
      data: [
        {
          id: "ses_a",
          projectID: "proj_a",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1, updated: 2 },
          title: "Alpha session",
          location: { directory: "/tmp/opencode/alpha" },
        },
        {
          id: "ses_b",
          projectID: "proj_b",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1, updated: 3 },
          title: "Beta session",
          location: { directory: "/tmp/opencode/beta" },
        },
      ],
      cursor: {},
    })
  }, events)
  const temporary = await tmpdir()
  let storage!: ReturnType<typeof useStorage>

  function Probe() {
    const data = useData()
    const dialog = useDialog()
    const route = useRoute()
    storage = useStorage()
    onMount(() => {
      data.session.remember({
        id: "ses_active",
        projectID: "proj_a",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 1, updated: 3 },
        title: "Active session",
        location: { directory: active },
      })
      route.navigate({ type: "session", sessionID: "ses_active" })
      dialog.replace(() => <DialogSessionList />)
    })
    return null
  }

  const app = await testRender(
    () => (
      <TestTuiContexts paths={{ state: temporary.path }}>
        <TuiAppProvider value={{ name: "test", version: "test", channel: "test" }}>
          <StorageProvider>
            <ArgsProvider>
              <ConfigProvider config={createTuiResolvedConfig({ tabs: { scope: "global" } })}>
                <Keymap.Provider>
                  <ToastProvider>
                    <RouteProvider>
                      <ClientProvider api={createApi(calls.fetch)}>
                        <PermissionProvider>
                          <DataProvider directory={process.cwd()}>
                            <LocationProvider>
                              <SessionTabsProvider>
                                <ThemeProvider mode="dark" source={emptyThemeSource}>
                                  <LocalProvider>
                                    <DialogProvider>
                                      <Probe />
                                    </DialogProvider>
                                  </LocalProvider>
                                </ThemeProvider>
                              </SessionTabsProvider>
                            </LocationProvider>
                          </DataProvider>
                        </PermissionProvider>
                      </ClientProvider>
                    </RouteProvider>
                  </ToastProvider>
                </Keymap.Provider>
              </ConfigProvider>
            </ArgsProvider>
          </StorageProvider>
        </TuiAppProvider>
      </TestTuiContexts>
    ),
    { width: 100, height: 30, kittyKeyboard: true },
  )
  app.renderer.start()

  try {
    const frame = await app.waitForFrame((value) => value.includes("Beta session"))
    // One group per repository instead of one group per day.
    expect(frame).toContain("alpha")
    expect(frame).toContain("beta")
    expect(frame).toContain("all repositories")
  } finally {
    app.renderer.destroy()
    await storage.flush()
    await temporary[Symbol.asyncDispose]()
  }
})

test("lists every session when the location belongs to no repository", async () => {
  const active = "/tmp/opencode/loose"
  const events = createEventStream()
  const requests: URL[] = []
  const calls = createFetch((url) => {
    if (url.pathname === "/api/location") {
      const directory = url.searchParams.get("location[directory]") ?? process.cwd()
      return json({ directory, project: { id: "global", directory, canonical: directory } })
    }
    if (url.pathname !== "/api/session") return undefined
    const parentID = url.searchParams.get("parentID")
    if (parentID && parentID !== "null") return json({ data: [], cursor: {} })
    requests.push(url)
    return json({
      data: [
        {
          id: "ses_global",
          projectID: "global",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1, updated: 2 },
          title: "Global session",
          location: { directory: active },
        },
      ],
      cursor: {},
    })
  }, events)
  const temporary = await tmpdir()
  let storage!: ReturnType<typeof useStorage>

  function Probe() {
    const data = useData()
    const dialog = useDialog()
    const route = useRoute()
    storage = useStorage()
    onMount(() => {
      data.session.remember({
        id: "ses_active",
        projectID: "global",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 1, updated: 3 },
        title: "Active session",
        location: { directory: active },
      })
      route.navigate({ type: "session", sessionID: "ses_active" })
      dialog.replace(() => <DialogSessionList />)
    })
    return null
  }

  const app = await testRender(
    () => (
      <TestTuiContexts paths={{ state: temporary.path }}>
        <TuiAppProvider value={{ name: "test", version: "test", channel: "test" }}>
          <StorageProvider>
            <ArgsProvider>
              <ConfigProvider config={createTuiResolvedConfig()}>
                <Keymap.Provider>
                  <ToastProvider>
                    <RouteProvider>
                      <ClientProvider api={createApi(calls.fetch)}>
                        <PermissionProvider>
                          <DataProvider directory={process.cwd()}>
                            <LocationProvider>
                              <SessionTabsProvider>
                                <ThemeProvider mode="dark" source={emptyThemeSource}>
                                  <LocalProvider>
                                    <DialogProvider>
                                      <Probe />
                                    </DialogProvider>
                                  </LocalProvider>
                                </ThemeProvider>
                              </SessionTabsProvider>
                            </LocationProvider>
                          </DataProvider>
                        </PermissionProvider>
                      </ClientProvider>
                    </RouteProvider>
                  </ToastProvider>
                </Keymap.Provider>
              </ConfigProvider>
            </ArgsProvider>
          </StorageProvider>
        </TuiAppProvider>
      </TestTuiContexts>
    ),
    { width: 100, height: 30, kittyKeyboard: true },
  )
  app.renderer.start()

  try {
    await app.waitForFrame((value) => value.includes("Global session"))
    const request = requests.at(-1)!
    // No repository to scope by: nothing is filtered out.
    expect(request.searchParams.has("project")).toBe(false)
    expect(request.searchParams.has("subpath")).toBe(false)
    expect(request.searchParams.has("directory")).toBe(false)
  } finally {
    app.renderer.destroy()
    await storage.flush()
    await temporary[Symbol.asyncDispose]()
  }
})
