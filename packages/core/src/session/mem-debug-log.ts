export * as MemDebugLog from "./mem-debug-log"

import fs from "fs/promises"
import path from "path"
import { Global } from "@opencode/util/global"

// MEM debug lines belong to the server log, never to stdout: the server's
// stdout is inherited by the TUI/terminal client, so console.log here would
// leak `[mem-context] ...` / `[intent-tracker] ...` into the user's view
// (issue #45). Files land next to the other server logs in Global.Path.log.
export const write = (file: string, line: string) => {
  fs.appendFile(path.join(Global.Path.log, file), line + "\n").catch(() => {})
}
