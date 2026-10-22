import { createMemo, createResource, createSignal, onMount, Show, type JSX } from "solid-js"
import path from "path"
import type { SessionInfo } from "@opencode/client"
import { Project } from "@opencode/schema/project"
import { TextAttributes, type RGBA } from "@opentui/core"
import { DIALOG_LIST_INSET, useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { useRoute } from "../context/route"
import { useData } from "../context/data"
import { Keymap } from "../context/keymap"
import { Locale } from "../util/locale"
import { useTheme } from "../context/theme"
import { useClient } from "../context/client"
import { useLocal } from "../context/local"
import { createDebouncedSignal } from "../util/signal"
import { useToast } from "../ui/toast"
import { DialogSessionRename } from "./dialog-session-rename"
import { Spinner } from "./spinner"
import { errorMessage } from "../util/error"
import { useSessionTabs } from "../context/session-tabs"
import { useStorage } from "../context/storage"
import { useConfig, useNewDesigns } from "../config"
import { withTimestampedFallback } from "@opencode/util/session-title-fallback"
import { projectName } from "../util/project"
import { useLocation } from "../context/location"

export function DialogSessionList() {
  const dialog = useDialog()
  const route = useRoute()
  const data = useData()
  const theme = useTheme().surface("dialog")
  const client = useClient()
  const local = useLocal()
  const sessionTabs = useSessionTabs()
  const config = useConfig().data
  const newDesigns = useNewDesigns()
  const toast = useToast()
  const activeLocation = useLocation()
  const [filter, setFilter] = createSignal("")
  const shortcuts = Keymap.useShortcuts()
  const [search, setSearch] = createDebouncedSignal("", 150)
  const [toDelete, setToDelete] = createSignal<string>()
  const [prefs, updatePrefs] = useStorage().store("session-list", {
    initial: { allProjects: config.tabs?.scope !== "cwd" },
  })
  const allProjects = () => prefs.allProjects
  const pickerLocation = () =>
    (route.data.type === "session" ? data.session.get(route.data.sessionID)?.location : undefined) ??
    activeLocation.ref ??
    data.location.default()

  // A session belongs to the repository it was started in, not to the folder it
  // happened to live in. A repository spans its subdirectories, its linked
  // worktrees and its clones, so the list is scoped by repository. An empty
  // scope - no repository selected - means every session is listed.
  const scope = createMemo(() => sessionScope(data.location.info(pickerLocation()), allProjects()))

  const [searchResults, { mutate: setSearchResults }] = createResource(
    () => ({
      query: search().trim(),
      allProjects: allProjects(),
      location: pickerLocation(),
    }),
    async ({ query, allProjects, location }) => {
      try {
        if (!data.location.info(location)) await data.location.sync(location)
        const current = data.location.info(location)
        if (!current) throw new Error("Location unavailable")
        const scope = sessionScope(current, allProjects)
        const response = await client.api.session.list({
          ...(scope.kind === "repository" ? { project: scope.id } : {}),
          ...(query ? { search: query } : {}),
          limit: 50,
          order: "desc",
          parentID: null,
        })
        return { query, scope, sessions: response.data, error: undefined }
      } catch (error) {
        // A transient transport failure must degrade search, not crash the TUI
        // through the root ErrorBoundary when the errored resource is read.
        return { query, scope: sessionScope(undefined, allProjects), sessions: [] as SessionInfo[], error }
      }
    },
  )

  const currentSessionID = createMemo(() => (route.data.type === "session" ? route.data.sessionID : undefined))
  const localSessions = createMemo(() => {
    const query = filter().trim().toLowerCase()
    const current = scope()
    const sessions = data.session.list().filter((session) => current.kind === "all" || session.projectID === current.id)
    if (!query) return sessions
    return sessions.filter(
      (session) => !session.parentID && withTimestampedFallback(session).toLowerCase().includes(query),
    )
  })
  const sessions = createMemo(() => {
    const query = filter().trim()
    const local = localSessions()
    if (query !== search().trim()) return searchResults.latest?.sessions ?? local
    if (searchResults.loading) return searchResults.latest?.sessions ?? []
    const result = searchResults()
    const current = scope()
    if (result?.query !== query || result.scope.kind !== current.kind || result.error) return local
    if (result.scope.kind === "repository" && current.kind === "repository" && result.scope.id !== current.id)
      return local
    return result.sessions
  })
  const searchState = createMemo(() => {
    const query = filter().trim()
    if (query !== search().trim() || searchResults.loading)
      return { message: query ? "Searching sessions…" : "Loading sessions…", error: false }
    const result = searchResults()
    if (result?.query === query && result.error)
      return {
        message: query ? "Could not search sessions. Change the search to try again." : "Could not load sessions.",
        error: true,
      }
    return { message: query ? "No sessions found" : "No sessions available", error: false }
  })

  const quickSwitchHint = createMemo(() => {
    if (sessionTabs.enabled()) return
    const first = shortcuts.get("session.quick_switch.1")
    const last = shortcuts.get("session.quick_switch.9")
    if (!first || !last) return
    return quickSwitchRange(first, last)
  })
  const quickSwitchFooterHints = createMemo(() => {
    const hint = quickSwitchHint()
    return hint && local.session.slots().length > 0 ? [{ title: "switch", label: hint }] : []
  })
  const scopeName = createMemo(() => {
    const current = scope()
    if (current.kind !== "repository") return ""
    return projectName(data.project.get(current.id)) ?? ""
  })
  // One label per repository. Two repositories can share a basename, so an
  // ambiguous label falls back to the full path instead of silently merging
  // two repositories into one group.
  const projectLabels = createMemo(() => {
    const labels = new Map<string, string>()
    const ambiguous = new Map<string, number>()
    for (const session of sessions()) {
      if (labels.has(session.projectID)) continue
      const project = data.project.get(session.projectID)
      const canonical = project?.canonical ?? ""
      const name = project?.name || (canonical === "/" ? "global" : canonical ? path.basename(canonical) : "")
      const label = name || session.projectID
      labels.set(session.projectID, label)
      ambiguous.set(label, (ambiguous.get(label) ?? 0) + 1)
    }
    for (const [id, label] of labels) {
      if ((ambiguous.get(label) ?? 0) < 2) continue
      const canonical = data.project.get(id)?.canonical
      if (canonical) labels.set(id, canonical)
    }
    return labels
  })

  const options = createMemo(() => {
    const today = new Date().toDateString()
    const sessionMap = new Map(
      sessions()
        .filter((session) => !session.parentID)
        .map((session) => [session.id, session]),
    )
    const pinned = sessionTabs.enabled() ? [] : local.session.pinned().filter((sessionID) => sessionMap.has(sessionID))
    const pinnedSet = new Set(pinned)
    const slotByID = new Map(local.session.slots().map((sessionID, index) => [sessionID, index + 1]))

    const option = (session: SessionInfo, category: string) => {
      const directory = session.location.directory
      const project = data.project.get(session.projectID)
      const root = session.subpath ? path.resolve(directory, ...session.subpath.split("/").map(() => "..")) : directory
      const relative = path.relative(project?.canonical ?? root, root)
      const footer =
        relative.startsWith("..") || path.isAbsolute(relative)
          ? Locale.truncate(path.basename(relative), 25)
          : undefined
      const slot = sessionTabs.enabled() ? undefined : slotByID.get(session.id)
      const deleting = toDelete() === session.id
      const attention = sessionTabs.status(session.id).attention
      return {
        title: deleting
          ? `Press ${shortcuts.get("session.delete")} again to confirm`
          : withTimestampedFallback(session),
        value: session.id,
        category,
        footer,
        bg: deleting ? theme.background.action.destructive.focused : undefined,
        fg: deleting ? theme.text.action.destructive.focused : undefined,
        gutter: sessionStatusGutter(
          theme,
          attention,
          !attention &&
            (data.session.status(session.id) === "running" ||
              data.session.family(session.id).some((id) => data.session.status(id) === "running")),
          slot === undefined ? undefined : () => <text fg={theme.hue.accent[200]}>{slot}</text>,
        ),
      }
    }

    const remaining = sessions()
      .filter((session) => !session.parentID && !pinnedSet.has(session.id))
      .map((session) => {
        // With no repository selected the list spans repositories, so it is
        // grouped by repository; inside one repository the date is the useful
        // axis.
        if (scope().kind === "all") return option(session, projectLabels().get(session.projectID) ?? session.projectID)
        const date = new Date(session.time.updated).toDateString()
        return option(session, date === today ? "Today" : date)
      })

    return [...pinned.map((sessionID) => option(sessionMap.get(sessionID)!, "Pinned")), ...remaining]
  })

  onMount(() => {
    dialog.setSize("large")
    // Repository labels come from the project list; without it the grouping
    // would fall back to raw project ids.
    void data.project.sync()
  })

  return (
    <DialogSelect
      title="Sessions"
      titleView={
        <box flexDirection="row">
          <text fg={theme.text.base} attributes={TextAttributes.BOLD}>
            Sessions
          </text>
          <Show when={scope().kind === "repository" && scopeName()}>
            <text fg={theme.text.muted}> in {scopeName()}</text>
          </Show>
          <Show when={scope().kind === "all"}>
            <text fg={theme.text.muted}> in all repositories</text>
          </Show>
        </box>
      }
      searchInTitle
      titlePlaceholder={
        scope().kind === "repository"
          ? scopeName()
            ? `Search sessions in ${scopeName()}`
            : "Search sessions in this repository"
          : "Search sessions in all repositories"
      }
      options={options()}
      skipFilter={true}
      current={currentSessionID()}
      onFilter={(query) => {
        setFilter(query)
        setSearch(query)
      }}
      bindings={[
        {
          bind: "ctrl+a",
          title: scope().kind === "all" ? "Show current repository sessions" : "Show all repository sessions",
          group: "Dialog",
          run: () => {
            void updatePrefs((draft) => {
              draft.allProjects = !draft.allProjects
            }).catch(() => {})
          },
        },
      ]}
      emptyView={
        <box paddingLeft={DIALOG_LIST_INSET} paddingRight={DIALOG_LIST_INSET}>
          <text fg={searchState().error ? theme.text.feedback.error.base : theme.text.muted}>
            {searchState().message}
          </text>
        </box>
      }
      noMatchView={
        <box paddingLeft={DIALOG_LIST_INSET} paddingRight={DIALOG_LIST_INSET}>
          <text fg={searchState().error ? theme.text.feedback.error.base : theme.text.muted}>
            {searchState().message}
          </text>
        </box>
      }
      onMove={() => setToDelete(undefined)}
      onSelect={(option) => {
        route.navigate({ type: "session", sessionID: option.value })
        dialog.clear()
      }}
      actions={[
        {
          command: "session.pin.toggle",
          title: "pin/unpin",
          hidden: sessionTabs.enabled(),
          onTrigger: (option) => local.session.togglePin(option.value),
        },
        {
          command: "session.delete",
          title: "delete",
          onTrigger: (option: { value: string }) => {
            if (toDelete() !== option.value) {
              setToDelete(option.value)
              return
            }
            void client.api.session
              .remove({ sessionID: option.value })
              .then(() => {
                setSearchResults((result) =>
                  result
                    ? { ...result, sessions: result.sessions.filter((session) => session.id !== option.value) }
                    : result,
                )
              })
              .catch((error) => {
                setToDelete(undefined)
                toast.show({
                  message: `Failed to delete session: ${errorMessage(error)}`,
                  variant: "error",
                  duration: 5000,
                })
              })
          },
        },
        {
          command: "session.rename",
          title: "rename",
          onTrigger: (option: { value: string; title: string }) =>
            DialogSessionRename.show(dialog, option.value, option.title),
        },
      ]}
      footerHints={[
        ...(newDesigns() ? [] : quickSwitchFooterHints()),
        { title: scope().kind === "all" ? "current repository" : "all repositories", label: "ctrl+a", side: "right" },
      ]}
    />
  )
}

function quickSwitchRange(first: string, last: string) {
  const prefix = first.slice(0, -1)
  if (first.endsWith("1") && last === `${prefix}9`) return `${prefix}1-9`
  return `${first} through ${last}`
}

type SessionScope = { kind: "all" } | { kind: "repository"; id: string }

// The scope of the session list is a repository, not a folder. An empty scope
// - no repository selected, or a location that belongs to no repository -
// means every session is listed.
function sessionScope(current: { project: { id: string } } | undefined, all: boolean): SessionScope {
  if (all) return { kind: "all" }
  if (!current || current.project.id === Project.ID.global) return { kind: "all" }
  return { kind: "repository", id: current.project.id }
}

export function sessionStatusGutter(
  theme: ReturnType<ReturnType<typeof useTheme>["surface"]>,
  attention: "permission" | "question" | false,
  running: boolean,
  fallback?: () => JSX.Element,
) {
  if (attention) {
    return (color: RGBA) => (
      <text
        fg={color === theme.text.action.primary.focused ? color : theme.text.feedback.warning.base}
        attributes={TextAttributes.BOLD}
      >
        {attention === "permission" ? "!" : "?"}
      </text>
    )
  }
  if (running) return (color: RGBA) => <Spinner color={color} />
  return fallback
}
