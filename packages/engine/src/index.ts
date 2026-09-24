// `archive-compat` is deliberately not here: it writes `result.json` without a slot, so a caller
// that reached it through this barrel could win the inode claim under a live run.

// A finished run is re-priced from its `output.json` with another table.
export { describeAccounting } from "./accounting/format";
export { type ModelRate, type PriceTable, PUBLISHED_PRICES } from "./accounting/prices";
export { summarizeRun } from "./accounting/summary";
export * from "./jsonl";
export * from "./run-dir";
export * from "./workflow-runner";
