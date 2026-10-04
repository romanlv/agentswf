import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { restore, scratchDir } from "../fixtures/git";
import { digestFixture, digestOf } from "../fixtures/seal";
import { canonicalJson, SET_FILE } from "../fixtures/set";
import { readCase, SNAPSHOT_REF } from "../fixtures/verify";
import type { AnswerKey, Fixture } from "../format/format";
import type { ComparedFinding } from "../format/output";
import {
  type Identity,
  PARTIAL_SCORE_FORMAT,
  type PartialScore,
  SCORED_FORMAT,
  type Score,
  TRIAL_FORMAT,
  type Trial,
} from "../format/records";
import {
  type FindingLabel,
  type ReviewFinding,
  type RunSummary,
  SCORER_RESULT_FORMAT,
} from "../format/scoring";
import { checkFixtureSet, checkReviewFindings, describeProblems } from "../format/validate";
import type { ScorerSettings, VariantSettings } from "../format/variant";
import { checkScorerResult } from "../judge/check";
import { categoryOf } from "../judge/panel";
import { agreement } from "../metrics/metrics";
import { addresser } from "./address";
import { fill } from "./placeholders";
import {
  type CaseState,
  type Chosen,
  estimateOf,
  planCases,
  type ScoreOnFile,
  type Step,
} from "./plan";
import { duration, plural, usd } from "./report";
import { type Runner, type RunRequest, type RunResult, summaryOf } from "./runner";
import {
  scoresBy,
  storedTrials,
  trialDir,
  trialsOf,
  writePartial,
  writeScore,
  writeTrial,
} from "./store";
import type { Workspace } from "./workspace";

/**
 * A variant or scorer as a command names it: the name records keep, the label the command printed
 * it by (`{name}`, or `{name}@{version}` for a stored version), its version, the key its results
 * are kept by (`{name}@{major}.{minor}`), and where it came from. `defined` is
 * absent for a stored version the file no longer declares: its records can be read and scored,
 * never run.
 */
export type Subject<D> = {
  name: string;
  label: string;
  version: string;
  key: string;
  commit: string | null;
  file?: string;
  defined?: D;
};

/** A selected case, checked against the dataset that pins it. */
export type CaseInfo = {
  id: string;
  dir: string;
  digest: string;
  fixture: Fixture;
  key: AnswerKey;
};

export type Lab = {
  workspace: Workspace;
  runner: Runner;
  /** Progress, a line per step: stderr. */
  log: (line: string) => void;
  now?: () => Date;
};

/**
 * A dataset's tuning cases, `entries`, and the ids `awf-lab.json` holds out of it, which only a
 * loop's final check reads.
 */
export async function datasetCases(workspace: Workspace, dataset: string) {
  const dir = join(workspace.datasets, dataset);
  const file = join(dir, SET_FILE);
  const checked = checkFixtureSet(await Bun.file(file).json());
  if (!checked.ok) throw new Error(describeProblems(file, checked.problems));
  const fixtures = checked.value.fixtures;
  const held: ReadonlySet<string> = new Set(workspace.config.holdout?.[dataset]?.cases ?? []);
  const missing = [...held].filter((id) => !fixtures.some((e) => e.id === id));
  if (missing.length > 0) {
    throw new Error(`awf-lab.json holds out cases not in ${dataset}: ${missing.join(", ")}`);
  }
  const entries = fixtures.filter((e) => !held.has(e.id));
  if (entries.length === 0) {
    throw new Error(`awf-lab.json holds out every case of ${dataset}, leaving none to tune on`);
  }
  return { dir, set: checked.value, entries, held };
}

export const heldOutError = (id: string) =>
  `${id} is held out: only a loop's final check reads it (awf-lab.json, holdout)`;

/**
 * The selected cases, each checked as far as scoring relies on it: its digest is the one the
 * dataset was sealed with, and its case file and key pass their checks. The frozen head is checked
 * at each restore. The whole dataset's `verifySet` stays the workspace's own check.
 */
export async function readCases(
  workspace: Workspace,
  dataset: string,
  ids: readonly string[],
  options: { heldOut?: true } = {},
): Promise<CaseInfo[]> {
  const { dir: datasetDir, set, held } = await datasetCases(workspace, dataset);
  const infos: CaseInfo[] = [];
  for (const id of ids) {
    if (held.has(id) && !options.heldOut) throw new Error(heldOutError(id));
    const entry = set.fixtures.find((e) => e.id === id);
    if (!entry) throw new Error(`${id} is not in ${dataset}`);
    const dir = join(datasetDir, id);
    const digest = await digestFixture(dir);
    if (digest !== entry.digest) {
      throw new Error(
        `${id} changed since ${dataset} was sealed: ${digest}, sealed as ${entry.digest}`,
      );
    }
    infos.push({ id, dir, digest, ...(await readCase(dir)) });
  }
  return infos;
}

/** Each case's state under a variant: what the store holds, and the case as it is now. */
export async function statesOf(
  workspace: Workspace,
  dataset: string,
  variantKey: string,
  cases: readonly CaseInfo[],
): Promise<CaseState[]> {
  const states: CaseState[] = [];
  for (const info of cases) {
    states.push({
      case: info.id,
      digest: info.digest,
      keyRevision: info.key.revision,
      sandbox: workspace.sandbox,
      stored: await storedTrials(workspace.results, dataset, variantKey, info.id),
    });
  }
  return states;
}

/** One variant's steps, and what its earlier trials cost; the mean estimates the next. */
export type VariantPlan = {
  variant: Subject<VariantSettings>;
  steps: Step[];
  trialHistory: (number | undefined)[];
};

export type Planned = {
  command: "run" | "score";
  /** Trials a case, as asked: past 1, a step's address names its trial. */
  trials: number;
  variants: VariantPlan[];
  /** What the scorer's earlier scores cost. */
  scoreHistory: (number | undefined)[];
};

export async function planRun(
  lab: Lab,
  options: {
    command: "run" | "score";
    trials: number;
    dataset: string;
    variants: readonly { variant: Subject<VariantSettings>; chosen: Chosen }[];
    scorer: Subject<ScorerSettings>;
    restFrom?: Subject<ScorerSettings>;
    cases: readonly CaseInfo[];
  },
): Promise<Planned> {
  const { results } = lab.workspace;
  const variants: VariantPlan[] = [];
  for (const { variant, chosen } of options.variants) {
    const cases = options.cases.filter((info) => chosen.has(info.id));
    const states = await statesOf(lab.workspace, options.dataset, variant.key, cases);
    const trials = await trialsOf(results, options.dataset, variant.key);
    variants.push({
      variant,
      steps: planCases(states, {
        command: options.command,
        scorerKey: options.scorer.key,
        chosen,
        ...(options.restFrom ? { restFromKey: options.restFrom.key } : {}),
      }),
      trialHistory: trials.flatMap((t) => (t.run.id === undefined ? [] : [t.run.estimate])),
    });
  }
  const scores = await scoresBy(results, options.dataset, options.scorer.key);
  return {
    command: options.command,
    trials: options.trials,
    variants,
    scoreHistory: scores.flatMap((s) => (s.run?.id === undefined ? [] : [s.run.estimate])),
  };
}

/** How many trials and scores the plan runs, and their estimate: null when there is nothing to estimate from. */
export function estimateOfPlan(planned: Planned): {
  trials: number;
  scores: number;
  usd: number | null;
} {
  let trials = 0;
  let total: number | null = 0;
  for (const { steps, trialHistory } of planned.variants) {
    const count = steps.filter((s) => s.trial.do === "run").length;
    const each = estimateOf(trialHistory);
    trials += count;
    if (count > 0) total = each === null || total === null ? null : total + count * each;
  }
  const scores = planned.variants
    .flatMap((v) => v.steps)
    .filter((s) => s.score.do === "run" || s.score.do === "partial").length;
  const each = estimateOf(planned.scoreHistory);
  if (scores > 0) total = each === null || total === null ? null : total + scores * each;
  return { trials, scores, usd: total };
}

/**
 * A step's address in the plan: the variant's label only when the plan covers several, the trial
 * only when it asks for more than one a case.
 */
export function stepAddress(
  planned: Planned,
  variant: string,
  step: { case: string; n: number },
  finding?: number,
): string {
  return addresser(planned.variants.length > 1)(variant, {
    case: step.case,
    ...(planned.trials > 1 ? { trial: step.n } : {}),
    ...(finding === undefined ? {} : { finding }),
  });
}

/** The plan as a person reads it before confirming. */
export function describePlan(planned: Planned): string[] {
  const lines: string[] = [];
  for (const { variant, steps } of planned.variants) {
    for (const step of steps) {
      const trial =
        step.trial.do === "run"
          ? "trial"
          : step.trial.do === "reuse"
            ? `reuse trial ${step.trial.trial.id}${step.trial.trial.failure ? " (failed)" : ""}`
            : `skip: ${step.trial.why}`;
      const score =
        step.score.do === "run"
          ? "score"
          : step.score.do === "reuse"
            ? "reuse score"
            : step.score.do === "record"
              ? `record, nothing to score: ${step.score.why}`
              : step.score.do === "partial" || step.score.do === "reuse-partial"
                ? describePartial(step.score)
                : `skip: ${step.score.why}`;
      lines.push(`${stepAddress(planned, variant.label, step).padEnd(24)} ${trial}; ${score}`);
    }
  }
  const { trials, scores, usd: total } = estimateOfPlan(planned);
  const estimate = total === null ? "unknown: no earlier records to estimate from" : usd(total);
  lines.push(
    `${plural(trials, "trial")} and ${plural(scores, "score")} to run; estimated ${estimate}`,
  );
  return lines;
}

/** A partial score step: the chosen findings, those asked with them, and the rest-from scorer. */
function describePartial(score: Extract<Step["score"], { do: "partial" | "reuse-partial" }>) {
  const [picked, asked] =
    score.do === "partial"
      ? [score.picked, score.asked]
      : [score.record.picked, score.record.asked];
  const also = asked.filter((i) => !picked.includes(i));
  const what = `#${picked.join(", #")}${also.length > 0 ? ` and #${also.join(", #")}, which depend on them` : ""}`;
  const verb = score.do === "partial" ? "score" : "reuse partial score of";
  return `${verb} ${what}, the rest from ${score.restFrom.scorer.name}`;
}

const identityOf = (subject: Subject<unknown>): Identity => ({
  name: subject.name,
  version: subject.version,
  commit: subject.commit,
});

function trialId(now: Date): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  return `${stamp}-${crypto.randomUUID().slice(0, 8)}`;
}

/** A fresh checkout of the frozen code, and the head it restored to, checked. */
async function checkout(lab: Lab, info: CaseInfo, target: string): Promise<number> {
  const started = Date.now();
  const head = await restore({
    bundle: join(info.dir, "snapshot.bundle"),
    ref: SNAPSHOT_REF,
    clone: lab.workspace.clone,
    target,
    base: info.fixture.snapshot.base,
  });
  if (head !== info.fixture.snapshot.head) {
    throw new Error(`${info.id} restores to ${head}, not ${info.fixture.snapshot.head}`);
  }
  return Date.now() - started;
}

/** Runs the variant on the frozen code and keeps what it found, or why it found nothing. */
async function runTrial(
  lab: Lab,
  dataset: string,
  variant: Subject<VariantSettings>,
  info: CaseInfo,
): Promise<Trial> {
  const { defined, file } = variant;
  if (!defined || !file)
    throw new Error(`${variant.label} is a stored version; only its file can run`);
  const scratch = scratchDir("awf-lab-trial-");
  try {
    const code = join(scratch, "checkout");
    const restoreMs = await checkout(lab, info, code);
    // Beside the checkout, not in it: the request is the reviewer's, not the repository's.
    const request = join(scratch, "request.md");
    copyFileSync(join(info.dir, "request.md"), request);
    const { base, head } = info.fixture.snapshot;
    // The dataset's folder, so a control that reads the key names no absolute path in its argv.
    const folder = dirname(info.dir);
    const argv = fill(defined.argv, { base, head, request, dataset: folder });
    const result = await runIsolated(lab, scratch, {
      workflow: file,
      cwd: code,
      timeout: defined.timeout,
      argv,
      runRoot: lab.workspace.runs,
      request,
    });
    const run = summaryOf(result);
    let findings: ReviewFinding[] = [];
    let failure: string | undefined;
    if (result.record?.outcome === "succeeded") {
      try {
        const returned = defined.read(result.record.value);
        if (returned === undefined) throw new Error("it returned nothing");
        const read = JSON.parse(JSON.stringify(returned));
        const checked = checkReviewFindings(read);
        if (checked.ok) findings = checked.value;
        else failure = describeProblems("the variant's read", checked.problems);
      } catch (error) {
        failure = `the variant's read failed: ${String(error)}`;
      }
    } else failure = `the run ${run.outcome}: ${run.error ?? "no detail"}`;
    const now = (lab.now ?? (() => new Date()))();
    const trial: Trial = {
      format: TRIAL_FORMAT,
      id: trialId(now),
      at: now.toISOString(),
      variant: identityOf(variant),
      dataset,
      case: { id: info.id, digest: info.digest },
      restoreMs,
      sandbox: lab.workspace.sandbox,
      run,
      ...(failure ? { failure } : {}),
      findings,
    };
    writeTrial(lab.workspace.results, trial);
    return trial;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The top-level `model_reasoning_effort` of codex's config in `dir`, if it sets one. */
export function hostReasoningEffort(dir: string): string | undefined {
  const file = join(dir, "config.toml");
  if (!existsSync(file)) return undefined;
  const top = readFileSync(file, "utf8").split(/^\s*\[/m)[0] ?? "";
  return top.match(/^\s*model_reasoning_effort\s*=\s*"([a-z]+)"/m)?.[1];
}

/**
 * A trial's run, isolated as the workspace says. In a sandbox, every agent the variant opens works
 * in the checkout, reads the request, and reaches nothing else; the variant can't widen it. In a
 * container, so is the workflow's own code: the container holds awf, the variant's folder, the
 * checkout, the request and a fresh home with codex's credential, and no dataset, result or run.
 */
async function runIsolated(
  lab: Lab,
  scratch: string,
  request: Omit<RunRequest, "sandbox" | "contained"> & { request: string },
): Promise<RunResult> {
  const { request: requestFile, ...run } = request;
  const setting = lab.workspace.sandbox;
  if (!("container" in setting)) {
    const sandbox = join(scratch, "sandbox.json");
    writeFileSync(sandbox, JSON.stringify({ read: [requestFile], ...setting }));
    return lab.runner({ ...run, sandbox });
  }
  const root = dirname(lab.workspace.file);
  const folder = dirname(run.workflow);
  const { datasets, results, runs } = lab.workspace;
  if ([root, datasets, results, runs].some((data) => isWithin(data, folder))) {
    throw new Error(
      `${run.workflow}: a contained variant's folder may not hold the workspace's data`,
    );
  }
  const auth = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json");
  if (!existsSync(auth)) {
    throw new Error(`a contained trial takes codex's login from ${auth}, and there is none`);
  }
  const home = join(scratch, "home");
  mkdirSync(join(home, ".codex"), { recursive: true });
  copyFileSync(auth, join(home, ".codex", "auth.json"));
  // A contained variant that names no effort runs at codex's config; without the host's, a model's
  // own default (low, for some) would make it unlike a host trial. It goes once the data
  // repository's variants name their effort (story 020, Q5).
  const effort = hostReasoningEffort(dirname(auth));
  if (effort) {
    writeFileSync(join(home, ".codex", "config.toml"), `model_reasoning_effort = "${effort}"\n`);
  }
  // A run root of its own, so the container sees no other run, moved into the runs folder after.
  mkdirSync(runs, { recursive: true });
  const runRoot = mkdtempSync(join(runs, ".contained-"));
  try {
    return await lab.runner({
      ...run,
      runRoot,
      contained: {
        image: setting.container.image,
        read: [
          folder,
          requestFile,
          ...["node_modules", "package.json", "tsconfig.json"]
            .map((name) => join(root, name))
            .filter((path) => existsSync(path)),
        ],
        write: [run.cwd, runRoot],
        home,
      },
    });
  } finally {
    try {
      for (const entry of readdirSync(runRoot)) renameSync(join(runRoot, entry), join(runs, entry));
      rmSync(runRoot, { recursive: true, force: true });
    } catch {
      // Left where it is, still found by its id; the run's own error is the one to report.
    }
  }
}

/** Whether `path` is `dir` or inside it. */
function isWithin(path: string, dir: string): boolean {
  const from = relative(dir, path);
  return from === "" || (!from.startsWith("..") && !isAbsolute(from));
}

type Scored = Pick<Score, "run" | "agreement" | "result">;

/**
 * Runs a scorer on a trial in a fresh checkout and checks what it returned: a judgement that
 * passes `checkScorerResult`, and with `settled`, a partial labelling handed to the scorer as
 * `--settled {file}`, those labels back unchanged.
 */
async function runScorer(
  lab: Lab,
  scorer: Subject<ScorerSettings>,
  info: CaseInfo,
  trial: Trial,
  settled?: readonly FindingLabel[],
): Promise<Scored> {
  const { defined, file } = scorer;
  if (!defined || !file)
    throw new Error(`${scorer.label} is a stored version; only its file can run`);
  const scratch = scratchDir("awf-lab-score-");
  try {
    const code = join(scratch, "checkout");
    await checkout(lab, info, code);
    const findings = join(scratch, "findings.json");
    await Bun.write(findings, JSON.stringify(trial.findings));
    // The scorer's own flags, which every scorer takes; they keep their names until the names a
    // scorer imports change.
    const argv = [...defined.argv, "--fixture", info.dir, "--findings", findings];
    if (settled) {
      const file = join(scratch, "settled.json");
      await Bun.write(file, JSON.stringify(settled));
      argv.push("--settled", file);
    }
    const result = await lab.runner({
      workflow: file,
      cwd: code,
      timeout: defined.timeout,
      argv,
      runRoot: lab.workspace.runs,
    });
    const run = summaryOf(result);
    if (result.record?.outcome !== "succeeded") {
      return {
        run,
        result: {
          status: "failed",
          reason: `the run ${run.outcome}`,
          problems: run.error ? [run.error] : [],
        },
      };
    }
    const checked = checkScorerResult(result.record.value, trial.findings, info.key);
    const changed = checked.ok
      ? (settled ?? []).filter(
          (label) => canonicalJson(checked.value.labels[label.finding]) !== canonicalJson(label),
        )
      : [];
    if (!checked.ok || changed.length > 0) {
      return {
        run,
        result: {
          status: "failed",
          reason: checked.ok
            ? "the scorer changed labels it was given as settled"
            : "the labels fail their check",
          problems: checked.ok
            ? changed.map((label) => `/labels/${label.finding}: settled as ${label.label}`)
            : checked.problems.map((p) => `${p.path}: ${p.message}`),
        },
      };
    }
    const panel = (checked.value.votes ?? []).filter((vote) => vote.role === "panel");
    const kappa = panel.length === 2 ? agreement(panel[0]!.labels, panel[1]!.labels) : null;
    return {
      run,
      ...(kappa === null ? {} : { agreement: kappa }),
      result: { status: "scored", judgement: checked.value },
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** A scorer run again on a stored trial, its result checked and not kept: `check --rescore`. */
export const scoreAgain = (
  lab: Lab,
  scorer: Subject<ScorerSettings>,
  info: CaseInfo,
  trial: Trial,
): Promise<Scored> => runScorer(lab, scorer, info, trial);

/** What every score of a trial records about it, whole or partial. */
function scoreOf(
  lab: Lab,
  dataset: string,
  scorer: Subject<ScorerSettings>,
  info: CaseInfo,
  trial: Trial,
) {
  const now = (lab.now ?? (() => new Date()))();
  return {
    at: now.toISOString(),
    scorer: identityOf(scorer),
    dataset,
    case: { id: info.id, digest: info.digest },
    trial: trial.id,
    key: { revision: info.key.revision, procedure: info.key.procedure, digest: digestOf(info.key) },
  };
}

/** Scores a trial in a fresh checkout and keeps the score, or why it failed. */
async function scoreTrial(
  lab: Lab,
  dataset: string,
  scorer: Subject<ScorerSettings>,
  info: CaseInfo,
  trial: Trial,
): Promise<Score> {
  const made = { format: SCORED_FORMAT, ...scoreOf(lab, dataset, scorer, info, trial) } as const;
  const dir = trialDir(lab.workspace.results, trial);
  const nothing =
    trial.failure ?? (trial.findings.length === 0 ? "the trial found nothing" : undefined);
  if (nothing) {
    const score: Score = {
      ...made,
      result: {
        status: "scored",
        judgement: { format: SCORER_RESULT_FORMAT, labels: [], missed: nothing },
      },
    };
    writeScore(dir, score);
    return score;
  }
  const score: Score = { ...made, ...(await runScorer(lab, scorer, info, trial)) };
  writeScore(dir, score);
  return score;
}

/**
 * Scores the `asked` findings of a trial, the rest-from score's labels handed to the scorer as
 * settled for the rest, and keeps it as a partial score, never counted.
 */
async function scoreChosen(
  lab: Lab,
  dataset: string,
  scorer: Subject<ScorerSettings>,
  info: CaseInfo,
  trial: Trial,
  chosen: { picked: readonly number[]; asked: readonly number[]; restFrom: ScoreOnFile },
): Promise<PartialScore> {
  const { picked, asked, restFrom } = chosen;
  if (restFrom.result.status !== "scored") throw new Error("a rest-from score must have passed");
  const settled = restFrom.result.judgement.labels.filter(
    (label) => !asked.includes(label.finding),
  );
  const made = scoreOf(lab, dataset, scorer, info, trial);
  const scored = await runScorer(lab, scorer, info, trial, settled);
  // A run that failed before any agent ran is the scorer refusing its arguments, `--settled` most
  // likely: it cost nothing and says nothing about the findings, so it is reported, not kept. Labels
  // that fail their check are a result, and are kept.
  if (scored.run?.outcome !== "succeeded" && (scored.run?.models.length ?? 0) === 0) {
    throw new Error(
      `${scorer.label} failed before any agent ran, so it may not take --settled: ${scored.run?.error ?? "no detail"}`,
    );
  }
  const partial: PartialScore = {
    format: PARTIAL_SCORE_FORMAT,
    ...made,
    ...scored,
    picked: [...picked],
    asked: [...asked],
    restFrom: { scorer: restFrom.scorer, at: restFrom.at, digest: restFrom.digest },
  };
  writePartial(trialDir(lab.workspace.results, trial), partial);
  return partial;
}

/** A partial score's labels beside its rest-from score's; `now` is null when it failed. */
function comparison(
  partial: PartialScore,
  restFrom: Score,
  address: (finding: number) => string,
): ComparedFinding[] {
  if (restFrom.result.status !== "scored") return [];
  const { labels, votes = [] } = restFrom.result.judgement;
  const now = partial.result.status === "scored" ? partial.result.judgement.labels : null;
  return partial.asked.map((finding) => ({
    id: address(finding),
    named: partial.picked.includes(finding),
    was: categoryOf(labels[finding]!),
    votes: votes.flatMap((vote) => {
      const label = vote.labels.find((l) => l.finding === finding);
      return label ? [{ by: vote.by, label: categoryOf(label) }] : [];
    }),
    now: now ? categoryOf(now[finding]!) : null,
  }));
}

/** A line per finding scored, and how often a named one's new label sided with the rest-from score or its voters. */
function describeComparison(compared: readonly ComparedFinding[]): string[] {
  const lines = compared.map((c) => {
    const votes =
      c.votes.length > 0 ? ` (${c.votes.map((v) => `${v.by} ${v.label}`).join(", ")})` : "";
    const again = c.named ? "" : " (asked again: its label depended on a named one)";
    return `${c.id}: was ${c.was}${votes}, now ${c.now ?? "not scored"}${again}`;
  });
  const named = compared.filter((c) => c.named);
  const scored = named.filter((c) => c.now !== null);
  const same = scored.filter((c) => c.now === c.was).length;
  const voter = scored.filter(
    (c) => c.now !== c.was && c.votes.some((v) => v.label === c.now),
  ).length;
  lines.push(
    `${scored.length} of ${named.length} named findings scored: ${same} as before, ${voter} as one of its voters, ${scored.length - same - voter} as neither`,
  );
  return lines;
}

const spendOf = (run: RunSummary | undefined) =>
  run ? `${duration(run.ms)} ${usd(run.estimate)}` : "no run";

/** What became of each step that ran, by the step's address. */
export type Outcomes = {
  trials: Map<string, Trial>;
  scores: Map<string, Score | PartialScore>;
  errors: Map<string, string>;
};

/**
 * Runs the plan in two phases: every trial, then every score, each `jobs` steps at a time (one by
 * default), so a scorer never runs beside a trial. Every record is kept as it is made, so a stop
 * loses nothing, and running again resumes. With a budget, a step starts only if its estimate, the
 * mean of what such steps cost so far, fits beside what the finished steps came to and what the running steps are
 * estimated at; if it doesn't, it waits for running steps, and the run stops only when it still
 * doesn't fit with nothing running. With no estimate yet, a step waits until nothing else runs,
 * then starts while the spend is under the budget. An unpriced run counts as nothing, and says so.
 * Exit codes: 0 done, 1 a failure (a score that failed, or a case that could not be run), 3
 * stopped by the budget with no failure.
 */
export async function executePlan(
  lab: Lab,
  options: {
    dataset: string;
    scorer: Subject<ScorerSettings>;
    cases: readonly CaseInfo[];
    planned: Planned;
    budget?: number;
    /** What earlier plans of the same run came to, counted against the budget. */
    spent?: number;
    jobs?: number;
  },
): Promise<{
  exitCode: 0 | 1 | 3;
  listPrice: number;
  stopped: boolean;
  compared: ComparedFinding[];
  outcomes: Outcomes;
}> {
  const { dataset, scorer, planned, budget, jobs = 1 } = options;
  const compared: ComparedFinding[] = [];
  const outcomes: Outcomes = { trials: new Map(), scores: new Map(), errors: new Map() };
  const history = {
    trial: new Map(planned.variants.map((v) => [v.variant.label, [...v.trialHistory]])),
    score: [...planned.scoreHistory],
  };
  let listPrice = options.spent ?? 0;
  let reserved = 0;
  let running = 0;
  let failed = false;
  let stopped = false;
  const waiting: (() => void)[] = [];
  const historyOf = (phase: "trial" | "score", variant: string) =>
    phase === "trial" ? history.trial.get(variant)! : history.score;
  /** Reserves the step's estimate once it fits, or stops the run when it never can. */
  const admit = async (
    phase: "trial" | "score",
    variant: string,
    what: string,
  ): Promise<number | null> => {
    for (;;) {
      if (stopped) return null;
      const estimate = budget === undefined ? 0 : estimateOf(historyOf(phase, variant));
      const fits =
        budget === undefined ||
        (estimate === null
          ? running === 0 && listPrice < budget
          : listPrice + reserved + estimate <= budget);
      if (fits) {
        running += 1;
        reserved += estimate ?? 0;
        return estimate ?? 0;
      }
      if (running === 0) {
        stopped = true;
        lab.log(
          `budget: stopped before ${what}; $${listPrice.toFixed(2)} of $${budget} at list prices so far`,
        );
        return null;
      }
      await new Promise<void>((wake) => waiting.push(wake));
    }
  };
  const count = (
    phase: "trial" | "score",
    variant: string,
    held: number,
    run: RunSummary | undefined,
  ) => {
    running -= 1;
    reserved -= held;
    if (run?.id) {
      historyOf(phase, variant).push(run.estimate);
      if (run.estimate === undefined)
        lab.log(`${phase} run ${run.id} was not priced; the budget counts it as $0`);
      listPrice += run.estimate ?? 0;
    }
    for (const wake of waiting.splice(0)) wake();
  };
  /**
   * `jobs` items at a time, in order, and with `key`, never two of one key at once: a case's trials are
   * numbered by when they were made, so its trial n must be made before its trial n + 1.
   */
  const pool = async <T>(
    items: readonly T[],
    work: (item: T) => Promise<void>,
    key?: (item: T) => string,
  ) => {
    const queue = [...items];
    const busy = new Set<string>();
    const freed: (() => void)[] = [];
    const worker = async () => {
      while (!stopped && queue.length > 0) {
        const at = key ? queue.findIndex((item) => !busy.has(key(item))) : 0;
        if (at < 0) {
          await new Promise<void>((wake) => freed.push(wake));
          continue;
        }
        const [item] = queue.splice(at, 1) as [T];
        if (key) busy.add(key(item));
        try {
          await work(item);
        } finally {
          if (key) busy.delete(key(item));
          for (const wake of freed.splice(0)) wake();
        }
      }
    };
    await Promise.all(Array.from({ length: jobs }, worker));
  };
  const infoOf = (id: string) => options.cases.find((c) => c.id === id)!;
  const steps = planned.variants.flatMap(({ variant, steps }) =>
    steps.map((step) => ({ variant, step, id: stepAddress(planned, variant.label, step) })),
  );

  await pool(
    steps.filter(({ step }) => step.trial.do === "run"),
    async ({ variant, step, id }) => {
      const info = infoOf(step.case);
      const held = await admit("trial", variant.label, `the trial of ${id}`);
      if (held === null) return;
      let trial: Trial | undefined;
      try {
        trial = await runTrial(lab, dataset, variant, info);
        outcomes.trials.set(id, trial);
        lab.log(
          `${id}: trial ${trial.run.outcome}, ${trial.findings.length} findings, ${spendOf(trial.run)}${trial.failure ? ` — ${trial.failure}` : ""}`,
        );
      } catch (error) {
        failed = true;
        outcomes.errors.set(id, String(error));
        lab.log(`${id}: ${String(error)}`);
      } finally {
        count("trial", variant.label, held, trial?.run);
      }
    },
    ({ variant, step }) => `${variant.key}\n${step.case}`,
  );

  const toScore = steps.flatMap(({ variant, step, id }) => {
    const { score: next } = step;
    const address = (finding: number) => stepAddress(planned, variant.label, step, finding);
    if (next.do === "reuse" || next.do === "skip") return [];
    if (next.do === "reuse-partial") {
      compared.push(...comparison(next.record, next.restFrom, address));
      return [];
    }
    const trial = step.trial.do === "reuse" ? step.trial.trial : outcomes.trials.get(id);
    const chosen =
      next.do === "partial"
        ? { picked: next.picked, asked: next.asked, restFrom: next.restFrom }
        : undefined;
    return trial ? [{ id, info: infoOf(step.case), trial, chosen, address }] : [];
  });
  await pool(toScore, async ({ id, info, trial, chosen, address }) => {
    const nothing = !chosen && (trial.failure !== undefined || trial.findings.length === 0);
    // Nothing to score is a record without a run: no cost, no slot.
    const held = nothing ? 0 : await admit("score", "", `scoring ${id}`);
    if (held === null) return;
    let score: Score | PartialScore | undefined;
    try {
      score = chosen
        ? await scoreChosen(lab, dataset, scorer, info, trial, chosen)
        : await scoreTrial(lab, dataset, scorer, info, trial);
      outcomes.scores.set(id, score);
      if (chosen && score.format === PARTIAL_SCORE_FORMAT)
        compared.push(...comparison(score, chosen.restFrom, address));
      if (score.result.status === "failed") failed = true;
      const outcome =
        score.result.status === "scored"
          ? "scored"
          : `failed, ${score.result.reason}${score.result.problems[0] ? `: ${score.result.problems[0]}` : ""}`;
      lab.log(`${id}: score ${outcome}, ${spendOf(score.run)}`);
    } catch (error) {
      failed = true;
      outcomes.errors.set(id, String(error));
      lab.log(`${id}: ${String(error)}`);
    } finally {
      if (!nothing) count("score", "", held, score?.run);
    }
  });
  if (compared.length > 0) for (const line of describeComparison(compared)) lab.log(line);
  return { exitCode: failed ? 1 : stopped ? 3 : 0, listPrice, stopped, compared, outcomes };
}
