import { makeLocationNode } from "@opencode/util/effect/app-node"
import { CacheMarkLedgerService } from "./cache-mark-ledger.js"
import { Database } from "../database/database.js"

// Cache mark ledger entry for MemoryContext integration
export const node = makeLocationNode({
  service: CacheMarkLedgerService,
  layer: CacheMarkLedgerService.layer,
  deps: [Database.node],
})

export const CacheMarkLedgerEntry = {
  node,
}