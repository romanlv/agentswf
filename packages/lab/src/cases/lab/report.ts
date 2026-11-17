import type { Folder, RunRecord } from "../format/records";
import { JUDGE_CHECKED } from "../judge/version";
import { familyOf } from "./families";
import { minorOf } from "./grading";
import type { CaseRow, StoredTrialView } from "./outcome";
import { newestEntries, trialOutcome } from "./outcome";
import { agreements, type Pooled, poolNumbers } from "./pooled";
import { type CaseVerdict, type ExitCode, exitCodeOf } from "./verdict";

const MARK: Record<CaseVerdict, string> = { passed: "✓", failed: "✗", flaky: "~", unclear: "?" };

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function seconds(ms: number): string {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`;
}

const usd = (n: number) => `$${n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2)}`;

export function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function describeFolder(folder: Pick<Folder, "branch" | "commit" | "dirty">): string {
  const parts = [
    folder.branch ? `branch ${folder.branch}` : "detached",
    ...(folder.commit ? [`commit ${folder.commit.slice(0, 7)}`] : []),
  ];
  return `this checkout, ${parts.join(", ")}${folder.dirty ? ", with uncommitted changes" : ""}`;
}

const EXIT_WHY: Record<ExitCode, string> = {
  0: "every case that must pass passed",
  1: "a case that must pass failed",
  3: "",
  4: "the lab broke during a trial: its result says nothing of the workflow",
  5: "a trial errored by the dataset or by grading, or leaked",
};

export type RunReport = {
  run: RunRecord;
  rows: CaseRow[];
  trials: StoredTrialView[];
  /** Criteria in the keys, not judged yet. */
  criteria: number;
  /** Grades `score` would make again: a key or grader changed since; or why it couldn't tell. */
  stale?: number | { unread: string };
  /** The judge as a person checked it; the lab's recorded one when absent. */
  judgeChecked?: typeof JUDGE_CHECKED;
  /** Earlier runs history leaves out: their records don't read. */
  leftOut?: readonly number[];
  /** Whose grades decide each case, from the current dataset and keys; all when unread. */
  decidersOf?: (caseName: string) => ReadonlySet<string> | undefined;
};

const percent = (count: number, of: number) =>
  of === 0 ? "" : ` (${Math.round((count / of) * 100)}%)`;

export function describePooled(pooled: Pooled): string {
  if ("count" in pooled) return `${pooled.count}/${pooled.of}${percent(pooled.count, pooled.of)}`;
  const m = median(pooled.values)!;
  return `median ${Number.isInteger(m) ? m : m.toFixed(2)}`;
}

/**
 * What the criteria judge did, your checkout's column: splits, criteria judged from saved files,
 * trials not judged because a cheaper grader failed them, and the marks on the judge itself.
 */
function judgeLines(
  trials: readonly StoredTrialView[],
  criteria: number,
  person: typeof JUDGE_CHECKED,
): string[] {
  const own = trials.filter((t) => t.record.column === 0);
  const judged = own.flatMap((t) => newestEntries(t.scores).filter((e) => e.grader === "criteria"));
  if (judged.length === 0) {
    return criteria > 0
      ? [
          `criteria not judged: ${criteria} ${criteria === 1 ? "criterion" : "criteria"} in the keys`,
        ]
      : [];
  }
  const lines: string[] = [];
  const parts = judged.flatMap((e) => (e.skipped || e.errored ? [] : (e.parts ?? [])));
  const split = parts.filter((p) => p.settled === "majority").length;
  const unsettled = parts.filter((p) => p.settled === "unsettled").length;
  const read = parts.filter((p) => (p.data as { readNotRun?: boolean } | undefined)?.readNotRun);
  const skipped = judged.filter((e) => e.skipped).length;
  lines.push(
    [
      `criteria judged ${parts.length}`,
      ...(split > 0 ? [`split 2–1 ${split}`] : []),
      ...(unsettled > 0 ? [`unsettled ${unsettled}`] : []),
      ...(read.length > 0 ? [`read, not run ${read.length}`] : []),
      ...(skipped > 0 ? [`not judged on ${plural(skipped, "trial")} a cheaper grader failed`] : []),
    ].join(" · "),
  );
  const agent = judged.find((e) => e.agent)?.agent;
  if (agent) {
    // Judged as the person checked it: the same agent and `{major}.{minor}`, on every grade that
    // judged (a skipped or errored one judged nothing).
    const checked =
      person !== undefined &&
      judged
        .filter((e) => !e.skipped && !e.errored)
        .every(
          (e) =>
            minorOf(e.version) === minorOf(person.version) &&
            e.agent?.harness === person.harness &&
            e.agent?.model === person.model,
        );
    const family = familyOf(agent.model, agent.harness);
    const shared = family
      ? [...new Set(own.flatMap((t) => t.record.models))].filter((m) => familyOf(m) === family)
      : [];
    lines.push(
      [
        `judge: ${agent.harness}/${agent.model}${checked ? "" : ", not checked against a person"}`,
        ...(family === undefined ? ["family unknown"] : []),
        ...(shared.length > 0
          ? [`shares the ${family} family with the workflow's ${shared.join(", ")}`]
          : []),
      ].join(" · "),
    );
  }
  return lines;
}

/** The numbers and agreement lines, your checkout's column. */
function gradersLines(
  trials: readonly StoredTrialView[],
  decidersOf: RunReport["decidersOf"],
): string[] {
  const own = trials.filter((t) => t.record.column === 0);
  const lines: string[] = [];
  const pooled = poolNumbers(own);
  if (pooled.graders.size > 0) {
    const each = [...pooled.graders].map(
      ([grader, numbers]) =>
        `${grader} ${[...numbers].map(([name, n]) => `${name} ${describePooled(n)}`).join(", ")}`,
    );
    const left =
      pooled.left > 0 ? `; ${plural(pooled.left, "trial")} the workflow failed left out` : "";
    lines.push(`numbers: ${each.join(" · ")}${left}`);
  }
  for (const pair of agreements(own, decidersOf)) {
    const said = [
      ...(pair.verdicts.of > 0
        ? [`the same verdict on ${pair.verdicts.alike} of ${plural(pair.verdicts.of, "trial")}`]
        : []),
      ...(pair.parts.of > 0
        ? [`the same label on ${pair.parts.alike} of ${plural(pair.parts.of, "part")}`]
        : []),
    ];
    lines.push(`agreement, ${pair.a} and ${pair.b}: ${said.join("; ")}`);
  }
  return lines;
}

/** `run` and `report`'s text, and the exit code from your checkout's column. */
export function renderRun({
  run,
  rows,
  trials,
  criteria,
  stale,
  decidersOf,
  leftOut,
  judgeChecked = JUDGE_CHECKED,
}: RunReport): {
  text: string;
  exit: ExitCode;
} {
  const partial = run.finished === undefined;
  const exit = exitCodeOf({ cases: rows, partial });
  const counts = new Set(run.asked.map((a) => a.trials));
  const each =
    counts.size === 1 ? `${plural([...counts][0]!, "trial")} each` : "trials per case as asked";
  const lines = [
    `${run.dataset} · ${plural(run.asked.length, "case")} · ${each} · run ${run.number}${partial ? " (partial)" : ""}`,
    `code: ${describeFolder(run.folders[0]!)}`,
    "",
  ];
  const line = (row: CaseRow, extra = "") => {
    const history =
      row.history.length > 0 ? `   history ${row.history.map((v) => MARK[v]).join("")}` : "";
    const said = [
      ...row.notes,
      ...(row.why ? [row.why] : []),
      ...(row.tally.note ? [row.tally.note] : []),
    ];
    return `  ${row.name.padEnd(20)} ${`${row.tally.passed}/${row.tally.trials}`.padEnd(5)} ${extra}${said.join("; ")}${history}`;
  };
  const section = (title: string, list: CaseRow[], extra?: (row: CaseRow) => string) => {
    if (list.length === 0) return;
    lines.push(title, ...list.map((row) => line(row, extra?.(row))));
  };
  const must = rows.filter((r) => !r.knownFailing);
  const known = rows.filter((r) => r.knownFailing);
  const nowPassing = known.filter((r) => r.tally.verdict === "passed");
  section(
    "failed, must pass",
    must.filter((r) => r.tally.verdict === "failed"),
  );
  section(
    "flaky",
    must.filter((r) => r.tally.verdict === "flaky"),
  );
  section(
    "unclear",
    must.filter((r) => r.tally.verdict === "unclear"),
  );
  section(
    "known failing",
    known.filter((r) => r.tally.verdict !== "passed"),
  );
  section("known failing, now passing", nowPassing, (row) =>
    row.tally.trials >= 3
      ? "remove known-failing from its key? "
      : "confirm with --trials 3 before removing known-failing; ",
  );
  section(
    "passed, with notes",
    must.filter((r) => r.tally.verdict === "passed" && r.notes.length > 0),
  );
  section(
    "no verdict",
    rows.filter((r) => r.tally.none),
    (row) => `${row.tally.none}: `,
  );
  if (lines.at(-1) !== "") lines.push("");

  const verdicts = (v: CaseVerdict) => must.filter((r) => r.tally.verdict === v).length;
  lines.push(
    [
      `passed ${verdicts("passed")}`,
      `failed ${verdicts("failed")}`,
      `flaky ${verdicts("flaky")}`,
      `unclear ${verdicts("unclear")}`,
      `known failing ${known.length}${nowPassing.length > 0 ? ` (${nowPassing.length} now passing)` : ""}`,
      ...(rows.some((r) => r.tally.none)
        ? [`no verdict ${rows.filter((r) => r.tally.none).length}`]
        : []),
    ].join(" · "),
  );
  const views = trials.map((t) => ({
    ...t,
    view: trialOutcome(t.record, t.scores, decidersOf?.(t.record.case)),
  }));
  const errored = views.filter((t) => t.view.outcome === "errored");
  const by = (who: string) => errored.filter((t) => t.view.errored?.by === who).length;
  const blame = ["dataset", "grading", "provider", "lab"]
    .filter((who) => by(who) > 0)
    .map((who) => `${by(who)} by ${who}`);
  lines.push(
    [
      `trials ${trials.length}`,
      `errored ${errored.length}${blame.length > 0 ? ` (${blame.join(", ")})` : ""}`,
      `undecided ${views.filter((t) => t.view.outcome === "undecided").length}`,
      `leaked ${views.filter((t) => t.view.outcome === "leaked").length}`,
    ].join(" · "),
  );
  const counted = views.filter((t) => t.view.outcome !== "errored" && t.record.runId);
  const ms = median(counted.map((t) => t.record.ms));
  const priced = counted.filter((t) => t.record.estimate !== undefined);
  const cost = median(priced.map((t) => t.record.estimate!));
  const total = trials.reduce((sum, t) => sum + (t.record.estimate ?? 0), 0);
  const grading = trials.reduce(
    (sum, t) =>
      sum +
      t.scores.reduce(
        (s, score) => s + score.entries.reduce((e, x) => e + (x.estimate ?? 0), 0),
        0,
      ),
    0,
  );
  const unpriced = counted.some(
    (t) => t.record.estimate === undefined || (t.record.priced ?? 0) < (t.record.agents ?? 0),
  );
  if (ms !== undefined) {
    lines.push(
      [
        `time per trial, median ${seconds(ms)}`,
        ...(cost !== undefined ? [`est. cost per trial, median ${usd(cost)}`] : []),
        `all trials ${usd(total)}${unpriced ? ", partly unpriced" : ""}`,
        ...(grading > 0 ? [`grading ${usd(grading)}`] : []),
      ].join(" · "),
    );
  }
  lines.push(...gradersLines(trials, decidersOf));
  if (typeof stale === "number" && stale > 0) {
    lines.push(
      `${plural(stale, "grade")} out of date, a key or grader changed: awf-lab score ${run.number}`,
    );
  } else if (typeof stale === "object") {
    lines.push(`grades: couldn't check whether any is out of date: ${stale.unread}`);
  }
  lines.push(...judgeLines(trials, criteria, judgeChecked));
  if (leftOut && leftOut.length > 0) {
    lines.push(
      `history leaves out ${plural(leftOut.length, "earlier run")} whose records don't read: awf-lab runs`,
    );
  }
  lines.push("sandbox: the workflow's own, its agents' reach checked against agentReach", "");
  const why =
    exit === 3
      ? partial
        ? "the run is partial"
        : !rows.some((r) => r.tally.verdict || r.tally.none === "graded by numbers")
          ? "no case was graded"
          : "a case is flaky or unclear"
      : EXIT_WHY[exit];
  lines.push(`exit ${exit}: ${why}`);
  return { text: lines.join("\n"), exit };
}

/** One case in full: each trial's result, facts, refusals and grades, and how to open its logs. */
export function renderCase(
  run: RunRecord,
  row: CaseRow,
  trials: readonly StoredTrialView[],
  logsCommand: (runId: string) => string,
  deciders?: ReadonlySet<string>,
): string {
  const lines = [
    `${row.name} · run ${run.number} · ${row.tally.verdict ?? row.tally.none ?? "no trials"} ${row.tally.passed}/${row.tally.trials}`,
  ];
  for (const trial of trials) {
    const { record } = trial;
    const view = trialOutcome(record, trial.scores, deciders);
    lines.push(
      "",
      `trial ${record.trial}: ${view.outcome}${record.runId ? ` · run ${record.runId}` : ""} · ${seconds(record.ms)}`,
    );
    if (record.errored) {
      lines.push(
        `  errored by ${record.errored.by} in ${record.errored.phase}${record.errored.code ? ` (${record.errored.code})` : ""}: ${record.errored.reason}`,
      );
    }
    if (record.workflowError) lines.push(`  the workflow erred: ${record.workflowError}`);
    if (record.stopped) lines.push(`  stopped: ${record.stopped}`);
    if (record.leaked) lines.push("  leaked: the key turned up where the workflow ran");
    for (const refused of record.refused) {
      lines.push(`  refused in ${refused.phase}: ${refused.message}`);
    }
    for (const unused of record.unused) lines.push(`  ${unused} was faked but never called`);
    for (const stage of record.neverReached ?? []) lines.push(`  never reached ${stage}`);
    if (record.reach && !record.reach.ok) {
      for (const problem of record.reach.problems) lines.push(`  reach: ${problem}`);
    }
    if (record.facts) lines.push(`  facts: ${JSON.stringify(record.facts)}`);
    if (record.result !== undefined) lines.push(`  result: ${JSON.stringify(record.result)}`);
    for (const entry of newestEntries(trial.scores)) {
      const verdict = entry.errored
        ? `errored: ${entry.errored.reason}`
        : entry.skipped
          ? "not judged: a cheaper grader failed the trial"
          : (entry.verdict ??
            (entry.notApplies ? `does not apply: ${entry.notApplies}` : "numbers only"));
      const about = [
        ...(entry.version ? [entry.version] : []),
        ...(deciders && !deciders.has(entry.grader) ? ["not in the verdict"] : []),
        ...(entry.estimate !== undefined ? [`est. ${usd(entry.estimate)}`] : []),
        ...(entry.runId ? [`run ${entry.runId}`] : []),
      ];
      lines.push(
        `  ${entry.grader}: ${verdict}${about.length > 0 ? ` (${about.join(", ")})` : ""}`,
      );
      for (const [name, number] of Object.entries(entry.numbers ?? {})) {
        lines.push(
          `    ${name}: ${"count" in number ? `${number.count}/${number.of}` : number.value}`,
        );
      }
      for (const reason of entry.reasons) lines.push(`    ${reason.about}: ${reason.text}`);
      for (const part of entry.parts ?? []) {
        const settled = part.settled && part.settled !== "agreed" ? ` [${part.settled}]` : "";
        const read = (part.data as { readNotRun?: boolean } | undefined)?.readNotRun
          ? " (read, not run)"
          : "";
        lines.push(
          `    ${part.about}: ${part.verdict ?? part.label}${settled}${read}${part.why ? ` · ${part.why}` : ""}`,
        );
        // A split is worth reading vote by vote; an agreement is its why.
        if (part.settled && part.settled !== "agreed" && part.settled !== "given") {
          for (const vote of part.votes ?? []) {
            const said = vote.verdict ?? vote.label ?? "no answer";
            lines.push(
              `      ${vote.by}${vote.role ? ` (${vote.role})` : ""}: ${said}${vote.why ? ` · ${vote.why}` : ""}`,
            );
          }
        }
      }
    }
    if (record.kept.length > 0) lines.push(`  kept: ${record.kept.join(", ")}`);
    if (record.runId) lines.push(`  logs: ${logsCommand(record.runId)}`);
  }
  return lines.join("\n");
}
