/**
 * Summarises the forced-nudge probe: does one line recover a settled agent, and what does the
 * second turn cost next to the first — which is the price of the re-run it replaces.
 *
 *   bun run e2/nudge-report.ts e2/results/nudge-cost.jsonl
 */
import type { TurnUsage } from "../deps";

type Row = {
  harness: string;
  backend: string;
  recovered?: boolean;
  firstMs?: number;
  nudgeMs?: number;
  firstUsage?: TurnUsage | null;
  nudgeUsage?: TurnUsage | null;
};

const path = process.argv[2] ?? `${import.meta.dir}/results/nudge-cost.jsonl`;
const rows = (await Bun.file(path).text())
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line) as Row);

const cells = new Map<string, Row[]>();
for (const row of rows) {
  const key = `${row.harness} ${row.backend}`;
  cells.set(key, [...(cells.get(key) ?? []), row]);
}

console.log(
  ["cell".padEnd(18), "recovered", "first ms", "nudge ms", "first $", "nudge $", "ratio"].join("  "),
);
for (const [key, group] of cells) {
  const recovered = group.filter((row) => row.recovered).length;
  const firstCost = mean(group.map((row) => row.firstUsage?.costUsd));
  const nudgeCost = mean(group.map((row) => row.nudgeUsage?.costUsd));
  console.log(
    [
      key.padEnd(18),
      `${recovered}/${group.length}`.padStart(9),
      num(mean(group.map((row) => row.firstMs))).padStart(8),
      num(mean(group.map((row) => row.nudgeMs))).padStart(8),
      money(firstCost).padStart(7),
      money(nudgeCost).padStart(7),
      (firstCost && nudgeCost ? `${((nudgeCost / firstCost) * 100).toFixed(0)}%` : "-").padStart(5),
    ].join("  "),
  );
}

function mean(values: readonly (number | undefined)[]): number | null {
  const present = values.filter((value): value is number => typeof value === "number");
  return present.length === 0 ? null : present.reduce((a, b) => a + b, 0) / present.length;
}

function num(value: number | null): string {
  return value === null ? "-" : String(Math.round(value));
}

function money(value: number | null): string {
  return value === null ? "-" : `$${value.toFixed(4)}`;
}
