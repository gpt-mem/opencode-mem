export * as LadderTransport from "./ladder-transport"

export type Response = { rung?: string; scope?: string; variant: "default" | "masked" }

type Variant = { rung: string; scope: string; messages: unknown[] }
type Context = { variant?: Variant; onResponse: (response: Response) => void }

const requests = new Map<string, Context>()
const requestHeader = "x-opencode-ladder-request"

export function register(context: Context) {
  const id = crypto.randomUUID()
  requests.set(id, context)
  return { id, close: () => requests.delete(id) }
}

export function header(id: string) {
  return { [requestHeader]: id }
}

export async function fetchRequest(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  next: (input: RequestInfo | URL, init?: RequestInit) => Promise<globalThis.Response>,
) {
  const headers = new Headers(init?.headers)
  const context = requests.get(headers.get(requestHeader) ?? "")
  headers.delete(requestHeader)
  if (!context) return next(input, { ...init, headers })

  const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
  const payload = body && typeof body === "object" ? body : undefined
  const variant = context.variant
  const hasVariant = !!variant && new TextEncoder().encode(JSON.stringify(variant.messages)).length <= 2_000_000
  if (payload) {
    payload.ladder_conversation = headers.get("x-session-affinity") ?? headers.get("x-session-id")
    if (variant && hasVariant)
      payload.ladder_cache_variant = {
        rung: variant.rung,
        cache_scope: variant.scope,
        messages: variant.messages,
      }
  }
  const first = await next(input, { ...init, headers, body: payload ? JSON.stringify(payload) : init?.body })
  const rejectedVariant =
    first.status === 400 &&
    hasVariant &&
    payload &&
    (
      await first
        .clone()
        .json()
        .catch(() => undefined)
    )?.error?.message === "invalid ladder_cache_variant"
  const response =
    rejectedVariant && payload
      ? await next(input, { ...init, headers, body: JSON.stringify({ ...payload, ladder_cache_variant: undefined }) })
      : first
  const rung = response.headers.get("x-ladder-model") ?? undefined
  const scope = response.headers.get("x-ladder-cache-scope") ?? undefined
  context.onResponse({
    ...(rung ? { rung } : {}),
    ...(scope && /^v1_[a-f0-9]{32}$/.test(scope) ? { scope } : {}),
    variant: response.headers.get("x-ladder-cache-variant") === "masked" ? "masked" : "default",
  })
  return response
}
