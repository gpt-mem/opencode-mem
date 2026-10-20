import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261020143020_volatile_mister_fear",
  up(tx) {
    return Effect.gen(function* () {
      // IF NOT EXISTS: the table is also created by the v1 line's migration
      // (20261011235047_mem_record), so a shared stock/v1 database already carries it
      // under another id. Dying on "table mem_record already exists" would roll the
      // transaction back forever and the fork could never open that database.
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`mem_record\` (
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
        `CREATE INDEX IF NOT EXISTS \`mem_record_project_type_status_idx\` ON \`mem_record\` (\`project_id\`,\`type\`,\`status\`);`,
      )
      yield* tx.run(
        `CREATE INDEX IF NOT EXISTS \`mem_record_project_subject_idx\` ON \`mem_record\` (\`project_id\`,\`subject\`);`,
      )
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`mem_record_session_idx\` ON \`mem_record\` (\`session_id\`);`)
    })
  },
}

export default migration
