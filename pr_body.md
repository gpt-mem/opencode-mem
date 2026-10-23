Implements the Unified Mask provider cache mark ledger (issue #29).

## Changes

- **CacheMarkLedger service** (`packages/core/src/session/cache-mark-ledger.ts`):
  - `getMark(providerID)`: Retrieve current mark for a provider
  - `applyUsage(providerID, usage)`: Update mark based on `cache_read` (forward-only)
  - `getProjectionMark(providerID)`: Get mark for compression (fail-safe: returns null on error)
  - `isMarkStale(providerID, maxIdleMs)`: Check if mark should reset due to inactivity

- **Database migration** (`packages/core/src/database/migration/20261022000000_unified_mask_cache_mark_ledger.ts`):
  - Creates `provider_cache_mark` table (provider_id PK, mark_tokens, prefix_hash, last_used_at)
  - Index on `last_used_at` for idle detection
  - Uses `IF NOT EXISTS` for idempotent migrations

- **MemoryContext integration** (`packages/core/src/session/memory-context.ts`):
  - Added `providerMark` parameter to `project()` function
  - Only compresses content beyond the mark (suffix-based compression)
  - Content before mark remains byte-identical
  - Fail-safe: any ledger error → full prefix compression
  - Updates marks after projection via usage context

- **SessionRunner integration** (`packages/core/src/session/runner/llm.ts`):
  - Reads provider mark before projection
  - Applies usage after projection to update mark

- **Tests** (`packages/core/test/cache-mark-ledger.test.ts`):
  - Ledger basics: getMark=0 for new, applyUsage updates mark, forward-only, new provider=0
  - getProjectionMark returns mark, isMarkStale for non-existent/recent providers
  - Integration: suffix-only compression, prefix byte-identical, provider isolation
  - A/B acceptance: mark=0=Track A, mark>0=Track B, fail-safe
  - MemoryContext integration: providerMark parameter, falls back on ledger failure

Refs #29
