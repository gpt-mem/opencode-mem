import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261019172723_colossal_sue_storm",
  up(tx) {
    return Effect.gen(function* () {
      // IF NOT EXISTS: the ledger table is also part of the baseline schema, and an
      // earlier build of this line created it under a different migration id
      // (20261011014246_damp_diamondback). A database that already carries the table
      // is a normal state, not a broken one — without this the migration dies on
      // "table provider_cache_mark already exists" and the fork cannot open the
      // database at all.
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`provider_cache_mark\` (
          \`provider_id\` text PRIMARY KEY,
          \`mark_tokens\` integer DEFAULT 0 NOT NULL,
          \`mark_index\` integer DEFAULT 0 NOT NULL,
          \`prefix_hash\` text,
          \`last_used_at\` integer NOT NULL
        );
      `)
    })
  },
}

export default migration
