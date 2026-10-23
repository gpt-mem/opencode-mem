import { makeLocationNode } from "@opencode/util/effect/app-node"
import { CacheMarkLedgerService } from "./cache-mark-ledger.js"

// Cache mark ledger entry for MemoryContext integration
export const node = makeLocationNode({
  service: CacheMarkLedgerService,
  layer: CacheMarkLedgerService.layer,
  deps: [],
})