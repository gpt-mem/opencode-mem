import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Context, Layer } from "effect"
import { and, count, desc, eq, max } from "drizzle-orm"
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

// Hysteresis decision layer (issue #25 day 2). Calibrated on 111 real
// transitions (cache-intent-research REAL-DATA-ANALYSIS.md §B3): topic
// switches scored cosine 0.23-0.41 against sticky summaries while
// continuations scored 0.53-1.00 — threshold 0.475 sits in the clean gap.
const DEFAULT_SWITCH_THRESHOLD = 0.475
// Guards keep precision ≥0.9 within the FP budget (PLAN.md day 2): an intent
// must be worth cutting (turns OR tokens), a switch signal needs enough text
// to be evidence, and switches cannot flap (cool-down after a switch).
const MIN_INTENT_TURNS = 2
const MIN_INTENT_TOKENS = 2000
const COOLDOWN_TURNS = 2
const MIN_SWITCH_TEXT_CHARS = 30

// 35-55% of real user turns are short continuations (REAL-DATA-ANALYSIS §B5):
// markers like "ок/да/продолжай", pure punctuation, or additive "еще/+" prefixes.
// They share almost no ngrams with the summary, so cosine alone would read them
// as switches (the raw-message baseline had 87% false positives). Guard first.
const CONTINUATION_MARKER_RE =
  /^[\s.!…]*((ok(aye)?|yep|yeah|yes|sure|go|continue|done|nice|great)|(ок(ей)?|ага|угу|да|давай|погнали|поехали|продолж\w*|дальше|норм\w*|готово|понял\w*|ясно|понятно|упс|ой))[\s.!…]*$/i
const CONTINUATION_PUNCT_RE = /^[\s.!…]+$/
const ADDITIVE_PREFIX_RE = /^[\s]*((еще|ещё)\b|а\s+(еще|ещё)\b|и\s+(еще|ещё)\b|плюс\b|\+)/i

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

const resolveSwitchThreshold = () => {
  const value = Number(Flag.OPENCODE_MEMORY_INTENT_SWITCH_THRESHOLD)
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : DEFAULT_SWITCH_THRESHOLD
}

// Pure hysteresis decision: whether this turn confirms an intent switch.
// Order matters — cheap text guards first, then the cosine threshold, then
// the guards that keep precision high (young intent, switch flapping).
const decideSwitch = (input: {
  readonly text: string
  readonly score: number
  readonly turnCount: number
  readonly tokenCount: number
  readonly turnIndex: number
  readonly lastSwitchTurn: number | undefined
  readonly threshold: number
}): boolean => {
  const trimmed = input.text.trim()
  if (CONTINUATION_PUNCT_RE.test(trimmed)) return false
  if (CONTINUATION_MARKER_RE.test(trimmed)) return false
  if (ADDITIVE_PREFIX_RE.test(trimmed)) return false
  if (trimmed.length < MIN_SWITCH_TEXT_CHARS) return false
  if (input.score >= input.threshold) return false
  if (input.turnCount < MIN_INTENT_TURNS && input.tokenCount < MIN_INTENT_TOKENS) return false
  if (input.lastSwitchTurn !== undefined && input.turnIndex - input.lastSwitchTurn < COOLDOWN_TURNS)
    return false
  return true
}

const userText = (parts: readonly SessionV1.Part[]) =>
  parts
    .filter((part): part is SessionV1.TextPart => part.type === "text")
    .map((part) => part.text)
    .join("\n")

export interface Interface {
  readonly track: (input: {
    sessionID: SessionID
    parts: readonly SessionV1.Part[]
    messageID?: string
  }) => Effect.Effect<void>
  // Issue #25 B3: user message ID that opened the active intent via a confirmed
  // switch, or undefined (no switch, act off, or cut flag off). The projection
  // uses it as the compaction boundary for the closed intent's segment.
  readonly activeSwitchMessage: (input: { sessionID: SessionID }) => Effect.Effect<string | undefined>
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
      messageID?: string
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

      // Day-2 act mode (issue #25): on a confirmed switch the old intent is
      // closed and a new child intent takes over. Off (default) keeps the
      // day-1 log-only behavior byte-for-byte: signals are recorded, nothing
      // switches. The decision itself never mutates model-visible messages.
      if (Flag.OPENCODE_MEMORY_INTENT_ACT) {
        const lastSwitch = yield* db
          .select({ turn: max(IntentSignalTable.turn_index) })
          .from(IntentSignalTable)
          .where(and(eq(IntentSignalTable.session_id, input.sessionID), eq(IntentSignalTable.acted, 1)))
          .get()
          .pipe(Effect.orDie)
        const switched = decideSwitch({
          text,
          score,
          turnCount: active.turn_count,
          tokenCount: active.token_count,
          turnIndex,
          lastSwitchTurn: lastSwitch?.turn ?? undefined,
          threshold: resolveSwitchThreshold(),
        })
        if (switched) {
          const now2 = Date.now()
          yield* db
            .insert(IntentSignalTable)
            .values({ session_id: input.sessionID, turn_index: turnIndex, cosine: score, acted: 1, ts: now2 })
            .run()
            .pipe(Effect.orDie)
          yield* db
            .update(IntentTable)
            .set({ status: "closed", closed_at: now2, close_reason: "switch", last_active_at: now2 })
            .where(eq(IntentTable.id, active.id))
            .run()
            .pipe(Effect.orDie)
          yield* db
            .insert(IntentTable)
            .values({
              id: ulid(),
              session_id: input.sessionID,
              parent_id: active.id,
              summary: text.slice(0, SUMMARY_TEXT_CHARS),
              started_at: now2,
              last_active_at: now2,
              turn_count: 1,
              token_count: estimateTokens(text),
              meta: {
                embedding_model: EMBEDDING_MODEL,
                recent_texts: [text.slice(0, SUMMARY_TEXT_CHARS)],
                // Issue #25 B3: the user message that opened this intent marks
                // the cut boundary for the closed intent's segment.
                ...(input.messageID === undefined ? {} : { switch_message_id: input.messageID }),
              },
            })
            .run()
            .pipe(Effect.orDie)
          if (Flag.OPENCODE_MEMORY_INTENT_DEBUG)
            console.log("[intent-tracker]", {
              session: input.sessionID,
              turn: turnIndex,
              cosine: score.toFixed(3),
              switched: true,
              closed: active.id,
            })
          return
        }
      }

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

    const activeSwitchMessage = Effect.fn("IntentTracker.activeSwitchMessage")(function* (input: {
      sessionID: SessionID
    }) {
      if (!Flag.OPENCODE_MEMORY_INTENT_CUT) return undefined
      const active = yield* db
        .select()
        .from(IntentTable)
        .where(and(eq(IntentTable.session_id, input.sessionID), eq(IntentTable.status, "active")))
        .orderBy(desc(IntentTable.started_at))
        .limit(1)
        .get()
        .pipe(Effect.orDie)
      const meta = (active?.meta ?? {}) as { switch_message_id?: string }
      return meta.switch_message_id
    })

    return Service.of({ track, activeSwitchMessage })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Database.node],
})

export * as IntentTracker from "./intent-tracker"
