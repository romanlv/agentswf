import { type AnswerKey, SEVERITIES } from "../format/format";
import { REPORT_FORMAT, type ReportColumn, type ReportDocument } from "../format/output";
import type { Score, Trial } from "../format/records";
import type { FindingLabel } from "../format/scoring";
import { categoryOf } from "../judge/panel";
import {
  agreement,
  type Counts,
  count,
  type Filter,
  type Metrics,
  metrics,
  spendOf,
  sum,
} from "../metrics/metrics";
import { addresser, parseAddress } from "./address";
import { currentTrial, passingScore, type Stored } from "./plan";
import { keyOf } from "./version";

/** One selected case as the store has it for a variant, with the key as it is now. */
export type Row = {
  case: string;
  digest: string;
  key: AnswerKey;
  /** When review started on it, as the dataset records. */
  at: string;
  stored: readonly Stored[];
};

export type ReportSubject = {
  name: string;
  /** As the command named it: `{name}`, or `{name}@{version}` for a stored version. */
  label: string;
  version: string;
  /** Whose results these are: `{name}@{major}.{minor}`. */
  key: string;
  commit: string | null;
  dirty: boolean;
  tunedOn?: { before?: string; fixtures?: string[] };
  rows: readonly Row[];
};

/** A scorer as the report reads it: `key` finds its scores; the rest is printed. */
type Ref = { name: string; version: string; key: string };

/** A case the variant was tuned on: from before its date, or named. */
function tuned(subject: ReportSubject, row: Row): boolean {
  const { before, fixtures = [] } = subject.tunedOn ?? {};
  return fixtures.includes(row.case) || (before !== undefined && row.at < before);
}

type Counted = { case: string; trial: Trial; score: Score; counts: Counts };

/** One case's numbers from its trial and a score of it. */
export function caseMetrics(trial: Trial, score: Score, key: AnswerKey, filter: Filter = {}) {
  if (score.result.status !== "scored") throw new Error("only a passing score is counted");
  return metrics(
    count(
      {
        fixture: trial.case.id,
        findings: trial.findings,
        labels: score.result.judgement.labels,
        key,
      },
      filter,
    ),
  );
}

/** How two results on one case compare, by weighted recall, then precision: above 0, `a` did better. */
export function compareCases(a: Metrics, b: Metrics): number {
  return (
    (a.weightedRecall ?? 0) - (b.weightedRecall ?? 0) || (a.precision ?? 0) - (b.precision ?? 0)
  );
}

/** Each case's counted trial, or why it has none. */
function countedRows(subject: ReportSubject, scorerKey: string, filter: Filter) {
  const counted: Counted[] = [];
  const missing: { case: string; why: string }[] = [];
  for (const row of subject.rows) {
    const stored = currentTrial({
      case: row.case,
      digest: row.digest,
      keyRevision: row.key.revision,
      stored: row.stored,
    });
    if (!stored) {
      missing.push({ case: row.case, why: "no trial" });
      continue;
    }
    const score = passingScore(stored, scorerKey, row.key.revision);
    if (score?.result.status !== "scored") {
      const failed = stored.scores.some(
        (s) => keyOf(s.scorer) === scorerKey && s.key.revision === row.key.revision,
      );
      missing.push({
        case: row.case,
        why: failed
          ? "its score failed, run again to retry"
          : `not scored on key r${row.key.revision}`,
      });
      continue;
    }
    const counts = count(
      {
        fixture: row.case,
        findings: stored.trial.findings,
        labels: score.result.judgement.labels,
        key: row.key,
      },
      filter,
    );
    counted.push({ case: row.case, trial: stored.trial, score, counts });
  }
  return { counted, missing };
}

function column(
  subject: ReportSubject,
  scorer: Ref,
  counted: readonly Counted[],
  missing: readonly { case: string; why: string }[],
  id: (caseId: string) => string,
): ReportColumn {
  const m = metrics(sum(counted.map((c) => c.counts)));
  const kappas = counted.flatMap((c) =>
    c.score.agreement === undefined ? [] : [c.score.agreement],
  );
  const cases = counted.map((c) => c.case);
  return {
    name: subject.label,
    version: subject.version,
    commit: subject.commit,
    dirty: subject.dirty,
    scorer: scorer.name,
    cases: counted.map((c) => {
      const each = metrics(c.counts);
      return {
        id: id(c.case),
        trial: c.trial.id,
        findings: c.trial.findings.length,
        weightedRecall: each.weightedRecall,
        precision: each.precision,
        labels: each.counts.labels,
      };
    }),
    tunedOn: subject.rows
      .filter((row) => cases.includes(row.case) && tuned(subject, row))
      .map((row) => id(row.case)),
    missing: missing.map((gap) => ({ id: id(gap.case), why: gap.why })),
    failedTrials: counted.flatMap((c) => (c.trial.failure ? [id(c.case)] : [])),
    recall: m.recall,
    weightedRecall: m.weightedRecall,
    distinct: m.distinct,
    precision: m.precision,
    wrong: m.wrong,
    noise: m.noise,
    nits: m.nits,
    words: m.words,
    labels: m.counts.labels,
    bySeverity: m.counts.bySeverity,
    context: m.counts.context,
    byCategory: m.counts.byCategory,
    bySource: m.counts.bySource,
    missed: m.missed.map((miss) => ({
      id: id(miss.fixture),
      issue: miss.issue,
      mechanism: miss.mechanism,
    })),
    agreement: kappas.length === 0 ? null : kappas.reduce((a, b) => a + b, 0) / kappas.length,
    restoreMs: counted.reduce((total, c) => total + c.trial.restoreMs, 0),
    trial: spendOf(counted.map((c) => c.trial.run)),
    score: spendOf(counted.map((c) => c.score.run)),
  };
}

// Issue ids repeat across cases (K1 in each), so a pooled κ names a hit by case and issue.
const pooled = (caseId: string, labels: readonly FindingLabel[]) =>
  labels.map(
    (l): FindingLabel => (l.label === "hit" ? { ...l, issue: `${caseId}/${l.issue}` } : l),
  );

/**
 * Variants side by side, a column per variant, or per variant and scorer with two scorers, over the
 * cases every column counts: a case only some count is listed as missing from the others, never
 * counted against them. With a baseline, each other variant's cases won, lost and tied against it;
 * with two scorers, how alike they label each variant's findings.
 */
export function buildReport(options: {
  dataset: string;
  subjects: readonly ReportSubject[];
  scorers: readonly Ref[];
  baseline?: string;
  filter?: Filter;
  where?: readonly string[];
}): ReportDocument {
  const { subjects, scorers, filter = {} } = options;
  if (subjects.length < 1) throw new Error("report takes a variant");
  if (scorers.length < 1 || scorers.length > 2) throw new Error("report takes one or two scorers");
  const address = addresser(subjects.length > 1);
  const cells = subjects.flatMap((subject) =>
    scorers.map((scorer) => ({ subject, scorer, ...countedRows(subject, scorer.key, filter) })),
  );
  // A column that counts nothing, as a version with no trials yet, would leave no case in common:
  // it is left out and named, so the others still compare.
  const kept = cells.some((cell) => cell.counted.length > 0)
    ? cells.filter((cell) => cell.counted.length > 0)
    : cells;
  const leftOut = cells.filter((cell) => !kept.includes(cell));
  const everywhere = new Set(
    kept[0]!.counted
      .map((c) => c.case)
      .filter((id) => kept.every((cell) => cell.counted.some((c) => c.case === id))),
  );
  const common = kept[0]!.subject.rows.map((row) => row.case).filter((c) => everywhere.has(c));
  const columns = kept.map((cell) => {
    const id = (caseId: string) => address(cell.subject.label, { case: caseId });
    const within = cell.counted.filter((c) => everywhere.has(c.case));
    const left = cell.counted
      .filter((c) => !everywhere.has(c.case))
      .map((c) => ({ case: c.case, why: "another column doesn't count it" }));
    return column(cell.subject, cell.scorer, within, [...cell.missing, ...left], id);
  });

  const keyRevisions = [
    ...new Set(subjects.flatMap((subject) => subject.rows.map((row) => row.key.revision))),
  ].sort((a, b) => a - b);
  const keyProcedures = [
    ...new Set(subjects.flatMap((subject) => subject.rows.map((row) => row.key.procedure))),
  ].sort();
  const baseline = subjects.find((s) => s.label === options.baseline);
  const document: ReportDocument = {
    format: REPORT_FORMAT,
    dataset: options.dataset,
    scorers: scorers.map(({ name, version }) => ({ name, version })),
    ...(baseline ? { baseline: { name: baseline.label, version: baseline.version } } : {}),
    keyRevisions,
    keyProcedures,
    ...(filter.categories ? { filter: { categories: [...filter.categories] } } : {}),
    ...(options.where && options.where.length > 0 ? { where: [...options.where] } : {}),
    budgetBasis: "list-price",
    columns,
    ...(leftOut.length > 0
      ? {
          leftOut: leftOut.map((cell) => ({
            variant: cell.subject.label,
            scorer: cell.scorer.name,
          })),
        }
      : {}),
  };

  const compared = subjects.filter((s) => kept.some((cell) => cell.subject === s));
  if (baseline && compared.includes(baseline) && scorers.length === 1 && compared.length > 1) {
    const cell = (subject: ReportSubject) => cells.find((c) => c.subject === subject)!;
    const theirs = new Map(cell(baseline).counted.map((c) => [c.case, metrics(c.counts)]));
    document.comparison = {
      baseline: baseline.label,
      cases: common,
      against: compared
        .filter((s) => s !== baseline)
        .map((subject) => {
          const result = {
            variant: subject.label,
            won: [] as string[],
            lost: [] as string[],
            tied: [] as string[],
          };
          for (const c of cell(subject).counted) {
            if (!everywhere.has(c.case)) continue;
            const order = compareCases(metrics(c.counts), theirs.get(c.case)!);
            const id = address(subject.label, { case: c.case });
            (order > 0 ? result.won : order < 0 ? result.lost : result.tied).push(id);
          }
          return result;
        }),
    };
  }

  if (scorers.length === 2) {
    document.agreement = compared.map((subject) => {
      const [a, b] = scorers.map(
        (scorer) => cells.find((c) => c.subject === subject && c.scorer === scorer)!,
      ) as [(typeof cells)[number], (typeof cells)[number]];
      const left: FindingLabel[] = [];
      const right: FindingLabel[] = [];
      const differ: { id: string; labels: string[] }[] = [];
      for (const x of a.counted) {
        const y = b.counted.find((c) => c.case === x.case);
        if (!y || !everywhere.has(x.case)) continue;
        if (x.score.result.status !== "scored" || y.score.result.status !== "scored") continue;
        const [la, lb] = [x.score.result.judgement.labels, y.score.result.judgement.labels];
        left.push(...pooled(x.case, la));
        right.push(...pooled(x.case, lb));
        la.forEach((label, finding) => {
          const other = lb[finding];
          if (other && categoryOf(label) !== categoryOf(other)) {
            differ.push({
              id: address(subject.label, { case: x.case, finding }),
              labels: [categoryOf(label), categoryOf(other)],
            });
          }
        });
      }
      return {
        variant: subject.label,
        findings: left.length,
        kappa: agreement(left, right),
        differ,
      };
    });
  }
  return document;
}

const percent = (value: number | null) => (value === null ? "–" : `${Math.round(value * 100)}%`);
const decimal = (value: number | null) => (value === null ? "–" : value.toFixed(2));
const usd = (value: number | null) => (value === null ? "$?" : `$${value.toFixed(2)}`);

export function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** How text output is styled: plain unless it goes to a terminal that takes colour. */
export type Paint = {
  strong(text: string): string;
  dim(text: string): string;
  good(text: string): string;
  bad(text: string): string;
};

export const PLAIN: Paint = { strong: (t) => t, dim: (t) => t, good: (t) => t, bad: (t) => t };
export const ANSI: Paint = {
  strong: (t) => `\x1b[1m${t}\x1b[22m`,
  dim: (t) => `\x1b[2m${t}\x1b[22m`,
  good: (t) => `\x1b[1;32m${t}\x1b[22;39m`,
  bad: (t) => `\x1b[31m${t}\x1b[39m`,
};

/** A column's heading: the variant, the scorer, or both when the report has several of each. */
function headingOf(report: ReportDocument, c: ReportColumn): string {
  const variants = new Set(report.columns.map((x) => x.name)).size;
  if (report.scorers.length < 2) return c.name;
  return variants > 1 ? `${c.name} ${c.scorer}` : c.scorer;
}

type Metric = { label: string; cells: string[]; best: ReadonlySet<number> };
type Group = { title: string; metrics: Metric[] };
/** A note's items each name what they are about, then say it: a missed issue and its mechanism. */
type Note = { label: string; text: string; items?: { head: string; text: string }[] };

/** The columns holding the best value, when the columns differ; none with one column. */
function bestOf(values: readonly (number | null)[], higher: boolean): Set<number> {
  const known = values.filter((v): v is number => v !== null);
  if (values.length < 2 || known.length === 0) return new Set();
  const best = higher ? Math.max(...known) : Math.min(...known);
  if (known.length === values.length && known.every((v) => v === best)) return new Set();
  return new Set(values.flatMap((v, i) => (v === best ? [i] : [])));
}

/** The metrics in groups, a cell per column, then the notes: the same for text and Markdown. */
function tableOf(report: ReportDocument): { groups: Group[]; notes: Note[] } {
  const columns = report.columns;
  const headings = columns.map((c) => headingOf(report, c));
  const metric = (
    label: string,
    cell: (c: ReportColumn) => string,
    rank?: { by: (c: ReportColumn) => number | null; higher: boolean },
  ): Metric => ({
    label,
    cells: columns.map(cell),
    best: rank ? bestOf(columns.map(rank.by), rank.higher) : new Set(),
  });
  const ratio = (c: ReportColumn, severity: string) => {
    const tally = c.bySeverity[severity];
    return tally && tally.total > 0 ? tally.hit / tally.total : null;
  };
  const groups: Group[] = [
    {
      title: "recall",
      metrics: [
        ...SEVERITIES.map((severity) =>
          metric(
            severity,
            (c) => {
              const tally = c.bySeverity[severity];
              return tally && tally.total > 0 ? `${tally.hit}/${tally.total}` : "–";
            },
            { by: (c) => ratio(c, severity), higher: true },
          ),
        ),
        metric("weighted", (c) => decimal(c.weightedRecall), {
          by: (c) => c.weightedRecall,
          higher: true,
        }),
      ],
    },
    {
      title: "findings",
      metrics: [
        metric("precision", (c) => decimal(c.precision), { by: (c) => c.precision, higher: true }),
        metric("wrong", (c) => `${c.labels.wrong ?? 0}/${c.distinct} (${percent(c.wrong)})`, {
          by: (c) => c.wrong,
          higher: false,
        }),
        metric("noise", (c) => `${c.labels.noise ?? 0}/${c.distinct}`, {
          by: (c) => c.noise,
          higher: false,
        }),
        metric("words", (c) => c.words.toLocaleString("en-US")),
      ],
    },
    {
      title: "cost",
      metrics: [
        metric("trial", (c) => usd(c.trial.estimate)),
        metric("trial time", (c) => duration(c.trial.ms)),
        metric("scorer", (c) => usd(c.score.estimate)),
        metric("scorer time", (c) => duration(c.score.ms)),
        metric("voters' κ", (c) => decimal(c.agreement)),
      ],
    },
  ];
  const comparison = report.comparison;
  if (comparison) {
    const against = new Map(comparison.against.map((a) => [a.variant, a]));
    const only = comparison.against.length === 1 ? comparison.against[0] : undefined;
    const won = (c: ReportColumn) =>
      c.name === comparison.baseline
        ? only
          ? only.lost.length
          : null
        : (against.get(c.name)?.won.length ?? 0);
    groups.push({
      title: `vs ${comparison.baseline}`,
      metrics: [metric("cases won", (c) => String(won(c) ?? "–"), { by: won, higher: true })],
    });
  }

  const notes: Note[] = [];
  for (const out of report.leftOut ?? []) {
    const by = report.scorers.length > 1 ? ` by ${out.scorer}` : "";
    notes.push({
      label: "left out",
      text: `${out.variant}: no case scored${by} on this version; awf-lab list ${out.variant.split("@")[0]} names the versions that have some`,
    });
  }
  for (const a of comparison?.against ?? []) {
    if (a.tied.length > 0) notes.push({ label: "tied", text: a.tied.join(", ") });
  }
  for (const c of columns) {
    if (c.tunedOn.length > 0)
      notes.push({ label: "tuned on", text: `${c.tunedOn.join(", ")} (counted, not holdout)` });
  }
  // One line per commit: the variants are usually files of one repository.
  const dirty = new Map<string, string[]>();
  for (const c of new Map(columns.map((c) => [c.name, c])).values()) {
    if (!c.dirty) continue;
    const from = c.commit?.slice(0, 12) ?? "git";
    dirty.set(from, [...(dirty.get(from) ?? []), c.name]);
  }
  for (const [from, names] of dirty)
    notes.push({ label: "uncommitted", text: `${names.join(", ")}: files differ from ${from}` });
  const failed = [...new Set(columns.flatMap((c) => c.failedTrials))];
  if (failed.length > 0) notes.push({ label: "failed trial", text: failed.join(", ") });
  // One item per issue, naming the columns that missed it.
  const missed = new Map<string, { mechanism: string; by: string[] }>();
  columns.forEach((c, i) => {
    for (const miss of c.missed) {
      const head = `${parseAddress(miss.id)?.case ?? miss.id} ${miss.issue}`;
      const entry = missed.get(head) ?? { mechanism: miss.mechanism, by: [] };
      missed.set(head, entry);
      if (!entry.by.includes(headings[i]!)) entry.by.push(headings[i]!);
    }
  });
  if (missed.size > 0) {
    notes.push({
      label: "missed must-fix",
      text: "",
      items: [...missed].map(([head, { mechanism, by }]) => ({
        head,
        text: `${columns.length > 1 ? `${by.length === columns.length ? "all" : by.join(", ")}: ` : ""}${mechanism}`,
      })),
    });
  }
  // One line per reason. A case every column leaves out for the same reason is named once, bare.
  const gaps = new Map<string, Map<string, string[]>>();
  for (const c of columns) {
    const by = report.scorers.length > 1 ? ` (${c.scorer})` : "";
    for (const gap of c.missing) {
      const byCase = gaps.get(gap.why) ?? new Map<string, string[]>();
      gaps.set(gap.why, byCase);
      const id = parseAddress(gap.id)?.case ?? gap.id;
      byCase.set(id, [...(byCase.get(id) ?? []), `${gap.id}${by}`]);
    }
  }
  for (const [why, byCase] of gaps) {
    const ids = [...byCase].flatMap(([id, gaps]) => (gaps.length === columns.length ? [id] : gaps));
    notes.push({
      label: "not counted",
      text: `${why}, ${plural(ids.length, "case")}: ${ids.join(", ")}`,
    });
  }
  for (const a of report.agreement ?? []) {
    const [x, y] = report.scorers.map((s) => s.name);
    notes.push({
      label: "scorers' κ",
      text: `${a.variant}: ${decimal(a.kappa)} on ${a.findings} findings, ${a.differ.length} labelled differently`,
      items: a.differ.map((d) => ({
        head: d.id,
        text: `${x} ${d.labels[0]}, ${y} ${d.labels[1]}`,
      })),
    });
  }
  return { groups, notes };
}

/** The title, and what the numbers are over. */
function headerOf(report: ReportDocument): { title: string; over: string[] } {
  const names = [...new Set(report.columns.map((c) => c.name))];
  const cases = report.comparison?.cases.length ?? report.columns[0]!.cases.length;
  const scorers = report.scorers.map((s) => `${s.name} ${s.version}`).join(" and ");
  return {
    title: names.join(" vs "),
    over: [
      `dataset ${report.dataset}`,
      plural(cases, "case"),
      `key ${report.keyRevisions.map((r) => `r${r}`).join(",") || "–"}`,
      `scorer ${scorers}`,
      ...(report.comparison ? [`baseline ${report.comparison.baseline}`] : []),
      ...(report.filter ? [`only ${report.filter.categories.join(", ")}`] : []),
      ...(report.where ? [`where ${report.where.join(" and ")}`] : []),
    ],
  };
}

const BASIS = "costs are list-price estimates, also for runs on a subscription";

/** Words filled to `width`, every line after the first indented by `hang`. */
function wrap(text: string, width: number, hang: number): string {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const room = width - (lines.length === 0 ? 0 : hang);
    if (line && line.length + 1 + word.length > room) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  lines.push(line);
  return lines.map((l, i) => (i === 0 ? l : `${" ".repeat(hang)}${l}`)).join("\n");
}

/**
 * The report as a person reads it: a column per variant, the best value of each ranked metric
 * marked, then the notes. Notes wrap to `width` when given, as a terminal's is.
 */
export function renderReport(
  report: ReportDocument,
  view: { paint?: Paint; width?: number } = {},
): string {
  const paint = view.paint ?? PLAIN;
  const { groups, notes } = tableOf(report);
  const headings = report.columns.map((c) => headingOf(report, c));
  const metrics = groups.flatMap((g) => g.metrics);
  const label = Math.max(...metrics.map((m) => m.label.length + 2), 14) + 2;
  const widths = headings.map((h, i) =>
    Math.max(h.length, ...metrics.map((m) => m.cells[i]!.length)),
  );
  const row = (first: string, cells: string[]) =>
    `${first}${" ".repeat(Math.max(0, label - first.length))}${cells.join("   ")}`.trimEnd();
  const { title, over } = headerOf(report);
  const lines = [
    paint.strong(title),
    paint.dim(over.join(" · ")),
    "",
    row(
      "",
      headings.map((h, i) => paint.strong(h.padStart(widths[i]!))),
    ),
  ];
  for (const group of groups) {
    lines.push(paint.strong(group.title));
    for (const m of group.metrics) {
      const cells = m.cells.map((cell, i) => {
        const padded = cell.padStart(widths[i]!);
        return m.best.has(i) ? paint.good(padded) : cell === "–" ? paint.dim(padded) : padded;
      });
      lines.push(row(`  ${m.label}`, cells));
    }
  }
  const width = view.width ?? Number.POSITIVE_INFINITY;
  const noteLabel = Math.max(...notes.map((n) => n.label.length), 0) + 2;
  if (notes.length > 0) lines.push("");
  for (const note of notes) {
    const tint = ["failed trial", "missed must-fix", "left out"].includes(note.label)
      ? paint.bad
      : paint.strong;
    const text = wrap(note.text, width - noteLabel, noteLabel);
    lines.push(`${tint(note.label.padEnd(noteLabel))}${text}`.trimEnd());
    const head = Math.max(...(note.items ?? []).map((item) => item.head.length), 0) + 4;
    for (const item of note.items ?? []) {
      lines.push(`  ${item.head.padEnd(head - 2)}${wrap(item.text, width - head, head)}`);
    }
  }
  lines.push("", paint.dim(BASIS));
  return lines.join("\n");
}

/** The report as Markdown: a table with a row per group, then the notes as a list. */
export function renderMarkdown(report: ReportDocument): string {
  const { groups, notes } = tableOf(report);
  const cell = (text: string) => text.replaceAll("|", "\\|");
  const headings = report.columns.map((c) => headingOf(report, c));
  const { title, over } = headerOf(report);
  return [
    `**${cell(title)}**, ${cell(over.join(", "))}`,
    "",
    `| | ${headings.map(cell).join(" | ")} |`,
    `| --- | ${headings.map(() => "---:").join(" | ")} |`,
    ...groups.flatMap((g) => [
      `| **${cell(g.title)}** |${" |".repeat(headings.length)}`,
      ...g.metrics.map(
        (m) =>
          `| ${m.label} | ${m.cells.map((c, i) => (m.best.has(i) ? `**${cell(c)}**` : cell(c))).join(" | ")} |`,
      ),
    ]),
    "",
    ...notes.flatMap((n) => [
      `- ${n.label}${n.text ? `: ${n.text}` : ""}`,
      ...(n.items ?? []).map((item) => `  - ${item.head}: ${item.text}`),
    ]),
    ...(notes.length > 0 ? [""] : []),
    `_${BASIS}_`,
  ].join("\n");
}
