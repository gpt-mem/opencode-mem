export * as Evidence from "./evidence.js"

// Where the original text of a bounded tool result actually lives.
export type Kind = "full_original" | "managed_output_file"

export type Ref = { readonly kind: Kind; readonly path?: string }

// The truncation marker written by ToolOutput:
// "[showing lines 1-N of M; full output saved to <file> — read or grep that file ...]".
const NOTICE = /full output saved to (.+?)(?:\s+—\s|\]$)/m

// The whole marker line, so a preview does not repeat the pointer that the
// compact marker states anyway.
const MARKER_LINE = /\[showing[^\]]*\]/g

/** Classify a stored tool result: the full original, or a preview of a managed file. */
export const classify = (text: string): Ref => {
  const match = NOTICE.exec(text)
  if (!match) return { kind: "full_original" }
  return { kind: "managed_output_file", path: match[1] }
}

/** The stored text without the truncation marker line. */
export const body = (text: string) => text.replace(MARKER_LINE, "").trimEnd()
