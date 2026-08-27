/**
 * Reads a run's `trials.jsonl` and prints the two tables E2 exists to produce: delivery per
 * cell, and what a nudge costs next to the re-run it replaces.
 *
 *   bun run e2/report.ts e2/results/e2.jsonl
 */
import { formatTally, tally } from "../runner";
import type { TrialRecord } from "../trial";

const path = process.argv[2] ?? `${import.meta.dir}/results/e2.jsonl`;
const records = (await Bun.file(path).text())
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line) as TrialRecord);
if (records.length === 0) throw new Error(`no trials in ${path}`);

console.log(`${records.length} trials from ${path}\n`);
console.log(formatTally(tally(records)));

console.log("\ntiming, ms (median first turn / median nudge turn)\n");
for (const group of byCell(records)) {
  const nudges = group.rows.filter((row) => row.nudgeTurnMs !== null);
  console.log(
    [
      group.key.padEnd(34),
      String(Math.round(median(group.rows.map((row) => row.firstTurnMs)))).padStart(7),
      nudges.length === 0
        ? "      -"
        : String(Math.round(median(nudges.map((row) => row.nudgeTurnMs!)))).padStart(7),
      `  n=${group.rows.length}, nudges=${nudges.length}`,
    ].join("  "),
  );
}

/**
 * The plan claims a nudge is much cheaper than re-running the step, because the agent still
 * holds the task. A re-run is exactly a fresh first turn, so the first-turn column is the
 * price of the alternative and no separate experiment is needed to know it.
 */
console.log("\nnudge versus re-run, per harness+backend\n");
console.log(
  ["harness/backend".padEnd(20), "first turn", "nudge turn", "ratio", "unit"].join("  "),
);
for (const group of byHarnessBackend(records)) {
  const firstCost = mean(group.rows.map((row) => row.firstTurnUsage?.costUsd));
  const nudgeCost = mean(
    group.rows.filter((row) => row.nudged).map((row) => row.nudgeTurnUsage?.costUsd),
  );
  const firstTokens = mean(group.rows.map((row) => billable(row.firstTurnUsage)));
  const nudgeTokens = mean(
    group.rows.filter((row) => row.nudged).map((row) => billable(row.nudgeTurnUsage)),
  );
  const nudges = group.rows.filter((record) => record.nudged).length;
  if (firstCost !== null) {
    console.log(row(group.key, money(firstCost), money(nudgeCost), share(nudgeCost, firstCost), `usd, ${nudges} nudges`));
  }
  if (firstTokens !== null) {
    console.log(row(group.key, tokens(firstTokens), tokens(nudgeTokens), share(nudgeTokens, firstTokens), `tokens in+out, ${nudges} nudges`));
  }
  if (firstCost === null && firstTokens === null) {
    console.log(row(group.key, "-", "-", null, "harness reports nothing"));
  }
}

console.log("\nwhat the first turn did, per cell\n");
for (const group of byCell(records)) {
  const count = (value: string) =>
    group.rows.filter((record) => record.firstAttempt === value).length;
  console.log(
    [
      group.key.padEnd(34),
      `accepted ${count("accepted")}`,
      `corrected-in-turn ${count("corrected")}`,
      `refused ${count("malformed")}`,
      `silent ${count("absent")}`,
    ].join("  "),
  );
}

const failures = records.filter((record) => record.outcome === "lost" || record.error);
if (failures.length > 0) {
  console.log(`\n${failures.length} losses and errors\n`);
  for (const record of failures) {
    console.log(
      [
        record.callId.padEnd(36),
        record.firstAttempt.padEnd(10),
        `${record.settled}/${record.settledAfterNudge ?? "-"}`.padEnd(16),
        (record.error ?? record.rejection ?? "no value on the channel").replace(/\n/g, " ").slice(0, 150),
      ].join("  "),
    );
  }
}

function money(value: number | null): string {
  return value === null ? "-" : `$${value.toFixed(4)}`;
}

function tokens(value: number | null): string {
  return value === null ? "-" : String(Math.round(value));
}

function share(nudge: number | null, first: number | null): number | null {
  return nudge === null || first === null || first === 0 ? null : nudge / first;
}

function row(key: string, first: string, nudge: string, ratio: number | null, unit: string): string {
  return [
    key.padEnd(20),
    first.padStart(10),
    nudge.padStart(10),
    (ratio === null ? "-" : `${(ratio * 100).toFixed(0)}%`).padStart(6),
    unit,
  ].join("  ");
}

function billable(usage: TrialRecord["firstTurnUsage"]): number | undefined {
  if (!usage) return undefined;
  const input = (usage.inputTokens ?? 0) + (usage.cachedInputTokens ?? 0);
  const output = usage.outputTokens ?? 0;
  return input + output === 0 ? undefined : input + output;
}

function byCell(rows: readonly TrialRecord[]) {
  return group(rows, (record) => `${record.harness} ${record.backend} ${record.method}`);
}

function byHarnessBackend(rows: readonly TrialRecord[]) {
  return group(rows, (record) => `${record.harness} ${record.backend}`);
}

function group(rows: readonly TrialRecord[], key: (record: TrialRecord) => string) {
  const map = new Map<string, TrialRecord[]>();
  for (const record of rows) {
    map.set(key(record), [...(map.get(key(record)) ?? []), record]);
  }
  return [...map].map(([label, records]) => ({ key: label, rows: records }));
}

function mean(values: readonly (number | undefined)[]): number | null {
  const present = values.filter((value): value is number => typeof value === "number");
  return present.length === 0 ? null : present.reduce((a, b) => a + b, 0) / present.length;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
