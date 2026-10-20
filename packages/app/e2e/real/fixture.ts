import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// The port the real server listens on and serves the app from. The suite owns the port, so a server left over
// from an earlier run never answers for the browser.
export const PORT = Number(process.env.PLAYWRIGHT_REAL_PORT ?? 3400)

export const serverURL = `http://127.0.0.1:${PORT}`

// The server password the app authenticates with. The server runs with an isolated home, so a fixed password
// keeps the app's credentials and the harness in step without reading the server's output.
export const PASSWORD = "opencode-app-real-e2e"

// The file the scripted model writes, its content, and the reply it sends after the tool ran.
export const FILE = "note.txt"

export const CONTENT = "The real server wrote this file.\n"

export const REPLY = "Wrote note.txt through the real server."

// The draft the app opens the session from.
export const DRAFT = "draft_real_backend"

// The server reports the canonical path of a directory, which differs from the temporary directory on macOS.
// The suite works in the canonical path so the app and the server agree on one location and the app does not
// reload the location scoped data it already has.
const tmp = fs.realpathSync(os.tmpdir())

// The suite keeps its files under one directory per port, and the server harness wipes it before every run,
// so the workspace, the home, and the database never leak between runs.
export const root = path.join(tmp, "opencode-app-real", String(PORT))

export const home = path.join(root, "home")

// The directory the server owns and the app opens. The session writes into it.
export const directory = path.join(root, "workspace")
