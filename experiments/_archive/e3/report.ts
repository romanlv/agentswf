/**
 * E3's tables. Every rep is printed; nothing is averaged away.
 *
 * Pane usage is not in the trial rows — Herdr reports none — so it is resolved here from the
 * harness's own session log via `pane-usage.ts`, and written back out as `e3-usage.jsonl` so
 * the numbers in the findings come from a file rather than from this script's stdout.
 *
 *   bun run e3/report.ts e3/results/e3 [more run dirs...]
 */
import { join } from "node:path";
import { paneTurns, type Turn } from "./pane-usage";
import { priceClaudeOpus5 } from "./price";
import type { Harness } from "../deps";

type Row = {
  runId: string;
  shape: string;
  harness: Harness;
  rep: number;
  setupMs: number;
  turnMs: number;
  teardownMs: number;
  totalMs: number;
  createMs: number | null;
  startMs: number | null;
  poolSetupMs: number | null;
  delivered: boolean;
  tagMatched: boolean | null;
  countCorrect: boolean | null;
  settled: string;
  sessionRef: string | null;
  sessionTurn: number;
  usage: Turn | null;
  usageSource: string | null;
};

const dirs = process.argv.slice(2);
if (dirs.length === 0) throw new Error("usage: bun run e3/report.ts <run dir> [...]");

const rows: (Row & { resolved: Turn | null; resolvedSource: string })[] = [];
for (const dir of dirs) {
  const text = await Bun.file(join(dir, "trials.jsonl")).text();
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const row = JSON.parse(line) as Row;
    let resolved = row.usage;
    let source = row.usageSource ?? "none";
    if (!resolved) {
      const turns = await paneTurns(row.harness, row.sessionRef);
      const turn = turns?.[row.sessionTurn];
      if (turn) {
        resolved = turn;
        source = "session-log";
      }
    }
    rows.push({ ...row, resolved, resolvedSource: source });
  }
}

const out = rows
  .map((row) =>
    JSON.stringify({
      runId: row.runId,
      shape: row.shape,
      harness: row.harness,
      rep: row.rep,
      setupMs: row.setupMs,
      turnMs: row.turnMs,
      teardownMs: row.teardownMs,
      totalMs: row.totalMs,
      poolSetupMs: row.poolSetupMs,
      delivered: row.delivered,
      usage: row.resolved,
      usageSource: row.resolvedSource,
      dollars: dollars(row.harness, row.resolved) ?? null,
    }),
  )
  .join("\n");
await Bun.write(join(dirs[0]!, "..", "e3-usage.jsonl"), `${out}\n`);

/** claude reports dollars headless and none from a pane, so a pane turn is priced from its
 * tokens with the card `price.ts` solved out of claude's own headless figure. */
function dollars(harness: Harness, usage: Turn | null): number | undefined {
  if (!usage) return undefined;
  if (typeof usage.costUsd === "number") return usage.costUsd;
  if (harness !== "claude") return undefined;
  if (usage.cacheWriteTokens === undefined) return undefined;
  return priceClaudeOpus5(usage);
}

const key = (row: Row) => `${row.runId}|${row.shape}|${row.harness}`;
const cells = new Map<string, typeof rows>();
for (const row of rows) cells.set(key(row), [...(cells.get(key(row)) ?? []), row]);

const table = (header: string[], body: string[][]) => {
  const widths = header.map((label, column) =>
    Math.max(label.length, ...body.map((line) => line[column]!.length)),
  );
  const render = (line: string[]) =>
    `| ${line.map((value, column) => value.padEnd(widths[column]!)).join(" | ")} |`;
  return [
    render(header),
    `|${widths.map((width) => "-".repeat(width + 2)).join("|")}|`,
    ...body.map(render),
  ].join("\n");
};

const list = (values: number[]) => values.map((value) => Math.round(value)).join(" / ");
const mean = (values: number[]) =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;

console.log("## Wall clock, all five reps (ms)\n");
console.log(
  table(
    ["run", "shape", "harness", "setup", "turn", "teardown", "total", "mean total", "pool setup"],
    [...cells.values()].map((group) => {
      const first = group[0]!;
      return [
        first.runId,
        first.shape,
        first.harness,
        list(group.map((row) => row.setupMs)),
        list(group.map((row) => row.turnMs)),
        list(group.map((row) => row.teardownMs)),
        list(group.map((row) => row.totalMs)),
        String(Math.round(mean(group.map((row) => row.totalMs)))),
        first.poolSetupMs === null ? "—" : String(first.poolSetupMs),
      ];
    }),
  ),
);

console.log("\n## Tokens and dollars per call\n");
console.log(
  table(
    [
      "run",
      "shape",
      "harness",
      "src",
      "n priced",
      "uncached in",
      "cache write",
      "cache read",
      "cached total",
      "out",
      "$ each",
      "$ mean",
    ],
    [...cells.values()].map((group) => {
      const first = group[0]!;
      const priced = group.filter((row) => row.resolved);
      const usages = priced.map((row) => row.resolved!);
      const priced$ = priced
        .map((row) => dollars(row.harness, row.resolved))
        .filter((value): value is number => typeof value === "number");
      const split = (pick: (usage: Turn) => number | undefined) =>
        usages.length === 0
          ? "—"
          : usages.every((usage) => pick(usage) === undefined)
            ? "not split"
            : list(usages.map((usage) => pick(usage) ?? 0));
      return [
        first.runId,
        first.shape,
        first.harness,
        priced[0]?.resolvedSource ?? "none",
        `${priced.length}/${group.length}`,
        usages.length === 0 ? "—" : list(usages.map((usage) => usage.inputTokens ?? 0)),
        split((usage) => usage.cacheWriteTokens),
        split((usage) => usage.cacheReadTokens),
        usages.length === 0 ? "—" : list(usages.map((usage) => usage.cachedInputTokens ?? 0)),
        usages.length === 0 ? "—" : list(usages.map((usage) => usage.outputTokens ?? 0)),
        priced$.length === 0 ? "—" : priced$.map((value) => value.toFixed(4)).join(" / "),
        priced$.length === 0 ? "—" : `$${mean(priced$).toFixed(4)}`,
      ];
    }),
  ),
);

console.log("\n## Delivery and correctness\n");
console.log(
  table(
    ["run", "shape", "harness", "delivered", "tag matched", "count right", "settled"],
    [...cells.values()].map((group) => {
      const first = group[0]!;
      const count = (predicate: (row: (typeof group)[number]) => boolean) =>
        group.filter(predicate).length;
      return [
        first.runId,
        first.shape,
        first.harness,
        `${count((row) => row.delivered)}/${group.length}`,
        `${count((row) => row.tagMatched === true)}/${group.length}`,
        `${count((row) => row.countCorrect === true)}/${group.length}`,
        [...new Set(group.map((row) => row.settled))].join(","),
      ];
    }),
  ),
);

console.log("\n## Fourteen-way fan-out, sequential (from mean total per call)\n");
console.log(
  table(
    ["run", "shape", "harness", "14 calls, seconds", "14 calls, dollars"],
    [...cells.values()].map((group) => {
      const first = group[0]!;
      const seconds = (mean(group.map((row) => row.totalMs)) * 14) / 1_000;
      const poolOnce = first.poolSetupMs ?? 0;
      const priced$ = group
        .map((row) => dollars(row.harness, row.resolved))
        .filter((value): value is number => typeof value === "number");
      return [
        first.runId,
        first.shape,
        first.harness,
        (seconds + poolOnce / 1_000).toFixed(1),
        priced$.length === 0 ? "unmeasurable" : `$${(mean(priced$) * 14).toFixed(2)}`,
      ];
    }),
  ),
);
