export * as MemoryTools from "./memory-tools"

// Memory tools are the retrieval plumbing over this session's own tool-call
// index. Their calls must never become search candidates: every query would
// index itself, so a pattern present in one query propagates into the next
// search (issue #34). Nothing is hidden — the calls stay in session history
// and stay reachable through get_tool_call_details(call_id).
export const names: ReadonlySet<string> = new Set([
  "find_tool_calls",
  "get_tool_call_overview",
  "get_tool_call_details",
])
