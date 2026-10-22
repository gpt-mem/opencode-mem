import { Context, Effect, Layer } from "effect"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { CacheMarkLedgerService } from "./cache-mark-ledger.js"

export const node = makeLocationNode({
  service: CacheMarkLedgerService,
  layer: CacheMarkLedgerService.layer,
  deps: [],
})