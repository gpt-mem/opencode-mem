import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261011130000_provider_cache_mark",
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
} satisfies DatabaseMigration.Migration
