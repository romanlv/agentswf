import type { Folder, LabelRecord, RunRecord } from "../format/records";
import { columnLabel, sharedParams } from "./columns";
import type { ColumnVerdict } from "./compare";
import { familyOf } from "./families";
import { type Agreement, JUDGE_CHECK, type PersonAgreement } from "./labels";
import type { CaseRow, StoredTrialView } from "./outcome";
import { entryName, newestEntries, trialOutcome, votersOf } from "./outcome";
import { agreements, type Pooled, poolNumbers } from "./pooled";
import { describeDifference, describeRates, pairedDifference, ratesOf } from "./rates";
import { type CaseVerdict, type ExitCode, exitCodeOf } from "./verdict";

const MARK: Record<CaseVerdict, string> = { passed: "✓", failed: "✗", flaky: "~", unclear: "?" };

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function seconds(ms: number): string {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`;
}

export const usd = (n: number) => `$${n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2)}`;

export function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** A folder of code: `this checkout`, or its path, with its branch, commit and changes. */
export function describeFolder(
  folder: Pick<Folder, "branch" | "commit" | "dirty"> & { path?: string | undefined },
): string {
  const parts = [
    folder.branch ? `branch ${folder.branch}` : "detached",
    ...(folder.commit ? [`commit ${folder.commit.slice(0, 7)}`] : []),
  ];
  return `${folder.path ?? "this checkout"}, ${parts.join(", ")}${folder.dirty ? ", with uncommitted changes" : ""}`;
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
  /** The rows of each column but the reference, in the run's `columns` order. */
  others?: readonly CaseRow[][];
  /** The person's labels on this run's trials, and how the lab agrees with them. */
  person?: PersonAgreement;
  /** `compare`'s verdict on each column but the reference, in `columns` order. */
  verdicts?: readonly ColumnVerdict[];
  /** Each case's tags, from its key as it is now. */
  tagsOf?: (caseName: string) => readonly string[];
  /** The labeled trials the current judge graded, across the dataset's runs. */
  judgeLabeled?: { labeled: number; needsWork: number };
  /** Earlier runs history leaves out: their records don't read. */
  leftOut?: readonly string[];
  /** Whose grades decide each case, from the current dataset and keys; all when unread. */
  decidersOf?: (caseName: string) => ReadonlySet<string> | undefined;
  /** Why no grader grades a case, from its key as it is now. */
  ungradedOf?: (caseName: string) => string | undefined;
  /** The run's own plan was printed just before: its header says the run's id alone. */
  followsPlan?: boolean;
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
  labeled: { labeled: number; needsWork: number } | undefined,
): string[] {
  const own = trials.filter((t) => t.record.column === 0);
  const judged = own.flatMap((t) =>
    newestEntries(t.scores).filter((e) => e.grader === "criteria" && !e.beside),
  );
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
    // Checked once the person labeled enough trials this judge graded, some of them needing
    // work: a judge that passes everything can't clear it on good ones alone.
    const have = labeled ?? { labeled: 0, needsWork: 0 };
    const checked = have.labeled >= JUDGE_CHECK.labeled && have.needsWork >= JUDGE_CHECK.needsWork;
    const short = checked
      ? ""
      : `, not checked against a person (labeled ${have.labeled} of ${JUDGE_CHECK.labeled}, needs-work ${have.needsWork} of ${JUDGE_CHECK.needsWork}: awf-lab label)`;
    const family = familyOf(agent.model, agent.harness);
    const shared = family
      ? [...new Set(own.flatMap((t) => t.record.models))].filter((m) => familyOf(m) === family)
      : [];
    lines.push(
      [
        `judge: ${agent.harness}/${agent.model} ×${votersOf(agent)}${short}`,
        ...(family === undefined ? ["family unknown"] : []),
        ...(shared.length > 0
          ? [`shares the ${family} family with the workflow's ${shared.join(", ")}`]
          : []),
      ].join(" · "),
    );
  }
  lines.push(...besideLines(own));
  return lines;
}

/**
 * Each judge graded beside the deciding one by `score --judge`: on how many trials, at what
 * grading cost, and on how many its verdict differs from the deciding judge's. Which is right is
 * for the person's labels to say.
 */
function besideLines(trials: readonly StoredTrialView[]): string[] {
  const judges = new Map<string, { trials: number; cost: number; differ: number }>();
  for (const t of trials) {
    const newest = newestEntries(t.scores);
    const deciding = newest.find((e) => e.grader === "criteria" && !e.beside);
    for (const e of newest.filter((e) => e.beside && !e.errored && !e.skipped)) {
      const into = judges.get(entryName(e)) ?? { trials: 0, cost: 0, differ: 0 };
      judges.set(entryName(e), into);
      into.trials++;
      into.cost += e.estimate ?? 0;
      if (deciding?.verdict && e.verdict && deciding.verdict !== e.verdict) into.differ++;
    }
  }
  return [...judges].map(
    ([name, j]) =>
      `beside: ${name} on ${plural(j.trials, "trial")} · grading ${usd(j.cost)} · differs from the deciding judge on ${j.differ}`,
  );
}

/** Each stage's median time over these trials, in the order the stages first ran; or none. */
export function stageLine(trials: readonly StoredTrialView[]): string | undefined {
  const order: string[] = [];
  const times = new Map<string, number[]>();
  // A trial that errored, stopped or failed in the workflow's body was cut short: left out.
  for (const t of trials.filter(
    (t) => !t.record.errored && !t.record.workflowError && t.record.stopped === undefined,
  )) {
    for (const [stage, ms] of Object.entries(t.record.stageMs ?? {})) {
      if (!times.has(stage)) {
        order.push(stage);
        times.set(stage, []);
      }
      times.get(stage)!.push(ms);
    }
  }
  if (order.length === 0) return undefined;
  return order.map((stage) => `${stage} ${seconds(median(times.get(stage)!)!)}`).join(" · ");
}

/** Pooled numbers in a line: each grader's, by name. */
function pooledText(pooled: ReturnType<typeof poolNumbers>): string {
  const each = [...pooled.graders].map(
    ([grader, numbers]) =>
      `${grader} ${[...numbers].map(([name, n]) => `${name} ${describePooled(n)}`).join(", ")}`,
  );
  const left =
    pooled.left > 0 ? `; ${plural(pooled.left, "trial")} the workflow failed left out` : "";
  return `${each.join(" · ")}${left}`;
}

/** Of these trials, how many are another column's, said after a count. */
function elsewhere(run: RunRecord, trials: readonly StoredTrialView[]): string {
  const counts = new Map<number, number>();
  for (const t of trials) {
    if (t.record.column > 0) counts.set(t.record.column, (counts.get(t.record.column) ?? 0) + 1);
  }
  return [...counts].map(([column, n]) => `, ${n} in ${columnLabel(run, column)}`).join("");
}

const agreed = (a: Agreement) =>
  [
    ...(a.good.labeled > 0 ? [`good ${a.good.labeled}, passed ${a.good.agreed}`] : []),
    ...(a.needsWork.labeled > 0
      ? [`needs-work ${a.needsWork.labeled}, failed ${a.needsWork.agreed}`]
      : []),
  ].join(" · ");

/**
 * The person's labels against the lab's verdicts: good and needs-work apart, since a lab that
 * passes everything agrees with a mostly good set; each deciding grader's; each disagreement.
 */
function personLines(run: RunRecord, person: PersonAgreement): string[] {
  const labeled = person.good.labeled + person.needsWork.labeled + person.notCompared;
  const lines = [
    `labels: ${plural(labeled, "trial")} · ${agreed(person) || "none compared"}${person.notCompared > 0 ? ` · ${person.notCompared} neither passed nor failed` : ""}`,
  ];
  const judges = person.graders.filter((g) => g.cost > 0).length;
  for (const grader of person.graders) {
    const cost = grader.cost > 0 ? ` · grading ${usd(grader.cost)}` : "";
    const deciding = judges > 1 && grader.deciding && grader.cost > 0 ? ", deciding" : "";
    lines.push(`  ${grader.grader}${deciding}: ${agreed(grader)}${cost}`);
  }
  for (const d of person.disagreements) {
    const where = d.column > 0 ? ` (${columnLabel(run, d.column)})` : "";
    lines.push(
      `  disagrees: ${d.case} trial ${d.trial}${where} labeled ${d.mark}${d.note ? `: ${d.note}` : ""}; the lab: ${d.outcome}`,
    );
  }
  return lines;
}

/** Each case's tags, and how each column did on them: passed of cases, and which failed. */
export function tagRows(
  rows: readonly CaseRow[],
  tagsOf: (name: string) => readonly string[],
): { tag: string; cases: number; passed: number; failing: string[] }[] {
  const tags = [...new Set(rows.flatMap((r) => tagsOf(r.name)))].sort();
  return tags.map((tag) => {
    const tagged = rows.filter((r) => tagsOf(r.name).includes(tag) && r.tally.verdict);
    return {
      tag,
      cases: tagged.length,
      passed: tagged.filter((r) => r.tally.verdict === "passed").length,
      failing: tagged.filter((r) => failing(r.tally.verdict)).map((r) => r.name),
    };
  });
}

function tagLines(
  run: RunRecord,
  rows: readonly CaseRow[],
  others: readonly CaseRow[][],
  tagsOf: (name: string) => readonly string[],
): string[] {
  const mine = tagRows(rows, tagsOf);
  if (mine.length === 0) return [];
  const theirs = others.map((column) => tagRows(column, tagsOf));
  return [
    "by tag:",
    ...mine.map((t, i) => {
      const elsewhere = theirs.map(
        (column, c) => ` · ${columnLabel(run, c + 1)} ${column[i]!.passed}/${column[i]!.cases}`,
      );
      return `  ${t.tag.padEnd(16)} ${t.passed}/${t.cases} passed${elsewhere.join("")}${t.failing.length > 0 ? ` · failing: ${t.failing.join(", ")}` : ""}`;
    }),
  ];
}

/** The numbers and agreement lines, your checkout's column. */
function gradersLines(
  trials: readonly StoredTrialView[],
  decidersOf: RunReport["decidersOf"],
): string[] {
  const own = trials.filter((t) => t.record.column === 0);
  const lines: string[] = [];
  const pooled = poolNumbers(own);
  if (pooled.graders.size > 0) lines.push(`numbers: ${pooledText(pooled)}`);
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

const failing = (v: CaseVerdict | undefined) => v === "failed" || v === "flaky" || v === "unclear";

/**
 * With more than one column: each column's folder and verdicts, the cases that came out
 * differently (verdicts differ, or passes by 2 or more), largest difference first, and how many
 * cases had more passes on each side. No column is called better: that is `compare`'s (task 9).
 */
function columnLines(
  run: RunRecord,
  rows: readonly CaseRow[],
  others: readonly CaseRow[][],
  trials: readonly StoredTrialView[],
  verdicts: readonly ColumnVerdict[] | undefined,
): string[] {
  const reference = columnLabel(run, 0);
  const width = Math.max(14, ...run.columns.map((_, i) => columnLabel(run, i).length + 2));
  const lines = [
    `${"columns".padEnd(width + 2)}passed  failed  flaky  unclear  time, median  est. cost, median`,
  ];
  const row = (label: string, list: readonly CaseRow[], column: number) => {
    const n = (v: CaseVerdict) => String(list.filter((r) => r.tally.verdict === v).length);
    const ran = trials.filter((t) => t.record.column === column && t.record.runId);
    const ms = median(ran.map((t) => t.record.ms));
    const cost = median(
      ran.flatMap((t) => (t.record.estimate !== undefined ? [t.record.estimate] : [])),
    );
    lines.push(
      `  ${label.padEnd(width)}${n("passed").padEnd(8)}${n("failed").padEnd(8)}${n("flaky").padEnd(7)}${n("unclear").padEnd(9)}${(ms !== undefined ? seconds(ms) : "-").padEnd(14)}${cost !== undefined ? usd(cost) : "-"}`,
    );
  };
  row(reference, rows, 0);
  for (const [i, column] of others.entries()) row(columnLabel(run, i + 1), column, i + 1);
  // A dataset graded by numbers compares by them: each other column's, as yours are below.
  for (const i of others.keys()) {
    const pooled = poolNumbers(trials.filter((t) => t.record.column === i + 1));
    if (pooled.graders.size > 0) {
      lines.push(`  numbers, ${columnLabel(run, i + 1)}: ${pooledText(pooled)}`);
    }
  }
  others.forEach((column, i) => {
    const label = columnLabel(run, i + 1);
    const pairs = rows.flatMap((mine) => {
      const theirs = column.find((r) => r.name === mine.name);
      return theirs ? [{ mine, theirs, gap: theirs.tally.passed - mine.tally.passed }] : [];
    });
    const differ = pairs
      .filter((p) => p.mine.tally.verdict !== p.theirs.tally.verdict || Math.abs(p.gap) >= 2)
      .sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));
    const show = (row: CaseRow) =>
      `${row.tally.passed}/${row.tally.trials} ${row.tally.verdict ?? row.tally.none ?? ""}`.trim();
    if (differ.length > 0) {
      lines.push(`came out differently in ${label}, largest difference first`);
      for (const { mine, theirs } of differ) {
        lines.push(
          `  ${mine.name.padEnd(20)} ${reference} ${show(mine)} · ${label} ${show(theirs)}`,
        );
      }
    } else lines.push(`no case came out differently in ${label}`);
    const more = pairs.filter((p) => p.gap > 0).length;
    const fewer = pairs.filter((p) => p.gap < 0).length;
    lines.push(
      `more passes: ${label} on ${plural(more, "case")}, ${reference} on ${plural(fewer, "case")}`,
    );
    const difference = pairedDifference(rows, column);
    if (difference) lines.push(`difference from ${reference}: ${describeDifference(difference)}`);
    const said = verdicts?.[i];
    if (said && "error" in said) lines.push(`compare, ${label}: could not tell: ${said.error}`);
    else if (said) {
      const { verdict } = said;
      lines.push(
        `compare ${said.version}, ${label}: ${verdict.verdict}${verdict.stop ? "" : ", more trials may tell"} · ${verdict.reason}`,
      );
    }
  });
  lines.push(`rates, ${reference}: ${describeRates(ratesOf(rows))}`);
  for (const [i, column] of others.entries()) {
    lines.push(`rates, ${columnLabel(run, i + 1)}: ${describeRates(ratesOf(column))}`);
  }
  if (run.asked.every((a) => a.trials === 1)) {
    lines.push("One trial each: these are examples, not rates.");
  } else if (!verdicts) {
    lines.push("No compare in graders.ts says which is better. Read the cases.");
  }
  return lines;
}

const cell = (row: CaseRow | undefined) =>
  row
    ? `${row.tally.verdict ?? row.tally.none ?? "-"} ${row.tally.passed}/${row.tally.trials}`
    : "-";

/**
 * `report --md`: the run as Markdown to paste into a pull request or an issue: a table of cases
 * by column, each column's rates and its difference and verdict against the reference.
 */
export function markdownOf(report: RunReport): string {
  const { run, rows, others = [], verdicts } = report;
  const { exit } = renderRun(report);
  const labels = run.columns.map((_, i) => columnLabel(run, i));
  const lines = [
    `### ${run.dataset} · run ${run.id}`,
    "",
    `${plural(run.asked.length, "case")} · ${plural(report.trials.length, "trial")}${run.columns.length > 1 ? ` in ${run.columns.length} columns` : ""} · exit ${exit}${EXIT_WHY[exit] ? `: ${EXIT_WHY[exit]}` : ""}`,
    "",
    `| case | ${labels.join(" | ")} |`,
    `| --- | ${labels.map(() => "---").join(" | ")} |`,
    ...rows.map(
      (row) =>
        `| ${row.name} | ${[cell(row), ...others.map((o) => cell(o.find((r) => r.name === row.name)))].join(" | ")} |`,
    ),
    "",
    `- **${labels[0]}**: ${describeRates(ratesOf(rows))}`,
  ];
  for (const [i, column] of others.entries()) {
    const difference = pairedDifference(rows, column);
    const said = verdicts?.[i];
    lines.push(
      `- **${labels[i + 1]}**: ${describeRates(ratesOf(column))}${difference ? `; ${describeDifference(difference)}` : ""}${said && !("error" in said) ? `; compare: ${said.verdict.verdict}, ${said.verdict.reason}` : ""}`,
    );
  }
  return lines.join("\n");
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
  others = [],
  person,
  judgeLabeled,
  tagsOf = () => [],
  ungradedOf = () => undefined,
  followsPlan = false,
  verdicts: compared,
}: RunReport): {
  text: string;
  exit: ExitCode;
} {
  const partial = run.finished === undefined || run.broke !== undefined;
  const exit = exitCodeOf({ cases: rows, partial });
  const counts = new Set(run.asked.map((a) => a.trials));
  const each =
    counts.size === 1 ? `${plural([...counts][0]!, "trial")} each` : "trials per case as asked";
  // After its plan, which said the dataset, the code and the parameters, a run says what is new.
  const envDiffers = (folder: Folder) => folder.env !== run.folders[0]!.env;
  const lines = [
    followsPlan
      ? `run ${run.id}${partial ? " (partial)" : ""}`
      : `${run.dataset} · ${plural(run.asked.length, "case")} · ${each} · run ${run.id}${partial ? " (partial)" : ""}`,
    ...(followsPlan ? [] : [`code: ${describeFolder({ ...run.folders[0]!, path: undefined })}`]),
    ...run.folders
      .slice(1)
      .flatMap((folder, i) =>
        followsPlan && !envDiffers(folder)
          ? []
          : [
              followsPlan
                ? `against ${i + 1}: env.ts differs`
                : `against ${i + 1}: ${describeFolder(folder)}${envDiffers(folder) ? ", env.ts differs" : ""}`,
            ],
      ),
    ...(sharedParams(run).length > 0 && !followsPlan
      ? [`params: ${sharedParams(run).join(" ")}`]
      : []),
    ...(run.stopped
      ? [
          `${run.stopped === "budget" ? "stopped at --budget" : "stopped by the comparison"}: ${plural(Math.max(0, run.asked.reduce((n, a) => n + a.trials, 0) * run.columns.length - trials.length), "trial")} not run`,
        ]
      : []),
    ...(run.columns.length > run.folders.length && !followsPlan
      ? [`reference column: ${columnLabel(run, 0)}; the exit code and history are its`]
      : []),
    "",
  ];
  const line = (row: CaseRow, extra = "") => {
    const history =
      row.history.length > 0 ? `   history ${row.history.map((v) => MARK[v]).join("")}` : "";
    const alsoFails = others.flatMap((column, i) => {
      const there = column.find((r) => r.name === row.name)?.tally.verdict;
      return failing(row.tally.verdict) && failing(there)
        ? [`also fails in ${columnLabel(run, i + 1)}`]
        : [];
    });
    const note = row.tally.note;
    const said = [
      ...row.notes,
      ...(row.why ? [row.why] : []),
      ...(note ? [note] : []),
      ...alsoFails,
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
    (row) => {
      const why =
        row.tally.none === "not graded" ? (ungradedOf(row.name) ?? "no grader applies") : undefined;
      const head = `${row.tally.none}${why ? `: ${why}` : ""}`;
      const said = row.notes.length > 0 || row.why || row.tally.note;
      return said ? `${head}${why ? "; " : ": "}` : head;
    },
  );
  if (lines.at(-1) !== "") lines.push("");
  if (others.length > 0) lines.push(...columnLines(run, rows, others, trials, compared), "");

  // Each count once, and only when it is some: a zero says nothing.
  const counted = (label: string, n: number, extra = "") =>
    n > 0 ? [`${label} ${n}${extra}`] : [];
  const verdicts = (v: CaseVerdict) => must.filter((r) => r.tally.verdict === v).length;
  const tallies = [
    ...counted("passed", verdicts("passed")),
    ...counted("failed", verdicts("failed")),
    ...counted("flaky", verdicts("flaky")),
    ...counted("unclear", verdicts("unclear")),
    ...counted(
      "known failing",
      known.length,
      nowPassing.length > 0 ? ` (${nowPassing.length} now passing)` : "",
    ),
    ...counted("no verdict", rows.filter((r) => r.tally.none).length),
  ];
  if (tallies.length > 0) lines.push(tallies.join(" · "));
  if (others.length === 0 && ratesOf(rows).cases > 0) {
    lines.push(`rate: ${describeRates(ratesOf(rows))}`);
  }
  const tags = tagLines(run, rows, others, tagsOf);
  if (tags.length > 0) lines.push(...tags);
  const views = trials.map((t) => ({
    ...t,
    view: trialOutcome(t.record, t.scores, decidersOf?.(t.record.case)),
  }));
  const errored = views.filter((t) => t.view.outcome === "errored");
  const by = (who: string) => errored.filter((t) => t.view.errored?.by === who).length;
  const blame = ["dataset", "grading", "provider", "lab"]
    .filter((who) => by(who) > 0)
    .map((who) => `${by(who)} by ${who}`);
  const reusedCount = trials.filter((t) => t.record.reused).length;
  lines.push(
    [
      `trials ${trials.length}${run.columns.length > 1 ? ` in ${run.columns.length} columns` : ""}`,
      ...counted("reused", reusedCount),
      ...counted(
        "errored",
        errored.length,
        `${blame.length > 0 ? ` (${blame.join(", ")})` : ""}${elsewhere(run, errored)}`,
      ),
      ...counted("undecided", views.filter((t) => t.view.outcome === "undecided").length),
      ...counted("leaked", views.filter((t) => t.view.outcome === "leaked").length),
    ].join(" · "),
  );
  const ran = views.filter((t) => t.view.outcome !== "errored" && t.record.runId);
  const ms = median(ran.map((t) => t.record.ms));
  const priced = ran.filter((t) => t.record.estimate !== undefined);
  const cost = median(priced.map((t) => t.record.estimate!));
  const total = trials.reduce((sum, t) => sum + (t.record.estimate ?? 0), 0);
  const reusedCost = trials
    .filter((t) => t.record.reused)
    .reduce((sum, t) => sum + (t.record.estimate ?? 0), 0);
  const grading = trials.reduce(
    (sum, t) =>
      sum +
      t.scores.reduce(
        (s, score) => s + score.entries.reduce((e, x) => e + (x.estimate ?? 0), 0),
        0,
      ),
    0,
  );
  // A run with no agents costs nothing to price; one whose agents' count is unknown may.
  const noAgents = total === 0 && ran.every((t) => t.record.agents === 0);
  const unpriced = ran.some(
    (t) =>
      (t.record.estimate === undefined && t.record.agents !== 0) ||
      (t.record.priced ?? 0) < (t.record.agents ?? 0),
  );
  if (ms !== undefined) {
    lines.push(
      [
        `time per trial, median ${seconds(ms)}`,
        ...(noAgents
          ? ["the workflow ran no agents"]
          : [
              ...(cost !== undefined ? [`est. cost per trial, median ${usd(cost)}`] : []),
              `all trials ${usd(total)}${reusedCost > 0 ? `, ${usd(reusedCost)} of it reused trials, run before` : ""}${unpriced ? ", partly unpriced" : ""}`,
            ]),
        ...(grading > 0 ? [`grading ${usd(grading)}`] : []),
      ].join(" · "),
    );
  }
  lines.push(...gradersLines(trials, decidersOf));
  // With one trial per case, a stage's time across cases is worth a line; with more, `--case`.
  if (run.asked.every((a) => a.trials === 1)) {
    const stages = stageLine(trials.filter((t) => t.record.column === 0));
    if (stages) lines.push(`time per stage, median across cases: ${stages}`);
  }
  if (typeof stale === "number" && stale > 0) {
    lines.push(
      `${plural(stale, "grade")} out of date, a key or grader changed: awf-lab score ${run.id.slice(-4)}`,
    );
  } else if (typeof stale === "object") {
    lines.push(`grades: couldn't check whether any is out of date: ${stale.unread}`);
  }
  lines.push(...judgeLines(trials, criteria, judgeLabeled));
  if (person) lines.push(...personLines(run, person));
  if (leftOut && leftOut.length > 0) {
    lines.push(
      `history leaves out ${plural(leftOut.length, "earlier run")} whose records don't read: awf-lab runs`,
    );
  }
  lines.push(
    trials.some((t) => t.record.sandbox === "lab")
      ? "sandbox: the lab's box around each trial, srt, reading no key; the workflow's own set aside"
      : "sandbox: the workflow's own, its agents' reach checked against agentReach",
    "",
  );
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
  /** This case's row in each other column. */
  others: readonly (CaseRow | undefined)[] = [],
  /** The person's labels, by workflow run id. */
  labels: ReadonlyMap<string, LabelRecord> = new Map(),
): string {
  const tally = (r: CaseRow) =>
    `${r.tally.verdict ?? r.tally.none ?? "no trials"} ${r.tally.passed}/${r.tally.trials}`;
  const lines = [
    `${row.name} · run ${run.id} · ${tally(row)}`,
    ...others.flatMap((other, i) => (other ? [`${columnLabel(run, i + 1)}: ${tally(other)}`] : [])),
  ];
  const stages = stageLine(trials.filter((t) => t.record.column === 0));
  if (stages) lines.push(`time per stage, median: ${stages}`);
  for (const trial of trials) {
    const { record } = trial;
    const view = trialOutcome(record, trial.scores, deciders);
    lines.push(
      "",
      `trial ${record.trial}${record.column > 0 ? ` (${columnLabel(run, record.column)})` : ""}: ${view.outcome}${record.runId ? ` · id ${record.runId}` : ""} · ${seconds(record.ms)}`,
    );
    const label = record.runId ? labels.get(record.runId) : undefined;
    if (label) lines.push(`  labeled ${label.mark}${label.note ? `: ${label.note}` : ""}`);
    else if (record.runId)
      lines.push(`  label: awf-lab label ${record.runId} --good | --needs-work "{note}"`);
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
        ...(entry.beside || (deciders && !deciders.has(entry.grader))
          ? ["not in the verdict"]
          : []),
        ...(entry.estimate !== undefined ? [`est. ${usd(entry.estimate)}`] : []),
        ...(entry.runId ? [`run ${entry.runId}`] : []),
      ];
      lines.push(
        `  ${entryName(entry)}: ${verdict}${about.length > 0 ? ` (${about.join(", ")})` : ""}`,
      );
      for (const [name, number] of Object.entries(entry.numbers ?? {})) {
        lines.push(
          `    ${name}: ${"count" in number ? `${number.count}/${number.of}` : number.value}`,
        );
      }
      // A reason a part's own line already says, as its why, is said once.
      const parts = new Set(
        (entry.parts ?? []).filter((p) => p.why && p.why.trim() !== "").map((p) => p.about),
      );
      for (const reason of entry.reasons.filter((r) => !parts.has(r.about))) {
        lines.push(`    ${reason.about}: ${reason.text}`);
      }
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
