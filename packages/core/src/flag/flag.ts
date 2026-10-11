import { Config } from "effect"

export function truthy(key: string) {
  const value = process.env[key]?.toLowerCase()
  return value === "true" || value === "1"
}

const copy = process.env["OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"]
const fff = process.env["OPENCODE_DISABLE_FFF"]

function enabledByExperimental(key: string) {
  return process.env[key] === undefined ? truthy("OPENCODE_EXPERIMENTAL") : truthy(key)
}

export const Flag = {
  OTEL_EXPORTER_OTLP_ENDPOINT: process.env["OTEL_EXPORTER_OTLP_ENDPOINT"],
  OTEL_EXPORTER_OTLP_HEADERS: process.env["OTEL_EXPORTER_OTLP_HEADERS"],

  OPENCODE_AUTO_HEAP_SNAPSHOT: truthy("OPENCODE_AUTO_HEAP_SNAPSHOT"),
  OPENCODE_GIT_BASH_PATH: process.env["OPENCODE_GIT_BASH_PATH"],
  OPENCODE_CONFIG: process.env["OPENCODE_CONFIG"],
  OPENCODE_CONFIG_CONTENT: process.env["OPENCODE_CONFIG_CONTENT"],
  OPENCODE_DISABLE_AUTOUPDATE: truthy("OPENCODE_DISABLE_AUTOUPDATE"),
  OPENCODE_ALWAYS_NOTIFY_UPDATE: truthy("OPENCODE_ALWAYS_NOTIFY_UPDATE"),
  OPENCODE_DISABLE_PRUNE: truthy("OPENCODE_DISABLE_PRUNE"),
  OPENCODE_DISABLE_TERMINAL_TITLE: truthy("OPENCODE_DISABLE_TERMINAL_TITLE"),
  OPENCODE_SHOW_TTFD: truthy("OPENCODE_SHOW_TTFD"),
  OPENCODE_DISABLE_AUTOCOMPACT: truthy("OPENCODE_DISABLE_AUTOCOMPACT"),
  OPENCODE_DISABLE_MODELS_FETCH: truthy("OPENCODE_DISABLE_MODELS_FETCH"),
  OPENCODE_DISABLE_MOUSE: truthy("OPENCODE_DISABLE_MOUSE"),
  OPENCODE_FAKE_VCS: process.env["OPENCODE_FAKE_VCS"],
  OPENCODE_SERVER_PASSWORD: process.env["OPENCODE_SERVER_PASSWORD"],
  OPENCODE_SERVER_USERNAME: process.env["OPENCODE_SERVER_USERNAME"],
  OPENCODE_DISABLE_FFF: fff === undefined ? process.platform === "win32" : truthy("OPENCODE_DISABLE_FFF"),

  // Experimental
  OPENCODE_EXPERIMENTAL_FILEWATCHER: Config.boolean("OPENCODE_EXPERIMENTAL_FILEWATCHER").pipe(
    Config.withDefault(false),
  ),
  OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: Config.boolean("OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER").pipe(
    Config.withDefault(false),
  ),
  OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT:
    copy === undefined ? process.platform === "win32" : truthy("OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"),
  OPENCODE_MODELS_URL: process.env["OPENCODE_MODELS_URL"],
  OPENCODE_MODELS_PATH: process.env["OPENCODE_MODELS_PATH"],
  OPENCODE_DB: process.env["OPENCODE_DB"],

  OPENCODE_WORKSPACE_ID: process.env["OPENCODE_WORKSPACE_ID"],
  OPENCODE_EXPERIMENTAL_WORKSPACES: enabledByExperimental("OPENCODE_EXPERIMENTAL_WORKSPACES"),

  // Evaluated at access time (not module load) because tests, the CLI, and
  // external tooling set these env vars at runtime.
  get OPENCODE_DISABLE_PROJECT_CONFIG() {
    return truthy("OPENCODE_DISABLE_PROJECT_CONFIG")
  },
  get OPENCODE_EXPERIMENTAL_REFERENCES() {
    return enabledByExperimental("OPENCODE_EXPERIMENTAL_REFERENCES")
  },
  get OPENCODE_TUI_CONFIG() {
    return process.env["OPENCODE_TUI_CONFIG"]
  },
  get OPENCODE_CONFIG_DIR() {
    return process.env["OPENCODE_CONFIG_DIR"]
  },
  get OPENCODE_PURE() {
    return truthy("OPENCODE_PURE")
  },
  get OPENCODE_PERMISSION() {
    return process.env["OPENCODE_PERMISSION"]
  },
  get OPENCODE_PLUGIN_META_FILE() {
    return process.env["OPENCODE_PLUGIN_META_FILE"]
  },
  get OPENCODE_CLIENT() {
    return process.env["OPENCODE_CLIENT"] ?? "cli"
  },
  get OPENCODE_MEMORY_CONTEXT() {
    return truthy("OPENCODE_MEMORY_CONTEXT")
  },
  get OPENCODE_MEMORY_CONTEXT_DEBUG() {
    return truthy("OPENCODE_MEMORY_CONTEXT_DEBUG")
  },
  get OPENCODE_MEMORY_BATCH_SIZE() {
    return process.env["OPENCODE_MEMORY_BATCH_SIZE"]
  },
  get OPENCODE_MEMORY_MIDTURN() {
    return truthy("OPENCODE_MEMORY_MIDTURN")
  },
  // Issue #23 (first-delivery compaction). Issue #29 P1: when the cache-mark
  // ledger (OPENCODE_MEMORY_CACHE_MARK) is on, first-delivery is the default
  // policy without this flag — the mark floors the confirmed prefix and the
  // fresh tail is compacted on arrival. Set this alone for ledger-less
  // setups (zero-cache providers).
  get OPENCODE_MEMORY_FIRST_DELIVERY() {
    return truthy("OPENCODE_MEMORY_FIRST_DELIVERY")
  },
  get OPENCODE_MEMORY_FIRST_DELIVERY_MIN_CHARS() {
    return process.env["OPENCODE_MEMORY_FIRST_DELIVERY_MIN_CHARS"]
  },
  get OPENCODE_MEMORY_FIRST_DELIVERY_TOOLS() {
    return process.env["OPENCODE_MEMORY_FIRST_DELIVERY_TOOLS"]
  },
  get OPENCODE_MEMORY_INTENT() {
    return truthy("OPENCODE_MEMORY_INTENT")
  },
  get OPENCODE_MEMORY_INTENT_DEBUG() {
    return truthy("OPENCODE_MEMORY_INTENT_DEBUG")
  },
  get OPENCODE_MEMORY_INTENT_REFRESH_EVERY() {
    return process.env["OPENCODE_MEMORY_INTENT_REFRESH_EVERY"]
  },
  get OPENCODE_MEMORY_INTENT_ACT() {
    return truthy("OPENCODE_MEMORY_INTENT_ACT")
  },
  get OPENCODE_MEMORY_INTENT_SWITCH_THRESHOLD() {
    return process.env["OPENCODE_MEMORY_INTENT_SWITCH_THRESHOLD"]
  },
  // Cache-breaking (issue #25 B3): compact the closed intent's context at a
  // confirmed switch. Off by default — on cache-priced providers any history
  // rewrite invalidates the prompt prefix, so this is opt-in until the S1-S4
  // cost table proves the switch-boundary cut worthwhile.
  get OPENCODE_MEMORY_INTENT_CUT() {
    return truthy("OPENCODE_MEMORY_INTENT_CUT")
  },
  // Issue #29: unified mask via the provider cache-mark ledger. Requires
  // OPENCODE_MEMORY_CONTEXT. Off by default — on = projection reads the
  // confirmed cache boundary per provider and only compresses the suffix
  // above it; any ledger failure (no row, prefix hash mismatch) fails safe to
  // a verbatim send.
  get OPENCODE_MEMORY_CACHE_MARK() {
    return truthy("OPENCODE_MEMORY_CACHE_MARK")
  },
}
