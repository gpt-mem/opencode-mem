import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261022000000_unified_mask_cache_mark_ledger",
  up(tx) {
    return Effect.gen(function* () {
      // Add the provider_cache_mark table with the unified mask schema
      // This table tracks how much prefix each provider has confirmed as cached
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`provider_cache_mark\` (
          \`provider_id\` text PRIMARY KEY,
          \`mark_tokens\` integer NOT NULL DEFAULT 0,
          \`prefix_hash\` text,
          \`last_used_at\` integer NOT NULL
        );
      `)
      
      // Create an index on last_used_at for idle detection
      yield* tx.run(`
        CREATE INDEX IF NOT EXISTS \`idx_provider_cache_mark_last_used_at\` 
        ON \`provider_cache_mark\` (\`last_used_at\`);
      `)
    })
  },
}

export default migration