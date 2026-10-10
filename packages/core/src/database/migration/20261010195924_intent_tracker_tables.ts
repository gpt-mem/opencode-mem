import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261010195924_intent_tracker_tables",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`intent_signal\` (
          \`id\` integer PRIMARY KEY AUTOINCREMENT,
          \`session_id\` text NOT NULL,
          \`turn_index\` integer NOT NULL,
          \`cosine\` real,
          \`llm_label\` text,
          \`llm_conf\` real,
          \`acted\` integer DEFAULT 0 NOT NULL,
          \`ts\` integer NOT NULL,
          CONSTRAINT \`fk_intent_signal_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`intent\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`parent_id\` text,
          \`summary\` text NOT NULL,
          \`summary_embedding\` blob,
          \`status\` text DEFAULT 'active' NOT NULL,
          \`started_at\` integer NOT NULL,
          \`last_active_at\` integer NOT NULL,
          \`closed_at\` integer,
          \`close_reason\` text,
          \`turn_count\` integer DEFAULT 0 NOT NULL,
          \`token_count\` integer DEFAULT 0 NOT NULL,
          \`meta\` text,
          CONSTRAINT \`fk_intent_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`intent_signal_session_turn_idx\` ON \`intent_signal\` (\`session_id\`,\`turn_index\`);`,
      )
      yield* tx.run(`CREATE INDEX \`intent_session_status_idx\` ON \`intent\` (\`session_id\`,\`status\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
