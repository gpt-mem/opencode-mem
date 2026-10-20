import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { ProjectTable } from "../project/sql.js"
import { MemRecord } from "./mem-record.js"

// Operational memory records. One row = one decision/fact, project-scoped and
// optionally linked to the session that produced it. Columns mirror the v1
// `mem_record` table so the ported store layer (mem-record-store) can move over
// without changing its persistence contract. Superseded records stay in place
// with `status` flipped; `supersedes` points at the record being replaced.
export const MemRecordTable = sqliteTable(
  "mem_record",
  {
    id: text().primaryKey(),
    project_id: text()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    session_id: text(),
    type: text().$type<MemRecord.Type>().notNull(),
    subject: text().notNull(),
    content: text().notNull(),
    reason: text(),
    status: text().$type<MemRecord.Status>().notNull().default("active"),
    authority: text().$type<MemRecord.Authority>().notNull(),
    decided_by: text(),
    recorded_by: text().notNull(),
    source_ref: text(),
    scope: text(),
    supersedes: text(),
    version: integer().notNull().default(1),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
  },
  (table) => [
    index("mem_record_project_type_status_idx").on(table.project_id, table.type, table.status),
    index("mem_record_project_subject_idx").on(table.project_id, table.subject),
    index("mem_record_session_idx").on(table.session_id),
  ],
)
