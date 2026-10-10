import { afterEach, beforeEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { IntentTable, IntentSignalTable, SessionTable } from "@opencode-ai/core/session/sql"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { Project } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { desc, eq } from "drizzle-orm"
import { Effect } from "effect"
import { SessionID } from "../../src/session/schema"
import { IntentTracker } from "../../src/session/intent-tracker"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(LayerNode.compile(LayerNode.group([Database.node, IntentTracker.node])))

const sessionID = SessionID.make("ses_v1_intent_tracker_test")

const textPart = (text: string) => ({
  id: `prt_${Math.random().toString(36).slice(2)}` as never,
  sessionID,
  messageID: "msg_test" as never,
  type: "text" as const,
  text,
  time: { start: 0, end: 1 },
})

const seed = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "v1-intent",
      directory: AbsolutePath.make("/project"),
      title: "test",
      version: "0.0.0",
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

const signals = Effect.gen(function* () {
  const { db } = yield* Database.Service
  return yield* db
    .select()
    .from(IntentSignalTable)
    .where(eq(IntentSignalTable.session_id, sessionID))
    .orderBy(IntentSignalTable.turn_index)
    .all()
    .pipe(Effect.orDie)
})

const intents = Effect.gen(function* () {
  const { db } = yield* Database.Service
  return yield* db
    .select()
    .from(IntentTable)
    .where(eq(IntentTable.session_id, sessionID))
    .orderBy(desc(IntentTable.started_at))
    .all()
    .pipe(Effect.orDie)
})

const reset = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db.delete(IntentSignalTable).where(eq(IntentSignalTable.session_id, sessionID)).run().pipe(Effect.orDie)
  yield* db.delete(IntentTable).where(eq(IntentTable.session_id, sessionID)).run().pipe(Effect.orDie)
})

beforeEach(() => {
  process.env["OPENCODE_MEMORY_INTENT"] = "1"
})

afterEach(() => {
  delete process.env["OPENCODE_MEMORY_INTENT"]
  delete process.env["OPENCODE_MEMORY_INTENT_REFRESH_EVERY"]
  delete process.env["OPENCODE_MEMORY_INTENT_ACT"]
  delete process.env["OPENCODE_MEMORY_INTENT_SWITCH_THRESHOLD"]
})

describe("IntentTracker", () => {
  it.live("flag off writes nothing", () =>
    Effect.gen(function* () {
      delete process.env["OPENCODE_MEMORY_INTENT"]
      const tracker = yield* IntentTracker.Service
      yield* seed
      yield* tracker.track({ sessionID, parts: [textPart("refactor the auth module")] as never })
      const rows = yield* intents
      expect(rows.length).toBe(0)
    }),
  )

  it.live("first turn creates an intent and a baseline signal", () =>
    Effect.gen(function* () {
      const tracker = yield* IntentTracker.Service
      yield* seed
      yield* reset
      yield* tracker.track({ sessionID, parts: [textPart("fix the login bug in auth.ts")] as never })
      const rows = yield* intents
      expect(rows.length).toBe(1)
      expect(rows[0].status).toBe("active")
      expect(rows[0].summary).toContain("login bug")
      expect(rows[0].turn_count).toBe(1)
      const sigs = yield* signals
      expect(sigs.length).toBe(1)
      expect(sigs[0].cosine).toBe(null)
    }),
  )

  it.live("similar follow-up scores high cosine, topic switch scores low", () =>
    Effect.gen(function* () {
      const tracker = yield* IntentTracker.Service
      yield* seed
      yield* reset
      yield* tracker.track({
        sessionID,
        parts: [textPart("fix the login bug in the authentication module")] as never,
      })
      yield* tracker.track({
        sessionID,
        parts: [textPart("the login bug in authentication happens on token refresh")] as never,
      })
      const afterFollowup = yield* signals
      expect(afterFollowup.length).toBe(2)
      const followup = afterFollowup[1].cosine ?? 0
      expect(followup).toBeGreaterThan(0.5)

      yield* tracker.track({
        sessionID,
        parts: [textPart("now write a python script that scrapes weather data from APIs")] as never,
      })
      const afterSwitch = yield* signals
      expect(afterSwitch.length).toBe(3)
      const switched = afterSwitch[2].cosine ?? 1
      expect(switched).toBeLessThan(followup)
      expect(switched).toBeLessThan(0.5)
    }),
  )

  it.live("summary delta-refreshes on the configured turn", () =>
    Effect.gen(function* () {
      process.env["OPENCODE_MEMORY_INTENT_REFRESH_EVERY"] = "3"
      const tracker = yield* IntentTracker.Service
      yield* seed
      yield* reset
      yield* tracker.track({ sessionID, parts: [textPart("alpha task one about parsers")] as never })
      yield* tracker.track({ sessionID, parts: [textPart("alpha task two about the parser bugs")] as never })
      let rows = yield* intents
      expect(rows[0].summary).toContain("alpha task one")
      yield* tracker.track({ sessionID, parts: [textPart("alpha task three still on parsers")] as never })
      rows = yield* intents
      expect(rows[0].turn_count).toBe(3)
      expect(rows[0].summary).toContain("alpha task three")
      const meta = rows[0].meta as { recent_texts?: string[] }
      expect(meta.recent_texts?.length).toBe(3)
    }),
  )

  it.live("secrets are redacted from stored summary", () =>
    Effect.gen(function* () {
      const tracker = yield* IntentTracker.Service
      yield* seed
      yield* reset
      yield* tracker.track({
        sessionID,
        parts: [textPart("deploy with API_KEY=sk-live-1234567890abcdef please")] as never,
      })
      const rows = yield* intents
      expect(rows[0].summary).not.toContain("sk-live-1234567890abcdef")
      expect(rows[0].summary).toContain("[REDACTED")
    }),
  )

  it.live("empty text parts are skipped", () =>
    Effect.gen(function* () {
      const tracker = yield* IntentTracker.Service
      yield* seed
      yield* reset
      yield* tracker.track({ sessionID, parts: [textPart("   ")] as never })
      const rows = yield* intents
      expect(rows.length).toBe(0)
    }),
  )

  it.live("act off keeps log-only behavior on a topic switch", () =>
    Effect.gen(function* () {
      const tracker = yield* IntentTracker.Service
      yield* seed
      yield* reset
      yield* tracker.track({ sessionID, parts: [textPart("fix the login bug in the authentication module")] as never })
      yield* tracker.track({
        sessionID,
        parts: [textPart("the login bug in authentication happens on token refresh")] as never,
      })
      yield* tracker.track({
        sessionID,
        parts: [textPart("now write a python script that scrapes weather data from public APIs")] as never,
      })
      const rows = yield* intents
      expect(rows.length).toBe(1)
      expect(rows[0].status).toBe("active")
      const sigs = yield* signals
      expect(sigs.length).toBe(3)
      expect(sigs[2].acted).toBe(0)
    }),
  )

  it.live("act on switches: old intent closed, child intent opened", () =>
    Effect.gen(function* () {
      process.env["OPENCODE_MEMORY_INTENT_ACT"] = "1"
      const tracker = yield* IntentTracker.Service
      yield* seed
      yield* reset
      yield* tracker.track({ sessionID, parts: [textPart("fix the login bug in the authentication module")] as never })
      yield* tracker.track({
        sessionID,
        parts: [textPart("the login bug in authentication happens on token refresh")] as never,
      })
      yield* tracker.track({
        sessionID,
        parts: [textPart("now write a python script that scrapes weather data from public APIs")] as never,
      })
      const rows = yield* intents
      expect(rows.length).toBe(2)
      const closed = rows.find((row) => row.status === "closed")
      const active = rows.find((row) => row.status === "active")
      expect(closed).toBeDefined()
      expect(closed?.close_reason).toBe("switch")
      expect(closed?.closed_at).not.toBe(null)
      expect(active).toBeDefined()
      expect(active?.parent_id).toBe(closed?.id)
      expect(active?.summary).toContain("weather")
      const sigs = yield* signals
      expect(sigs.length).toBe(3)
      expect(sigs[2].acted).toBe(1)
      expect(sigs[0].acted).toBe(0)
      expect(sigs[1].acted).toBe(0)
    }),
  )

  it.live("act on: continuation markers never switch", () =>
    Effect.gen(function* () {
      process.env["OPENCODE_MEMORY_INTENT_ACT"] = "1"
      const tracker = yield* IntentTracker.Service
      yield* seed
      yield* reset
      yield* tracker.track({ sessionID, parts: [textPart("fix the login bug in the authentication module")] as never })
      yield* tracker.track({
        sessionID,
        parts: [textPart("the login bug in authentication happens on token refresh")] as never,
      })
      for (const text of ["ок", ".", "да давай", "+ еще добавь тесты", "продолжай"]) {
        yield* tracker.track({ sessionID, parts: [textPart(text)] as never })
      }
      const rows = yield* intents
      expect(rows.length).toBe(1)
      expect(rows[0].status).toBe("active")
      const sigs = yield* signals
      expect(sigs.length).toBe(7)
      expect(sigs.slice(2).every((sig) => sig.acted === 0)).toBe(true)
    }),
  )

  it.live("act on: young intent is not closed", () =>
    Effect.gen(function* () {
      process.env["OPENCODE_MEMORY_INTENT_ACT"] = "1"
      const tracker = yield* IntentTracker.Service
      yield* seed
      yield* reset
      yield* tracker.track({ sessionID, parts: [textPart("fix the login bug in the authentication module")] as never })
      yield* tracker.track({
        sessionID,
        parts: [textPart("now write a python script that scrapes weather data from public APIs")] as never,
      })
      const rows = yield* intents
      expect(rows.length).toBe(1)
      expect(rows[0].status).toBe("active")
      const sigs = yield* signals
      expect(sigs[1].acted).toBe(0)
    }),
  )

  it.live("act on: cool-down prevents back-to-back switches", () =>
    Effect.gen(function* () {
      process.env["OPENCODE_MEMORY_INTENT_ACT"] = "1"
      const tracker = yield* IntentTracker.Service
      yield* seed
      yield* reset
      yield* tracker.track({ sessionID, parts: [textPart("fix the login bug in the authentication module")] as never })
      yield* tracker.track({
        sessionID,
        parts: [textPart("the login bug in authentication happens on token refresh")] as never,
      })
      yield* tracker.track({
        sessionID,
        parts: [textPart("now write a python script that scrapes weather data from public APIs")] as never,
      })
      // Immediately after the switch at turn 3, another unrelated topic — cooldown blocks it.
      yield* tracker.track({
        sessionID,
        parts: [textPart("configure a cron job that archives session logs every fifteen minutes")] as never,
      })
      const rows = yield* intents
      expect(rows.length).toBe(2)
      const sigs = yield* signals
      expect(sigs[3].acted).toBe(0)
      // Two turns after the switch the cool-down is over; a third topic may switch.
      yield* tracker.track({
        sessionID,
        parts: [textPart("research prefix cache pricing models for llm providers and billing")] as never,
      })
      const after = yield* intents
      expect(after.length).toBe(3)
      const sigsAfter = yield* signals
      expect(sigsAfter[4].acted).toBe(1)
    }),
  )

  it.live("act on: threshold env override forces and blocks switches", () =>
    Effect.gen(function* () {
      process.env["OPENCODE_MEMORY_INTENT_ACT"] = "1"
      process.env["OPENCODE_MEMORY_INTENT_SWITCH_THRESHOLD"] = "0.99"
      const tracker = yield* IntentTracker.Service
      yield* seed
      yield* reset
      yield* tracker.track({ sessionID, parts: [textPart("fix the login bug in the authentication module")] as never })
      yield* tracker.track({
        sessionID,
        parts: [textPart("the login bug in authentication happens on token refresh")] as never,
      })
      // Turn 2 continues (young-intent guard); turn 3 with threshold 0.99
      // makes even a high-cosine continuation read as a switch.
      yield* tracker.track({
        sessionID,
        parts: [textPart("the authentication login bug also affects the oauth token rotation path")] as never,
      })
      const forced = yield* intents
      expect(forced.length).toBe(2)
      expect(forced.some((row) => row.close_reason === "switch")).toBe(true)

      delete process.env["OPENCODE_MEMORY_INTENT_SWITCH_THRESHOLD"]
      process.env["OPENCODE_MEMORY_INTENT_SWITCH_THRESHOLD"] = "0"
      yield* reset
      yield* tracker.track({ sessionID, parts: [textPart("fix the login bug in the authentication module")] as never })
      yield* tracker.track({
        sessionID,
        parts: [textPart("the login bug in authentication happens on token refresh")] as never,
      })
      yield* tracker.track({
        sessionID,
        parts: [textPart("now write a python script that scrapes weather data from public APIs")] as never,
      })
      const blocked = yield* intents
      expect(blocked.length).toBe(1)
      expect(blocked[0].status).toBe("active")
    }),
  )
})
