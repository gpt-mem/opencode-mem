import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Context, Layer } from "effect"
import { and, count, desc, eq } from "drizzle-orm"
import { ulid } from "ulid"
import { Database } from "@opencode-ai/core/database/database"
import { IntentTable, IntentSignalTable } from "@opencode-ai/core/session/sql"
import { Flag } from "@opencode-ai/core/flag/flag"
import { PII } from "@opencode-ai/core/session/pii"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionID } from "./schema"

// Log-only intent signal tracker (issue #25, cache-safe): records a cheap
// cosine similarity between each new user turn and the active intent summary.
// It never mutates messages or cuts context — cut logic is a later phase.

const EMBEDDING_MODEL = "char-ngram-tf-v1"
const SUMMARY_TEXT_CHARS = 400
const RECENT_TEXTS = 3
const DEFAULT_REFRESH_EVERY = 5

// Deterministic free detector: log-TF over char 3-5 grams, cosine over the
// sparse vectors. No network, no model — good enough to collect a labeled
// cosine distribution for threshold calibration (day-2 go/no-go).
const ngrams = (text: string) => {
  const lower = text.toLowerCase()
  const weights = new Map<string, number>()
  for (const size of [3, 4, 5]) {
    for (let i = 0; i + size <= lower.length; i++) {
      const gram = lower.slice(i, i + size)
      weights.set(gram, (weights.get(gram) ?? 0) + 1)
    }
  }
  return weights
}

const cosine = (a: Map<string, number>, b: Map<string, number>) => {
  if (a.size === 0 || b.size === 0) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (const [gram, count] of a) normA += count * count
  for (const [gram, count] of b) normB += count * count
  if (normA === 0 || normB === 0) return 0
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  for (const [gram, count] of small) {
    const other = large.get(gram)
    if (other !== undefined) dot += count * other
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

const estimateTokens = (text: string) => Math.ceil(text.length / 4)

const userText = (parts: readonly SessionV1.Part[]) =>
  parts
    .filter((part): part is SessionV1.TextPart => part.type === "text")
    .map((part) => part.text)
    .join("\n")

export interface Interface {
  readonly track: (input: { sessionID: SessionID; parts: readonly SessionV1.Part[] }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/IntentTracker") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const { db } = database

    const track = Effect.fn("IntentTracker.track")(function* (input: {
      sessionID: SessionID
      parts: readonly SessionV1.Part[]
    }) {
      if (!Flag.OPENCODE_MEMORY_INTENT) return
      const raw = userText(input.parts)
      if (raw.trim() === "") return
      const text = PII.redact(raw).text
      const now = Date.now()

      const active = yield* db
        .select()
        .from(IntentTable)
        .where(and(eq(IntentTable.session_id, input.sessionID), eq(IntentTable.status, "active")))
        .orderBy(desc(IntentTable.started_at))
        .limit(1)
        .get()
        .pipe(Effect.orDie)

      const signals = yield* db
        .select({ total: count() })
        .from(IntentSignalTable)
        .where(eq(IntentSignalTable.session_id, input.sessionID))
        .get()
        .pipe(Effect.orDie)
      const turnIndex = (signals?.total ?? 0) + 1

      if (!active) {
        const summary = text.slice(0, SUMMARY_TEXT_CHARS)
        yield* db
          .insert(IntentTable)
          .values({
            id: ulid(),
            session_id: input.sessionID,
            summary,
            started_at: now,
            last_active_at: now,
            turn_count: 1,
            token_count: estimateTokens(text),
            meta: { embedding_model: EMBEDDING_MODEL, recent_texts: [text.slice(0, SUMMARY_TEXT_CHARS)] },
          })
          .run()
          .pipe(Effect.orDie)
        yield* db
          .insert(IntentSignalTable)
          .values({ session_id: input.sessionID, turn_index: turnIndex, cosine: null, ts: now })
          .run()
          .pipe(Effect.orDie)
        return
      }

      const score = cosine(ngrams(active.summary), ngrams(text))
      yield* db
        .insert(IntentSignalTable)
        .values({ session_id: input.sessionID, turn_index: turnIndex, cosine: score, ts: now })
        .run()
        .pipe(Effect.orDie)

      const meta = (active.meta ?? {}) as { recent_texts?: string[] }
      const recent = [...(meta.recent_texts ?? []), text.slice(0, SUMMARY_TEXT_CHARS)].slice(-RECENT_TEXTS)
      const turnCount = active.turn_count + 1
      const refreshEvery = Number(Flag.OPENCODE_MEMORY_INTENT_REFRESH_EVERY ?? DEFAULT_REFRESH_EVERY)
      const refreshed = turnCount % refreshEvery === 0
      // Extractive delta-refresh keeps the summary tracking the live topic so
      // cosine measures drift from the current direction, not from turn one.
      const summary = refreshed ? recent.join("\n") : active.summary
      yield* db
        .update(IntentTable)
        .set({
          summary,
          last_active_at: now,
          turn_count: turnCount,
          token_count: active.token_count + estimateTokens(text),
          meta: { ...meta, recent_texts: recent },
        })
        .where(eq(IntentTable.id, active.id))
        .run()
        .pipe(Effect.orDie)

      if (Flag.OPENCODE_MEMORY_INTENT_DEBUG)
        console.log("[intent-tracker]", {
          session: input.sessionID,
          turn: turnIndex,
          cosine: score.toFixed(3),
          intent: active.id,
          refreshed,
        })
    })

    return Service.of({ track })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Database.node],
})

export * as IntentTracker from "./intent-tracker"
