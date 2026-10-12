import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261011235047_mem_record",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`mem_record\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`session_id\` text,
          \`type\` text NOT NULL,
          \`subject\` text NOT NULL,
          \`content\` text NOT NULL,
          \`reason\` text,
          \`status\` text DEFAULT 'active' NOT NULL,
          \`authority\` text NOT NULL,
          \`decided_by\` text,
          \`recorded_by\` text NOT NULL,
          \`source_ref\` text,
          \`scope\` text,
          \`supersedes\` text,
          \`version\` integer DEFAULT 1 NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_mem_record_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`mem_record_project_type_status_idx\` ON \`mem_record\` (\`project_id\`,\`type\`,\`status\`);`,
      )
      yield* tx.run(`CREATE INDEX \`mem_record_project_subject_idx\` ON \`mem_record\` (\`project_id\`,\`subject\`);`)
      yield* tx.run(`CREATE INDEX \`mem_record_session_idx\` ON \`mem_record\` (\`session_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
