import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261019172723_colossal_sue_storm",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`provider_cache_mark\` (
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
