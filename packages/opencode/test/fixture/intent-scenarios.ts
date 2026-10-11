// Labeled scenario turns from the issue #25 stage-3 runs (issue #37 dataset):
// S1 stable-long (15 turns, 0 switches), S2 hard-switch (13 turns, switch at
// t9), S4 return (10 turns, switches at t5 and t8). Verbatim prompts from the
// bench25 harness — the regression set for the precision-first detector.

export const scenarioS1: readonly string[] = [
  "Open module.js in the current directory and read it fully. Reply with exactly two lines and nothing else: EXPORTS: <count of functions listed in module.exports>, LINES: <total line count of the file>. Do not quote file contents.",
  "Add a one-line comment above the validateConfig function describing what it validates.",
  "Add a one-line comment above the loadUser function.",
  "Add a one-line comment above the calculateTotal function.",
  "In formatDate, extract the two padStart calls into a local helper function pad2(n) inside formatDate and use it. Keep behavior identical.",
  "In loadUser, rename the variable row to user and update its usages. Keep behavior identical.",
  "Add a one-line comment above the parseSession function.",
  "Add a one-line comment above the mergeDefaults function.",
  "Add a one-line comment above the withDeadline function.",
  "In calculateTotal, rename the variable total to grandTotal and update its usages inside that function only.",
  "Add a one-line comment above the retrySafe function.",
  "In parseSession, change the error log line \"bad header shape\" to \"parseSession: bad header shape\".",
  "Run this command and report its output: node -e \"const m=require('./module.js'); console.log(typeof m.validateConfig, typeof m.loadUser, typeof m.calculateTotal)\"",
  "Run this command and report its output: node -e \"require('./module.js'); console.log('loads ok')\"",
  "Final check — answer from memory, do not re-read files: what was the RELEASE_TOKEN constant value in module.js when you first read it? If it is not in your visible context, use your memory tools (find_tool_calls / get_tool_call_details) to retrieve it. Answer exactly one line: TOKEN: <value>",]

export const scenarioS2: readonly string[] = [
  "Open module.js in the current directory and read it fully. Reply with exactly two lines and nothing else: EXPORTS: <count of functions listed in module.exports>, LINES: <total line count of the file>. Do not quote file contents.",
  "Add a one-line comment above the validateConfig function.",
  "Add a one-line comment above the loadUser function.",
  "Add a one-line comment above the calculateTotal function.",
  "In loadUser, rename the variable row to user and update its usages.",
  "Add a one-line comment above the parseSession function.",
  "Run this command and report its output: node -e \"require('./module.js'); console.log('loads ok')\"",
  "Summarize the edits you made to module.js in this session so far, in three short bullet lines.",
  "New task, completely unrelated domain: analyze sales data in data.csv (columns: order_id,region,product,category,qty,price). Compute total revenue (qty times price) per region. Reply with the four region totals and name the top region.",
  "From the same data.csv: which product category has the highest total revenue? Reply exactly one line: TOP_CATEGORY: <name>",
  "How many distinct products are in data.csv? Reply exactly one line: PRODUCTS: <count>",
  "Write your sales analysis so far to analysis.md as a short markdown report with a table of region revenues and the top category.",
  "Two questions from memory, do not re-read files unless you must: (1) What was the RELEASE_TOKEN constant value in module.js earlier in this session? Use your memory tools if the answer is not in your visible context. (2) Which region had the highest revenue? Reply exactly one line: TOKEN: <value> / TOP_REGION: <value>",]

export const scenarioS4: readonly string[] = [
  "Open module.js in the current directory and read it fully. Reply with exactly two lines and nothing else: EXPORTS: <count of functions listed in module.exports>, LINES: <total line count of the file>. Do not quote file contents.",
  "Add a one-line comment above the validateConfig function.",
  "Add a one-line comment above the loadUser function.",
  "Run this command and report its output: node -e \"require('./module.js'); console.log('loads ok')\"",
  "New task, completely unrelated domain: analyze sales data in data.csv (columns: order_id,region,product,category,qty,price). Compute total revenue (qty times price) per region and name the top region.",
  "From the same data.csv: which product category has the highest total revenue? Reply exactly one line: TOP_CATEGORY: <name>",
  "How many distinct products are in data.csv? Reply exactly one line: PRODUCTS: <count>",
  "Let's go back to the first task — refactoring module.js. Continue where we left off: add a one-line comment above the calculateTotal function.",
  "Add a one-line comment above the parseSession function and one above the mergeDefaults function.",
  "Final answers from memory, do not re-read files unless you must: (1) the RELEASE_TOKEN constant value from module.js. (2) TOP_REGION from the sales analysis. (3) TOP_CATEGORY from the sales analysis. Use your memory tools if the answers are not in your visible context. Reply exactly one line: TOKEN: <value> / TOP_REGION: <value> / TOP_CATEGORY: <value>",]

export const scenarioTruth: Readonly<Record<"s1" | "s2" | "s4", readonly number[]>> = {
  s1: [],
  s2: [9],
  s4: [5, 8],
}
