export * as SessionDoomLoop from "./doom-loop.js"

import type { Content } from "@opencode/schema/tool"
import { SessionMessage } from "../message.js"

/**
 * How many identical tool calls in a row count as a loop.
 */
export const THRESHOLD = 4

/** The output prefix that decides whether two calls did the same thing. */
const OUTPUT_PREFIX = 200

export type Call = {
  readonly tool: string
  readonly input: string
  readonly output: string
}

const output = (content: ReadonlyArray<Content>) =>
  content
    .flatMap((item) => (item.type === "text" ? [item.text] : []))
    .join("\n")
    .slice(0, OUTPUT_PREFIX)

/** The completed tool calls of the session, in order. */
export const calls = (messages: ReadonlyArray<SessionMessage.Info>): ReadonlyArray<Call> => {
  const result: Call[] = []
  for (const message of messages) {
    if (message.type !== "assistant") continue
    for (const part of message.content) {
      if (part.type !== "tool") continue
      if (part.state.status !== "completed") continue
      result.push({
        tool: part.name,
        input: JSON.stringify(part.state.input),
        output: output(part.state.content),
      })
    }
  }
  return result
}

/**
 * The warning for a session that keeps making the same call.
 *
 * The detector looks across steps: every repeated call lives in its own
 * assistant message, so a detector that only reads the current turn never sees
 * the repetition. The warning is advisory — the model decides what to do with
 * it, and the session keeps running.
 */
export const warning = (messages: ReadonlyArray<SessionMessage.Info>): string | undefined => {
  const tail = calls(messages).slice(-THRESHOLD)
  if (tail.length < THRESHOLD) return undefined
  const first = tail[0]
  if (!first) return undefined
  if (!tail.every((call) => call.tool === first.tool && call.input === first.input && call.output === first.output))
    return undefined
  return `Doom loop suspected: the last ${THRESHOLD} tool calls were identical (${first.tool}) with the same input and output. Avoid repeating the same call; change the approach or the arguments.`
}
