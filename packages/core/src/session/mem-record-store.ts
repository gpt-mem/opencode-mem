export * as MemRecordStore from "./mem-record-store.js"

import { Effect } from "effect"
import { and, eq } from "drizzle-orm"
import { Identifier } from "@opencode/schema/identifier"
import { Database } from "../database/database.js"
import { MemRecord } from "./mem-record.js"
import { MemRecordTable } from "./mem-record.sql.js"
import { SessionSchema } from "./schema.js"
import { SessionTable } from "./sql.js"

type Db = Database.Interface["db"]

const MAX_CHAIN = 10

export const toRecord = (row: typeof MemRecordTable.$inferSelect): MemRecord.Record => ({
  id: row.id,
  type: row.type,
  subject: row.subject,
  content: row.content,
  reason: row.reason ?? undefined,
  status: row.status,
  authority: row.authority,
  decided_by: row.decided_by ?? undefined,
  recorded_by: row.recorded_by,
  source_ref: row.source_ref ?? undefined,
  scope: row.scope ?? undefined,
  supersedes: row.supersedes ?? undefined,
  version: row.version,
  time_created: row.time_created,
  time_updated: row.time_updated,
})

export type WriteError =
  | { readonly kind: "no_project"; readonly sessionID: SessionSchema.ID }
  | { readonly kind: "empty_decision"; readonly subject: string }
  | { readonly kind: "supersedes_not_found"; readonly id: string; readonly subject: string }
  | { readonly kind: "supersedes_not_active"; readonly id: string; readonly status: string; readonly subject: string }

export type WriteResult =
  | { readonly ok: true; readonly records: MemRecord.Record[] }
  | { readonly ok: false; readonly error: WriteError }

// Validate the whole batch before writing anything so a bad entry cannot leave
// a partially applied batch behind (all-or-nothing).
export const writeBatch = (
  db: Db,
  input: {
    readonly sessionID: SessionSchema.ID
    readonly agent: string
    readonly entries: readonly MemRecord.Entry[]
  },
): Effect.Effect<WriteResult> =>
  Effect.gen(function* () {
    const session = yield* db
      .select({ project_id: SessionTable.project_id })
      .from(SessionTable)
      .where(eq(SessionTable.id, input.sessionID))
      .get()
      .pipe(Effect.orDie)
    if (session === undefined) {
      return { ok: false as const, error: { kind: "no_project" as const, sessionID: input.sessionID } }
    }
    const projectID = session.project_id

    for (const entry of input.entries) {
      if ((entry.decision ?? "").trim() === "") {
        return { ok: false as const, error: { kind: "empty_decision" as const, subject: entry.subject } }
      }
      if (entry.supersedes !== undefined) {
        const target = yield* db
          .select({ id: MemRecordTable.id, status: MemRecordTable.status })
          .from(MemRecordTable)
          .where(and(eq(MemRecordTable.id, entry.supersedes), eq(MemRecordTable.project_id, projectID)))
          .get()
          .pipe(Effect.orDie)
        if (target === undefined) {
          return {
            ok: false as const,
            error: { kind: "supersedes_not_found" as const, id: entry.supersedes, subject: entry.subject },
          }
        }
        if (target.status !== "active") {
          return {
            ok: false as const,
            error: {
              kind: "supersedes_not_active" as const,
              id: entry.supersedes,
              status: target.status,
              subject: entry.subject,
            },
          }
        }
      }
    }

    const now = Date.now()
    const inserted: MemRecord.Record[] = []
    for (const entry of input.entries) {
      const decision = entry.decision ?? ""
      const authority = MemRecord.resolveAuthority({
        decided_by: entry.decided_by,
        recorded_by: input.agent,
      })
      let version = 1
      if (entry.supersedes !== undefined) {
        const old = yield* db
          .select({ version: MemRecordTable.version })
          .from(MemRecordTable)
          .where(eq(MemRecordTable.id, entry.supersedes))
          .get()
          .pipe(Effect.orDie)
        version = (old?.version ?? 0) + 1
        yield* db
          .update(MemRecordTable)
          .set({ status: "superseded", time_updated: now })
          .where(eq(MemRecordTable.id, entry.supersedes))
          .run()
          .pipe(Effect.orDie)
      }
      const row = {
        id: `mem_${Identifier.create(false)}`,
        project_id: projectID,
        session_id: input.sessionID,
        type: entry.type,
        subject: MemRecord.normalizeSubject(entry.subject),
        content: MemRecord.redactContent(decision),
        reason: entry.reason === undefined ? null : MemRecord.redactReason(entry.reason),
        status: "active" as const,
        authority,
        decided_by: entry.decided_by ?? null,
        recorded_by: input.agent,
        source_ref: entry.source_ref ?? null,
        scope: entry.scope ?? null,
        supersedes: entry.supersedes ?? null,
        version,
        time_created: now,
        time_updated: now,
      }
      yield* db.insert(MemRecordTable).values(row).run().pipe(Effect.orDie)
      inserted.push(toRecord(row))
    }
    return { ok: true as const, records: inserted }
  })

type MemRecordRow = typeof MemRecordTable.$inferSelect

const compileRegex = (query: string): RegExp | undefined => {
  try {
    return new RegExp(query, "i")
  } catch {
    return undefined
  }
}

const haystackOf = (row: MemRecordRow) => [row.subject, row.content, row.reason ?? ""].join("\n")

const regexMatches = (query: string, rows: MemRecordRow[]): MemRecordRow[] => {
  const regex = compileRegex(query)
  if (regex === undefined) return []
  return rows.filter((row) => regex.test(haystackOf(row)))
}

// A natural-language query is usually not a valid regex and misses on word
// forms ("идемпотентные" vs "идемпотентной"), so retry the query's words as
// plain substrings and rank rows by how many distinct words they contain.
const plainTextMatches = (query: string, rows: MemRecordRow[]): MemRecordRow[] => {
  const terms = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length > 0)
  if (terms.length === 0) return []
  return rows
    .map((row) => {
      const text = haystackOf(row).toLowerCase()
      return { row, hits: terms.filter((term) => text.includes(term)).length }
    })
    .filter((entry) => entry.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .map((entry) => entry.row)
}

export type SearchResult = {
  readonly records: MemRecord.Record[]
  readonly matched: number
  /** Rows matching every non-query filter, before the query regex is applied. */
  readonly filter_matched: number
  /**
   * Set when a query regex erased records the other filters had matched. A bare
   * `0` reads as "memory is empty" and the caller stops looking, so surface why.
   */
  readonly hint?: string
}

export const search = (
  db: Db,
  input: {
    readonly sessionID: SessionSchema.ID
    readonly query?: string
    readonly type?: MemRecord.Type
    readonly status?: MemRecord.Status
    readonly scope?: string
    readonly limit?: number
  },
): Effect.Effect<SearchResult | undefined> =>
  Effect.gen(function* () {
    const session = yield* db
      .select({ project_id: SessionTable.project_id })
      .from(SessionTable)
      .where(eq(SessionTable.id, input.sessionID))
      .get()
      .pipe(Effect.orDie)
    if (session === undefined) return undefined

    const conditions = [eq(MemRecordTable.project_id, session.project_id)]
    if (input.type !== undefined) conditions.push(eq(MemRecordTable.type, input.type))
    if (input.scope !== undefined) conditions.push(eq(MemRecordTable.scope, input.scope))
    // Default to active-only so superseded/rejected noise stays out of the way;
    // an explicit status overrides. The filter applies to queries too: a
    // plain-language question must not surface a superseded record as if it
    // were the current decision.
    if (input.status !== undefined) conditions.push(eq(MemRecordTable.status, input.status))
    else conditions.push(eq(MemRecordTable.status, "active"))

    const rows = yield* db
      .select()
      .from(MemRecordTable)
      .where(and(...conditions))
      .orderBy(MemRecordTable.time_created, MemRecordTable.id)
      .all()
      .pipe(Effect.orDie)

    let matched: MemRecordRow[] = rows
    // The plain-text fallback ranks records by how many query terms they
    // contain, best first. The regex pass and the no-query listing keep row
    // order (oldest first), where the newest records win the limit. Slicing
    // the tail of the ranked array would hand back the worst matches, so the
    // ranked pass has to keep the head.
    let ranked = false
    if (input.query !== undefined) {
      // Regex is the documented semantics; fall back to plain-text words before
      // reporting "nothing found" so a natural-language question still hits.
      matched = regexMatches(input.query, rows)
      if (matched.length === 0) {
        matched = plainTextMatches(input.query, rows)
        ranked = true
      }
    }

    const limit = Math.max(1, Math.min(input.limit ?? 20, 100))
    // A type name like "decision" is a label, not text that appears in the
    // records themselves, so `type=decision&query=decision` empties a non-empty
    // store. Say so instead of returning a bare zero.
    const hint =
      input.query !== undefined && matched.length === 0 && rows.length > 0
        ? `query matched 0 of ${rows.length} record(s) that match the other filters — matching tries a case-insensitive regex over subject/content/reason, then the query's words as plain text, so a type name like "${input.query}" usually matches nothing; retry without query to list them`
        : undefined
    return {
      records: (ranked ? matched.slice(0, limit) : matched.slice(-limit).reverse()).map(toRecord),
      matched: matched.length,
      filter_matched: rows.length,
      hint,
    }
  })

export type GetResult = {
  readonly found: true
  readonly record: MemRecord.Record
  readonly supersedes_chain: MemRecord.Record[]
  readonly superseded_by: MemRecord.Record[]
  readonly source?: { readonly ref: string; readonly retrieve?: string }
}

export const getWithChain = (
  db: Db,
  input: { readonly sessionID: SessionSchema.ID; readonly id: string },
): Effect.Effect<GetResult | { readonly found: false; readonly reason: "no_project" | "not_found" }> =>
  Effect.gen(function* () {
    const session = yield* db
      .select({ project_id: SessionTable.project_id })
      .from(SessionTable)
      .where(eq(SessionTable.id, input.sessionID))
      .get()
      .pipe(Effect.orDie)
    if (session === undefined) return { found: false as const, reason: "no_project" as const }

    const row = yield* db
      .select()
      .from(MemRecordTable)
      .where(and(eq(MemRecordTable.id, input.id), eq(MemRecordTable.project_id, session.project_id)))
      .get()
      .pipe(Effect.orDie)
    if (row === undefined) return { found: false as const, reason: "not_found" as const }

    // Walk the revision chain in both directions, bounded so a corrupt cycle
    // cannot loop forever.
    const supersedes_chain: MemRecord.Record[] = []
    let cursor = row.supersedes
    for (let i = 0; i < MAX_CHAIN && cursor !== null; i++) {
      const parent = yield* db
        .select()
        .from(MemRecordTable)
        .where(and(eq(MemRecordTable.id, cursor), eq(MemRecordTable.project_id, session.project_id)))
        .get()
        .pipe(Effect.orDie)
      if (parent === undefined) break
      supersedes_chain.unshift(toRecord(parent))
      cursor = parent.supersedes
    }

    const superseded_by: MemRecord.Record[] = []
    let child = row.id
    for (let i = 0; i < MAX_CHAIN; i++) {
      const next = yield* db
        .select()
        .from(MemRecordTable)
        .where(and(eq(MemRecordTable.supersedes, child), eq(MemRecordTable.project_id, session.project_id)))
        .orderBy(MemRecordTable.time_created, MemRecordTable.id)
        .get()
        .pipe(Effect.orDie)
      if (next === undefined) break
      superseded_by.push(toRecord(next))
      child = next.id
    }

    const source =
      row.source_ref === null
        ? undefined
        : {
            ref: row.source_ref,
            retrieve: row.source_ref.startsWith("call_")
              ? `get_tool_call_details(call_id="${row.source_ref}")`
              : undefined,
          }

    return { found: true as const, record: toRecord(row), supersedes_chain, superseded_by, source }
  })
