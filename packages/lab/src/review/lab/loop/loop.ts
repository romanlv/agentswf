import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { digestOf } from "../../fixtures/seal";
import { checkSchema, describeProblems } from "../../format/validate";
import type { ScorerSettings, VariantSettings } from "../../format/variant";
import { runAgainst } from "../against";
import { type CaseInfo, type Lab, type Subject, statesOf } from "../execute";
import { currentTrials } from "../plan";
import type { ReportComparison } from "../report";
import { summaryOf } from "../runner";
import { keyOf } from "../version";
import { writeBundle } from "./bundle";
import {
  FINAL_FORMAT,
  type Final,
  type Hypothesis,
  HypothesisSchema,
  LOOP_FORMAT,
  type Loop,
  LoopSchema,
  TRY_FORMAT,
  type Try,
  TrySchema,
} from "./format";
import { outOfScope } from "./scope";

export const PROPOSER = join(import.meta.dir, "propose.workflow.ts");

/** How many tries in a row without a keep end a loop: the stall a person should look at. */
const STALL = 3;

export type LoopSetting = {
  lab: Lab;
  dataset: string;
  /** Tuning cases in the seeded order, and the dataset's entries for them. */
  cases: readonly CaseInfo[];
  entries: readonly { id: string; at: string }[];
  holdout: readonly string[];
  trials: number;
  scorer: Subject<ScorerSettings>;
  comparison: ReportComparison;
  jobs?: number;
  /** What a try is judged by, for the proposer: resolution, models, and so on. */
  rules: Record<string, unknown>;
};

export type LoopRequest = {
  name: string;
  rounds: number;
  /** The first incumbent, as loaded from its file. */
  start: Subject<VariantSettings>;
  /** Only when the loop starts: the start's workflow file, the program, the cap. */
  create?: { source: string; program: string; cap: number };
  /** Absent, the loop's own; a resumed loop refuses another. */
  proposer?: string;
};

export type LoopOutcome = { exitCode: 0 | 1 | 3; why: string; tries: Try[] };

export function loopDir(lab: Lab, dataset: string, name: string): string {
  return join(lab.workspace.results, dataset, "loops", name);
}

/**
 * Tries until the rounds, the cap or a stall: the proposer writes a candidate from the incumbent's
 * tuning feedback, its scope is checked, it runs against the incumbent until the comparison stops,
 * and it becomes the incumbent only on `better`. Every try is written once, so a loop resumes
 * where it stopped, its spend summed from its own records.
 */
export async function runLoop(setting: LoopSetting, request: LoopRequest): Promise<LoopOutcome> {
  const { lab, dataset } = setting;
  const dir = loopDir(lab, dataset, request.name);
  const loop = await startOrResume(setting, request, dir);
  const tries = readTries(dir);
  const { start } = request;
  if (start.key !== loop.start.variant) {
    throw new Error(`loop ${loop.name} started from ${loop.start.variant}; name it as the start`);
  }
  let incumbent = start;
  let source = join(dir, "start.ts");
  for (const t of tries.filter((t) => t.decision === "kept")) {
    source = join(dir, "tries", String(t.n), "candidate", "workflow.ts");
    incumbent = candidateOf(
      setting,
      start,
      t.candidate.slice(0, t.candidate.lastIndexOf("@")),
      source,
    );
  }
  let spent = tries.reduce((sum, t) => sum + t.spend.proposer + t.spend.trials, 0);
  const proposers = tries.map((t) => t.spend.proposer).filter((usd) => usd > 0);
  const tuningText = setting.cases.flatMap((c) => c.key.issues.map((issue) => issue.mechanism));
  const tuningPaths = setting.cases.flatMap((c) =>
    c.key.issues.flatMap((issue) => issue.locations.map((l) => l.path)),
  );
  for (let round = 0; round < request.rounds; round += 1) {
    const left = loop.cap.usd - spent;
    if (left <= 0) return { exitCode: 3, why: `the cap of $${loop.cap.usd} is spent`, tries };
    const recent = tries.slice(-STALL);
    if (recent.length === STALL && recent.every((t) => t.decision !== "kept")) {
      return {
        exitCode: 0,
        why: `${STALL} tries in a row kept nothing: look before spending more`,
        tries,
      };
    }
    const n = tries.length + 1;
    const tryDir = join(dir, "tries", String(n));
    const candidateDir = join(tryDir, "candidate");
    // A try cut short before its record holds nothing decided: it starts again from nothing.
    rmSync(tryDir, { recursive: true, force: true });
    mkdirSync(candidateDir, { recursive: true });
    const scored = await writeBundle(join(tryDir, "bundle"), {
      workspace: lab.workspace,
      dataset,
      incumbent,
      source,
      program: join(dir, "program.md"),
      scorer: setting.scorer,
      cases: setting.cases,
      trials: setting.trials,
      history: tries,
      rules: { ...setting.rules, spendLeft: Number(left.toFixed(2)) },
    });
    if (scored === 0) {
      return {
        exitCode: 1,
        why: `${incumbent.label} has no scored trial on a tuning case to learn from: run it first, e.g. awf-lab run ${incumbent.label} --cases 8`,
        tries,
      };
    }
    const decided = (
      fields: Omit<Try, "format" | "n" | "at" | "parent" | "candidate">,
      candidate = keyOf({ name: `${request.name}-${n}`, version: "1.0.0" }),
    ) => {
      const record: Try = {
        format: TRY_FORMAT,
        n,
        at: (lab.now ?? (() => new Date()))().toISOString(),
        parent: incumbent.key,
        candidate,
        ...fields,
      };
      writeFileSync(join(tryDir, "try.json"), `${JSON.stringify(record, null, 2)}\n`, {
        flag: "wx",
      });
      tries.push(record);
      spent += record.spend.proposer + record.spend.trials;
      lab.log(`try ${n}: ${record.decision}: ${record.why}`);
      return record;
    };
    lab.log(`try ${n}: proposing against ${incumbent.label}, $${left.toFixed(2)} left`);
    const spec = join(tryDir, "sandbox.json");
    writeFileSync(spec, JSON.stringify({ srt: {}, write: [candidateDir] }));
    const proposed = await lab.runner({
      workflow: PROPOSER,
      cwd: tryDir,
      timeout: "30m",
      argv: ["--runtime", loop.proposer],
      runRoot: lab.workspace.runs,
      sandbox: spec,
    });
    const priced = summaryOf(proposed).estimate;
    // Unpriced, it counts as the earlier proposers' mean, never as free.
    const proposer =
      priced ??
      (proposers.length > 0 ? proposers.reduce((a, b) => a + b, 0) / proposers.length : 0);
    if (priced === undefined)
      lab.log(`try ${n}: the proposer's run is unpriced; counted as $${proposer.toFixed(2)}`);
    if (priced !== undefined && priced > 0) proposers.push(priced);
    const value = proposed.record?.outcome === "succeeded" ? proposed.record.value : undefined;
    const checked = checkSchema(HypothesisSchema, value);
    if (!checked.ok) {
      decided({
        decision: "failed",
        why:
          proposed.record?.outcome === "succeeded"
            ? describeProblems("the proposer's answer", checked.problems)
            : `the proposer's run ${proposed.record?.outcome ?? "never started"}: ${proposed.record?.error ?? proposed.stderr.trim().split("\n").at(-1) ?? ""}`,
        spend: { proposer, trials: 0 },
      });
      continue;
    }
    const hypothesis: Hypothesis = checked.value;
    const problems = outOfScope(candidateDir, tuningPaths, tuningText);
    if (problems.length > 0) {
      decided({
        decision: "refused",
        why: problems.join("; "),
        hypothesis,
        spend: { proposer, trials: 0 },
      });
      continue;
    }
    const file = join(candidateDir, "workflow.ts");
    // Named by its code: a try redone after a cut never counts the earlier code's trials.
    const candidate = candidateOf(
      setting,
      start,
      `${request.name}-${n}-${shortDigest(file)}`,
      file,
    );
    const result = await runAgainst(lab, {
      dataset,
      trials: setting.trials,
      challenger: candidate,
      baseline: incumbent,
      scorer: setting.scorer,
      cases: setting.cases,
      entries: setting.entries,
      comparison: setting.comparison,
      budget: Math.max(0, left - proposer),
      ...(setting.jobs === undefined ? {} : { jobs: setting.jobs }),
    });
    const { verdict } = result;
    const trials = result.listPrice;
    // The cap cut it short: decided by nothing, so the loop stops. A case that couldn't be made
    // whole is the candidate's failure, most often a workflow that doesn't run: the next try goes on.
    const capped = result.exitCode === 3 && !verdict?.stop;
    const broken = result.exitCode === 1 && !verdict?.stop;
    const errors = [...result.outcomes.errors]
      .filter(([id]) => id.includes(candidate.label))
      .map(([, error]) => String(error));
    const record = decided(
      {
        decision: capped
          ? "unfinished"
          : broken
            ? "failed"
            : verdict?.verdict === "better"
              ? "kept"
              : "discarded",
        why: broken
          ? `a case couldn't be made whole: ${errors[0] ?? "see the trial records"}`
          : verdict
            ? `${verdict.verdict}${verdict.stop ? "" : ", not stopped"}: ${verdict.reason}`
            : "no case was whole for both",
        hypothesis,
        ...(verdict ? { verdict } : {}),
        spend: { proposer, trials },
      },
      candidate.key,
    );
    if (record.decision === "kept") {
      incumbent = candidate;
      source = file;
    }
    if (capped) return { exitCode: 3, why: `the cap ended try ${n}: ${record.why}`, tries };
  }
  return { exitCode: 0, why: `${request.rounds} rounds run`, tries };
}

/**
 * The final check: the loop's last kept candidate against its start, on the held-out cases, which
 * no try saw. Its trials there are the first either has, so they are fresh; a second check reuses
 * them, and its record shows it was asked twice.
 */
export async function runFinal(
  setting: LoopSetting & {
    held: readonly CaseInfo[];
    heldEntries: readonly { id: string; at: string }[];
  },
  request: { name: string; start: Subject<VariantSettings>; budget: number },
): Promise<{ exitCode: 0 | 1 | 3; why: string }> {
  const { lab, dataset } = setting;
  const dir = loopDir(lab, dataset, request.name);
  if (!existsSync(join(dir, "loop.json"))) throw new Error(`no loop ${request.name}`);
  const loop = await startOrResume(
    setting,
    { name: request.name, rounds: 0, start: request.start },
    dir,
  );
  if (request.start.key !== loop.start.variant) {
    throw new Error(`loop ${loop.name} started from ${loop.start.variant}; name it as the start`);
  }
  const kept = readTries(dir)
    .filter((t) => t.decision === "kept")
    .at(-1);
  if (!kept)
    return { exitCode: 1, why: `loop ${loop.name} kept nothing: there is no incumbent to check` };
  const file = join(dir, "tries", String(kept.n), "candidate", "workflow.ts");
  const incumbent = candidateOf(
    setting,
    request.start,
    kept.candidate.slice(0, kept.candidate.lastIndexOf("@")),
    file,
  );
  // Trials either already has on a held-out case, from before the holdout or an earlier check.
  let reused = 0;
  for (const subject of [incumbent, request.start]) {
    for (const state of await statesOf(lab.workspace, dataset, subject.key, setting.held)) {
      reused += currentTrials(state).length;
    }
  }
  const result = await runAgainst(lab, {
    dataset,
    trials: setting.trials,
    challenger: incumbent,
    baseline: request.start,
    scorer: setting.scorer,
    cases: setting.held,
    entries: setting.heldEntries,
    comparison: { ...setting.comparison, planned: setting.held.length },
    budget: request.budget,
    ...(setting.jobs === undefined ? {} : { jobs: setting.jobs }),
  });
  const finals = join(dir, "finals");
  mkdirSync(finals, { recursive: true });
  const k = readdirSync(finals).filter((f) => f.endsWith(".json")).length + 1;
  const { verdict } = result;
  const why = verdict
    ? `${verdict.verdict}${verdict.stop ? "" : ", not stopped"}: ${verdict.reason}`
    : "no held-out case was whole for both";
  const record: Final = {
    format: FINAL_FORMAT,
    k,
    at: (lab.now ?? (() => new Date()))().toISOString(),
    incumbent: incumbent.key,
    start: request.start.key,
    cases: setting.held.map((c) => c.id),
    ...(verdict ? { verdict } : {}),
    why,
    reused,
    spend: result.listPrice,
  };
  writeFileSync(join(finals, `${k}.json`), `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
  const before = [
    ...(k > 1 ? [`checked ${k - 1} time${k > 2 ? "s" : ""} before`] : []),
    ...(reused > 0 ? [`${reused} held-out trials were on file, not fresh`] : []),
  ];
  return {
    exitCode: result.exitCode,
    why: `final check ${k}${before.length > 0 ? ` (${before.join("; ")})` : ""}: ${incumbent.label} against ${request.start.label}: ${why}`,
  };
}

/**
 * A try's candidate as a variant: the start's settings, its workflow file, never imported here. The
 * file runs only where `awf run` runs it, in the workspace's container.
 */
function candidateOf(
  setting: LoopSetting,
  start: Subject<VariantSettings>,
  name: string,
  file: string,
): Subject<VariantSettings> {
  return {
    name,
    label: name,
    version: "1.0.0",
    key: keyOf({ name, version: "1.0.0" }),
    commit: null,
    file,
    defined: {
      ...start.defined!,
      version: "1.0.0",
      tunedOn: { fixtures: setting.cases.map((c) => c.id) },
    },
  };
}

const shortDigest = (file: string) => digestOf(readFileSync(file, "utf8")).slice(7, 15);

async function startOrResume(
  setting: LoopSetting,
  request: LoopRequest,
  dir: string,
): Promise<Loop> {
  const file = join(dir, "loop.json");
  if (existsSync(file)) {
    const checked = checkSchema(LoopSchema, await Bun.file(file).json());
    if (!checked.ok) throw new Error(describeProblems(file, checked.problems));
    const loop = checked.value;
    const now = {
      holdout: JSON.stringify([...setting.holdout].sort()),
      scorer: setting.scorer.key,
      comparison: `${setting.comparison.name} ${setting.comparison.comparison.version}`,
      trials: String(setting.trials),
      proposer: request.proposer ?? loop.proposer,
      source: digestOf(readFileSync(loop.start.source, "utf8")),
    };
    const then = {
      holdout: JSON.stringify(loop.holdout),
      scorer: loop.scorer,
      comparison: `${loop.comparison.name} ${loop.comparison.version}`,
      trials: String(loop.trials),
      proposer: loop.proposer,
      source: loop.start.digest,
    };
    const moved = (Object.keys(now) as (keyof typeof now)[]).filter((k) => now[k] !== then[k]);
    if (moved.length > 0) {
      throw new Error(
        `loop ${loop.name} was started with another ${moved.join(", ")}: ${moved.map((k) => `${then[k]}, now ${now[k]}`).join("; ")}; a loop's tries are judged alike`,
      );
    }
    return loop;
  }
  const start = request.create;
  if (!start) throw new Error(`no loop ${request.name}: start one with --program and --source`);
  if (!("container" in setting.lab.workspace.sandbox)) {
    throw new Error(
      'a loop runs workflows nobody wrote: the workspace\'s sandbox must be { "container": … }',
    );
  }
  mkdirSync(dir, { recursive: true });
  copyFileSync(start.program, join(dir, "program.md"));
  copyFileSync(start.source, join(dir, "start.ts"));
  const loop: Loop = {
    format: LOOP_FORMAT,
    name: request.name,
    dataset: setting.dataset,
    started: (setting.lab.now ?? (() => new Date()))().toISOString(),
    start: {
      variant: request.start.key,
      source: start.source,
      digest: digestOf(readFileSync(start.source, "utf8")),
    },
    scorer: setting.scorer.key,
    comparison: {
      name: setting.comparison.name,
      version: setting.comparison.comparison.version,
    },
    trials: setting.trials,
    cap: { usd: start.cap },
    proposer: request.proposer ?? "codex/gpt-6-sol",
    program: digestOf(await Bun.file(start.program).text()),
    holdout: [...setting.holdout].sort(),
  };
  writeFileSync(file, `${JSON.stringify(loop, null, 2)}\n`, { flag: "wx" });
  return loop;
}

function readTries(dir: string): Try[] {
  const root = join(dir, "tries");
  if (!existsSync(root)) return [];
  const tries: Try[] = [];
  for (const entry of readdirSync(root)) {
    const file = join(root, entry, "try.json");
    // A try with no record was cut short before it was decided: proposed again under its number.
    if (!existsSync(file)) continue;
    const checked = checkSchema(TrySchema, JSON.parse(readFileSync(file, "utf8")));
    if (!checked.ok) throw new Error(describeProblems(file, checked.problems));
    tries.push(checked.value);
  }
  return tries.toSorted((a, b) => a.n - b.n);
}
