import { Schema } from "effect"

const Message = Schema.Struct({
  role: Schema.String,
  // A tool result carries its content as a list of parts, so the field stays opaque.
  content: Schema.optional(Schema.Unknown),
})

const Request = Schema.Struct({
  messages: Schema.optional(Schema.Array(Message)),
})

const decodeRequest = Schema.decodeUnknownSync(Request)

export type FakeLlm = {
  // The base URL an OpenAI-compatible provider is configured with.
  readonly url: string
  readonly stop: () => Promise<void>
}

/**
 * An OpenAI-compatible chat completions endpoint. The first turn calls the `write` tool, the turn after the
 * tool result answers with text, so a session runs the same provider path a real model drives.
 */
export function startFakeLlm(input: {
  readonly file: string
  readonly content: string
  readonly reply: string
}): FakeLlm {
  let calls = 0

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/chat/completions") {
        return new Response("Not found", { status: 404 })
      }

      const body = decodeRequest(await request.json())

      const answered = body.messages?.some((message) => message.role === "tool") ?? false

      if (answered) return stream(text(input.reply))

      calls++

      return stream(toolCall(calls, input.file, input.content))
    },
  })

  return {
    url: `http://127.0.0.1:${server.port}/v1`,
    stop: () => server.stop(true),
  }
}

function toolCall(index: number, file: string, content: string) {
  return [
    {
      choices: [
        {
          delta: {
            role: "assistant",
            tool_calls: [
              { index: 0, id: `call_${index}`, type: "function", function: { name: "write", arguments: "" } },
            ],
          },
          finish_reason: null,
        },
      ],
      usage: null,
    },
    {
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ path: file, content }) } }],
          },
        },
      ],
      usage: null,
    },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: null },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } },
  ]
}

function text(content: string) {
  return [
    { choices: [{ delta: { role: "assistant" }, finish_reason: null }], usage: null },
    { choices: [{ delta: { content }, finish_reason: null }], usage: null },
    { choices: [{ delta: {}, finish_reason: "stop" }], usage: null },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } },
  ]
}

function stream(chunks: readonly unknown[]) {
  const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`

  return new Response(body, { headers: { "content-type": "text/event-stream" } })
}
