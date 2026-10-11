export * as Evidence from "./evidence"

import path from "path"
import { Global } from "../global"

// Where the original text of a compacted tool result actually lives.
export type Kind = "full_original" | "bounded_stored_output" | "managed_output_file" | "unavailable"

// Covers both truncation notices ("Full output saved to: <file>").
const NOTICE = /Full output saved to: (\S+)/

// Mirrors ToolOutputStore.MANAGED_DIRECTORY; duplicated to avoid a dependency cycle with the store.
export const managedDir = () => path.join(Global.Path.data, "tool-output")

export type Ref = { readonly kind: Kind; readonly path?: string }

export const classify = (text: string): Ref => {
  const match = text.match(NOTICE)
  if (!match) return { kind: "full_original" }
  const resolved = path.resolve(match[1])
  const root = path.resolve(managedDir())
  // A pointer outside the managed tool-output directory is not a recovery path we may follow.
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return { kind: "unavailable" }
  return { kind: "managed_output_file", path: resolved }
}
