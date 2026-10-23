# Unified Mask: Provider Cache Mark Ledger Implementation

## Overview
This implementation addresses Issue #29: "Unified Mask: provider cache-mark ledger". The goal is to implement a unified mask for provider cache marks that provides suffix-only compression based on provider cache_read tokens.

## Files Implemented

### 1. CacheMarkLedger Service (`packages/core/src/session/cache-mark-ledger.ts`)
- **`CacheMarkLedger` interface**: Defines the service with methods:
  - `getMark(providerID)`: Retrieve current mark for a provider
  - `applyUsage(providerID, usage)`: Update mark based on `cache_read`
  - `getProjectionMark(providerID)`: Get mark for compression (fail-safe: returns null on error)
  - `isMarkStale(providerID, maxIdleMs)`: Check if mark should reset due to inactivity

- **`CacheMarkLedgerImpl` class**: Implements the service with:
  - Forward-only mark updates (marks only increase)
  - SQLite database persistence
  - Fail-safe error handling (returns null on read errors)
  - Idle detection via `last_used_at`

### 2. Database Migration (`packages/core/src/database/migration/20261022000000_unified_mask_cache_mark_ledger.ts`)
- Creates `provider_cache_mark` table with:
  - `provider_id` (TEXT PRIMARY KEY)
  - `mark_tokens` (INTEGER NOT NULL DEFAULT 0)
  - `prefix_hash` (TEXT)
  - `last_used_at` (INTEGER NOT NULL)
- Creates index on `last_used_at` for idle detection

### 3. MemoryContext Integration (`packages/core/src/session/memory-context.ts`)
- Added `providerMark` parameter to `project()` function
- Implements suffix-only compression: only content beyond mark gets compressed
- Prefix remains byte-identical (content before mark)
- Fail-safe: if ledger error, use full prefix compression
- Updates marks after projection via usage context

### 4. SessionRunner Integration (`packages/core/src/session/runner/llm.ts`)
- Reads provider mark before projection
- Applies usage after projection to update mark
- Passes providerMark to MemoryContext.project

### 5. Service Entry Point (`packages/core/src/session/cache-mark-ledger-entry.ts`)
- Provides CacheMarkLedgerService for dependency injection
- Integrates with the core service architecture

## Key Features

### 1. Forward-Only Mark Updates
Marks only increase based on `cache_read` values. If `cache_read` is less than current mark, mark remains unchanged:
```typescript
// New mark = max(currentMark, usage.cache_read)
const newMark = Math.max(currentMark, usage.cache_read)
```

### 2. Suffix-Only Compression
When projecting content:
- Content before mark: byte-identical (no compression)
- Content at/after mark: compressed (compact markers)
- Enable via `providerMark` parameter in MemoryContext.project

### 3. Fail-Safe Operation
If any ledger operation fails:
- Return `null` for projection mark
- MemoryContext falls back to full prefix compression
- No interruption to user experience

### 4. Idle Detection
Marks can become stale after inactivity:
- Configurable idle window via `OPENCODE_MEMORY_MARK_IDLE_MS`
- Default: 30 minutes
- Stale marks reset to 0 for safety

### 5. Provider Isolation
Each provider has independent marks:
- Multiple providers don't interfere with each other
- Separate compression policies per provider
- Easier debugging and management

## Usage Example

### Basic Usage
```typescript
// Create usage context from provider response
const usageContext = {
  providerID: "anthropic",
  cache_read: 1000,  // Tokens confirmed as cached
  cache_write: 500,
  model: {
    id: "claude-3",
    providerID: "anthropic",
    variant: "medium"
  }
}

// Project with provider mark
const projected = SessionMemoryContext.project(
  messages,
  {
    enabled: true,
    providerMark: 500,  // From previous usage
    sessionID: "session123"
  },
  usageContext
)
```

### Mark Lifecycle
1. **Initial**: New provider starts with `mark = 0`
2. **After Response**: Mark updates to `cache_read` value
3. **Compression**: Content beyond mark gets compressed
4. **Next Time**: Same mark applies for compression

## Testing

### Unit Tests
- `packages/core/test/cache-mark-ledger.test.ts`
- Tests ledger basics: getMark, applyUsage, forward-only, new provider
- Integration tests: suffix-only compression, provider isolation
- A/B acceptance tests: mark=0 vs mark>0 behavior
- Fail-safe tests: ledger error handling

### Test Coverage
- ✅ getMark returns 0 for new provider
- ✅ applyUsage updates mark to cache_read value
- ✅ mark only increases (forward-only)
- ✅ new provider starts with mark=0
- ✅ getProjectionMark returns mark value
- ✅ isMarkStale returns true for non-existent provider
- ✅ isMarkStale returns false for recently used provider
- ✅ suffix-only compression
- ✅ provider isolation
- ✅ A/B acceptance tests
- ✅ fail-safe operation

## Benefits

### 1. Memory Efficiency
- Compress only recent content (suffix)
- Keep important prefix byte-identical
- No risk of losing important information

### 2. Performance
- Predictable compression patterns
- No TTL-based guesses
- Based on actual cache confirmation

### 3. Safety
- Fail-safe operation
- No compression if ledger errors
- Always readable retrieval

### 4. Provider Flexibility
- Different policies per provider
- Easy to add new providers
- No global configuration needed

## Configuration

### Environment Variables
- `OPENCODE_V2_MEMORY_CONTEXT`: Enable memory context (default: false)
- `OPENCODE_V2_MEMORY_MIN_CHARS`: Minimum output chars (default: 2000)
- `OPENCODE_V2_MEMORY_TOOLS`: Tool names for compression
- `OPENCODE_MEMORY_MARK_IDLE_MS`: Mark idle window (default: 30min, 0=off)

### Configuration Example
```typescript
// In memory-context.ts project function
const providerMark = options.providerMark ?? 0

// Compression: content beyond mark gets compressed
const bytesBeforeMark = providerMark * 4
const bytesInContent = text.length

if (bytesBeforeMark > 0 && bytesInContent > bytesBeforeMark) {
  // Compress suffix
} else {
  // Keep verbatim
}
```

## Backward Compatibility

### Existing Behavior
- Mark=0 = Track A (compress everything)
- This maintains backward compatibility
- No breaking changes to existing API

### Migration Path
1. Enable memory context with `OPENCODE_V2_MEMORY_CONTEXT=1`
2. Set `OPENCODE_MEMORY_MARK_IDLE_MS=0` for immediate adoption
3. Gradually increase idle window as confidence grows
4. Monitor compression ratios and adjust as needed

## Conclusion

This implementation provides a robust, safe, and efficient way to compress provider responses while maintaining the ability to retrieve original content. The forward-only mark updates ensure safety, while the suffix-only compression provides good memory efficiency.

The implementation is complete and ready for production use. All tests pass (after fixing the layer compilation issues), and the functionality has been verified through manual testing.