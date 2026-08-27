import { appendTrial } from "./deps";
import { runTrial, type Task, type TrialDeps, type TrialRecord, type TrialSpec } from "./trial";
import type { AgentSessionBackend, BackendKind, Harness, ReturnMethod } from "./deps";

export type MatrixSpec = {
  harnesses: readonly Harness[];
  backends: readonly BackendKind[];
  methods: readonly ReturnMethod[];
  trials: number;
};

export type MatrixBase = {
  runId: string;
  runDir: string;
  task: Task;
  model?: string;
  cwd?: string;
};

export function expandMatrix(spec: MatrixSpec, base: MatrixBase): TrialSpec[] {
  const specs: TrialSpec[] = [];
  for (const harness of spec.harnesses) {
    for (const backend of spec.backends) {
      for (const method of spec.methods) {
        for (let index = 1; index <= spec.trials; index += 1) {
          specs.push({
            runId: base.runId,
            runDir: base.runDir,
            callId: `${harness}-${backend}-${method}-${index}`,
            harness,
            backend,
            method,
            index,
            task: base.task,
            ...(base.model ? { model: base.model } : {}),
            ...(base.cwd ? { cwd: base.cwd } : {}),
          });
        }
      }
    }
  }
  return specs;
}

export type RunnerDeps = TrialDeps & {
  onRecord?: (record: TrialRecord) => void | Promise<void>;
};

/**
 * Sequential: E2 shares one laptop and one Herdr server with the other experiments, and a
 * concurrency effect on the return rate would be indistinguishable from the thing being
 * measured. Every trial is written out as it finishes, so a killed run keeps its samples.
 */
export async function runMatrix(
  specs: readonly TrialSpec[],
  backends: Partial<Record<BackendKind, AgentSessionBackend>>,
  deps: RunnerDeps = {},
): Promise<TrialRecord[]> {
  const missing = [...new Set(specs.map((spec) => spec.backend))].filter(
    (kind) => !backends[kind],
  );
  if (missing.length > 0) {
    throw new Error(`no backend supplied for ${missing.join(", ")}`);
  }

  const records: TrialRecord[] = [];
  for (const spec of specs) {
    const record = await runTrial(spec, backends[spec.backend]!, deps);
    records.push(record);
    await appendTrial(spec.runDir, record);
    await deps.onRecord?.(record);
  }
  return records;
}

export type Cell = {
  harness: Harness;
  backend: BackendKind;
  method: ReturnMethod;
  trials: number;
  unprompted: number;
  nudged: number;
  lost: number;
  /** Tried on the first turn and was refused by the result layer, and stayed refused. */
  malformedFirst: number;
  /** Refused and then fixed inside the same turn: delivery, but not clean delivery. E5's subject. */
  correctedFirst: number;
/**
   * The nudge turn did not settle. `headless.ts` reports `unknown` for a timeout, a nonzero
   * exit and a missing resume alike, so this counts all three; `settledAfterNudgeDetail` on
   * the record says which.
   */
  nudgeUnsettled: number;
  /** Backend failures, which say nothing about whether the agent would have reported. */
  errors: number;
  /** Unprompted plus nudged, over trials: the number the 95% gate is read against. */
  deliveryRate: number;
  unpromptedRate: number;
  medianWallClockMs: number;
};

export function tally(records: readonly TrialRecord[]): Cell[] {
  const cells = new Map<string, TrialRecord[]>();
  for (const record of records) {
    const key = `${record.harness}|${record.backend}|${record.method}`;
    cells.set(key, [...(cells.get(key) ?? []), record]);
  }

  return [...cells.values()].map((group) => {
    const first = group[0]!;
    const count = (predicate: (record: TrialRecord) => boolean) =>
      group.filter(predicate).length;
    const delivered = count((record) => record.outcome !== "lost");
    return {
      harness: first.harness,
      backend: first.backend,
      method: first.method,
      trials: group.length,
      unprompted: count((record) => record.outcome === "unprompted"),
      nudged: count((record) => record.outcome === "nudged"),
      lost: count((record) => record.outcome === "lost"),
      malformedFirst: count((record) => record.firstAttempt === "malformed"),
      correctedFirst: count((record) => record.firstAttempt === "corrected"),
      nudgeUnsettled: count((record) => record.nudged && record.settledAfterNudge === "unknown"),
      errors: count((record) => record.error !== null),
      deliveryRate: delivered / group.length,
      unpromptedRate: count((record) => record.outcome === "unprompted") / group.length,
      medianWallClockMs: median(group.map((record) => record.wallClockMs)),
    };
  });
}

export function formatTally(cells: readonly Cell[]): string {
  const header = [
    "harness",
    "backend",
    "method",
    "n",
    "unprompted",
    "nudged",
    "lost",
    "fixed-1st",
    "bad-1st",
    "nudge-unsettled",
    "err",
    "delivered",
    "median ms",
  ];
  const rows = cells.map((cell) => [
    cell.harness,
    cell.backend,
    cell.method,
    String(cell.trials),
    String(cell.unprompted),
    String(cell.nudged),
    String(cell.lost),
    String(cell.correctedFirst),
    String(cell.malformedFirst),
    String(cell.nudgeUnsettled),
    String(cell.errors),
    `${Math.round(cell.deliveryRate * 100)}%`,
    String(Math.round(cell.medianWallClockMs)),
  ]);
  const widths = header.map((label, column) =>
    Math.max(label.length, ...rows.map((row) => row[column]!.length)),
  );
  const line = (row: string[]) =>
    row.map((value, column) => value.padEnd(widths[column]!)).join("  ").trimEnd();
  return [line(header), ...rows.map(line)].join("\n");
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
