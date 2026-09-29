#!/usr/bin/env -S bun --no-env-file
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { SET_FILE } from "../fixtures/set";
import { CATEGORIES, type Category, SEVERITIES } from "../format/format";
import {
  LIST_FORMAT,
  type ListDocument,
  RUN_FORMAT,
  type RunDocument,
  SCHEMAS_FORMAT,
  type SchemasDocument,
} from "../format/output";
import type { PartialScore, Score } from "../format/records";
import { formatOf, renderSchemaFile, SCHEMA_FILES, type SchemaName } from "../format/schema-files";
import type { DefinedScorer, DefinedVariant } from "../format/variant";
import { type Address, formatAddress, parseAddress } from "./address";
import {
  type CaseInfo,
  datasetCases,
  describePlan,
  estimateOfPlan,
  executePlan,
  type Lab,
  type Outcomes,
  type Planned,
  planRun,
  readCases,
  type Subject,
  statesOf,
  stepAddress,
} from "./execute";
import { loadScorer, loadVariant } from "./load";
import { fill } from "./placeholders";
import { type Choice, currentTrial, PlanError, passingScore, type Stored } from "./plan";
import { provenanceOf } from "./provenance";
import {
  ANSI,
  buildReport,
  caseMetrics,
  compareCases,
  type Paint,
  PLAIN,
  plural,
  type ReportSubject,
  renderMarkdown,
  renderReport,
} from "./report";
import { awfRunner, type Runner } from "./runner";
import { selectCases } from "./selection";
import { buildShow, renderShow } from "./show";
import { inventory, runDirOf } from "./store";
import { checkVersion, covers, DEFAULT_VERSION, keyOf, parseKey, seriesOf } from "./version";
import {
  type CaseView,
  choose,
  describePredicate,
  PREDICATES,
  type Predicate,
  parsePredicate,
} from "./where";
import {
  findConfig,
  openWorkspace,
  RenamedConfigKeys,
  resolveFile,
  type Workspace,
} from "./workspace";

const USAGE = `usage: awf-lab [--config {file}] {command} … [--json]

  list [datasets|cases|variants|scorers]
                            what the workspace sees: names, files, versions, stored versions
  run {variant…} [selection] [--dry-run] [--budget {usd}] [--jobs {n}] [--yes]
                            the missing trials of the selection, then their scores
  score {variant…} [selection] [--rest-from {scorer}] [--dry-run] [--budget …] [--jobs …] [--yes]
                            scores stored trials, whole or chosen findings; never runs a variant
  report {variant…} [selection] [--baseline {variant}] [--categories {a,b}] [--md]
                            metrics side by side; with two --scorer, how alike they label
  show {variant} {address} [--scorer {name}]…
                            one case, trial or finding in full
  schema [{format}]         the JSON Schema of a record or of a command's --json

selection, the same on every command:
  --dataset {name}          the dataset; the config gives the default
  --cases {n}|{id},…        n cases of a seeded order, or cases by id or glob
  --only {address},…        {case}, {case}/{trial}, {case}#{finding}; {variant}: before any
  --where {predicate}       ${PREDICATES}; repeated, all hold
  --trials {n}              trials per case; 1 until variant-matrix-runner
  --scorer {name}           the scorer; the config gives the default; report and show take two
  --baseline {variant}      what report compares against, and --where lost reads

A variant or scorer is a name, a file, or {name}@{version} for a stored version: 1.2, or 1.
--jobs runs that many steps at a time: every trial, then every score.
exit: 0 done, 1 a failure, 2 a usage error, 3 stopped by the budget, 4 the plan was declined`;

class UsageError extends Error {}
class HelpRequested extends Error {}

/** The first command line's flags and commands, each refused with what replaced it. */
const RENAMED_FLAGS: Readonly<Record<string, string>> = {
  "--set": "--dataset",
  "--fixtures": "--cases",
  "--judge": "--scorer",
  "--base": "--rest-from",
  "--repeats": "--trials",
  "--judge-only": "the score command",
};
const RENAMED_COMMANDS: Readonly<Record<string, string>> = {
  config: "list",
  plan: "run --dry-run, or score --dry-run",
};

type Options = {
  config?: string;
  dataset?: string;
  cases?: string;
  only?: Address[];
  where: Predicate[];
  trials?: number;
  scorers: string[];
  restFrom?: string;
  baseline?: string;
  budget?: number;
  jobs?: number;
  categories?: Category[];
  dryRun: boolean;
  yes: boolean;
  json: boolean;
  md: boolean;
};

export type LabEnvironment = {
  cwd?: string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  runner?: Runner;
  /** Asked before a run spends; absent, a run on a terminal asks the operator. */
  confirm?: (plan: string) => Promise<boolean>;
};

function parse(argv: readonly string[]): { command: string; names: string[]; options: Options } {
  const options: Options = {
    where: [],
    scorers: [],
    dryRun: false,
    yes: false,
    json: false,
    md: false,
  };
  const positional: string[] = [];
  const rest = [...argv];
  const value = (flag: string) => {
    const next = rest.shift();
    if (next === undefined || next.startsWith("--")) throw new UsageError(`${flag} needs a value`);
    return next;
  };
  const whole = (flag: string, text: string) => {
    if (!/^[1-9][0-9]*$/.test(text)) throw new UsageError(`${flag} is a whole number from 1`);
    return Number(text);
  };
  while (rest.length > 0) {
    const arg = rest.shift()!;
    if (Object.hasOwn(RENAMED_FLAGS, arg)) {
      throw new UsageError(`${arg} is now ${RENAMED_FLAGS[arg]}`);
    }
    switch (arg) {
      case "--config":
        options.config = value(arg);
        break;
      case "--dataset":
        options.dataset = value(arg);
        break;
      case "--cases":
        options.cases = value(arg);
        break;
      case "--only":
        options.only = [...(options.only ?? []), ...addressesOf(value(arg))];
        break;
      case "--where":
        try {
          options.where.push(parsePredicate(value(arg)));
        } catch (error) {
          throw new UsageError((error as Error).message);
        }
        break;
      case "--trials":
        options.trials = whole(arg, value(arg));
        break;
      case "--scorer":
        options.scorers.push(value(arg));
        break;
      case "--rest-from":
        options.restFrom = value(arg);
        break;
      case "--baseline":
        options.baseline = value(arg);
        break;
      case "--budget": {
        const text = value(arg);
        const usd = Number(text);
        if (text.trim() === "" || !Number.isFinite(usd) || usd < 0) {
          throw new UsageError("--budget is a sum in USD");
        }
        options.budget = usd;
        break;
      }
      case "--jobs":
        options.jobs = whole(arg, value(arg));
        break;
      case "--categories": {
        const named = value(arg).split(",");
        const unknown = named.filter((c) => !(CATEGORIES as readonly string[]).includes(c));
        if (unknown.length > 0) {
          throw new UsageError(
            `unknown categories ${unknown.join(", ")}; ${CATEGORIES.join(", ")}`,
          );
        }
        options.categories = named as Category[];
        break;
      }
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--yes":
        options.yes = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--md":
        options.md = true;
        break;
      case "--help":
      case "-h":
        throw new HelpRequested();
      default:
        if (arg.startsWith("--")) throw new UsageError(`unknown option ${arg}`);
        positional.push(arg);
    }
  }
  const [command, ...names] = positional;
  if (!command) throw new UsageError("");
  if (Object.hasOwn(RENAMED_COMMANDS, command)) {
    throw new UsageError(`${command} is now ${RENAMED_COMMANDS[command]}`);
  }
  if ((options.trials ?? 1) > 1) {
    throw new UsageError("more than one trial per case comes with variant-matrix-runner");
  }
  return { command, names, options };
}

/** `--only`'s addresses, comma-separated. */
function addressesOf(text: string): Address[] {
  return text.split(",").map((part) => {
    const address = parseAddress(part);
    if (!address) {
      throw new UsageError(
        `--only takes {case}, {case}/{trial}, {case}#{finding}, with {variant}: before any; not ${part}`,
      );
    }
    return address;
  });
}

/** A name or path the operator gave that names nothing is their mistake, not a failure. */
function named<T>(find: () => T): T {
  try {
    return find();
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
}

type Inventory = Awaited<ReturnType<typeof inventory>>;

/**
 * A variant or scorer as a command names it: `{name}` or a file is the file as it is now;
 * `{name}@{version}` is a stored version, a prefix such as `1` or `1.2` being enough: the file's
 * when it still declares it, otherwise known only by its records.
 */
async function subjectOf<D extends DefinedVariant | DefinedScorer>(
  workspace: Workspace,
  kind: "variant" | "scorer",
  text: string,
  cwd: string,
  stored: () => Promise<Inventory>,
): Promise<Subject<D>> {
  const at = text.includes("/") ? -1 : text.lastIndexOf("@");
  const [nameOrPath, prefix] = at > 0 ? [text.slice(0, at), text.slice(at + 1)] : [text, undefined];
  const known = kind === "variant" ? workspace.variants : workspace.scorers;
  let current: Subject<D> | undefined;
  let missing: Error | undefined;
  let found: { name: string; file: string } | undefined;
  try {
    found = resolveFile(known, nameOrPath, cwd, kind);
  } catch (error) {
    if (prefix === undefined) throw new UsageError((error as Error).message);
    missing = error as Error;
  }
  // A file that names something but fails to load is a failure, not a usage error, unless a
  // stored version was asked for: its records need no file.
  try {
    if (!found) throw missing;
    const { name, file } = found;
    const defined = (kind === "variant" ? await loadVariant(file) : await loadScorer(file)) as D;
    if (kind === "variant") {
      try {
        fill(defined.argv, { base: "", head: "", request: "", dataset: "" });
      } catch (error) {
        throw new UsageError(`${file}: ${(error as Error).message}`);
      }
    }
    const version = defined.version ?? DEFAULT_VERSION;
    const bad = checkVersion(version);
    if (bad) throw new UsageError(`${file}: ${bad}`);
    const { commit } = await provenanceOf(file);
    current = {
      name,
      label: prefix === undefined ? name : text,
      version,
      key: keyOf({ name, version }),
      commit,
      file,
      defined,
    };
  } catch (error) {
    if (error instanceof UsageError || prefix === undefined) throw error;
    missing = error as Error;
  }
  if (prefix === undefined) return current!;
  if (!/^\d+(\.\d+){0,2}$/.test(prefix)) {
    throw new UsageError(
      `${text}: ${prefix} is not a version: {major}, {major}.{minor} or all three`,
    );
  }
  if (current && covers(seriesOf(current.version), prefix)) return current;
  const inventory = await stored();
  const versions = [...(kind === "variant" ? inventory.variants : inventory.scorers)].filter(
    ([key]) => {
      const parsed = parseKey(key);
      return parsed?.name === nameOrPath && covers(parsed.series, prefix);
    },
  );
  if (versions.length !== 1) {
    const why =
      versions.length === 0
        ? `no stored version of ${nameOrPath} matches ${prefix}`
        : `${prefix} names ${versions.length} versions of ${nameOrPath}: ${versions.map(([k]) => k).join(", ")}`;
    throw new UsageError(
      `${why}; list ${kind}s shows them${missing ? ` (${missing.message})` : ""}`,
    );
  }
  const [key, record] = versions[0]!;
  return {
    name: nameOrPath,
    label: text,
    version: record.version,
    key,
    commit: record.commit,
  };
}

/** The seeded order's key for a case id. */
export function rankOf(seed: string): (id: string) => string {
  return (id) => createHash("sha256").update(`${seed}\n${id}`).digest("hex");
}

/** The dataset, and its case ids in the seeded order, narrowed by `--cases`. */
async function selectedCases(workspace: Workspace, options: Options) {
  const dataset = options.dataset ?? workspace.config.dataset;
  if (!existsSync(join(workspace.datasets, dataset, SET_FILE))) {
    throw new UsageError(
      `no dataset ${dataset}: ${join(workspace.datasets, dataset, SET_FILE)} is missing`,
    );
  }
  const { entries } = await datasetCases(workspace, dataset);
  const all = entries.map((e) => e.id);
  const ids = named(() =>
    selectCases(all, options.cases, rankOf(workspace.config.seed ?? "awf-lab")),
  );
  for (const address of options.only ?? []) {
    if (!all.includes(address.case)) {
      throw new UsageError(`${formatAddress(address)}: ${address.case} is not in ${dataset}`);
    }
    if ((address.trial ?? 1) > 1) {
      throw new UsageError(
        `${formatAddress(address)}: one trial per case until variant-matrix-runner, so only /1`,
      );
    }
  }
  return { dataset, ids, entries };
}

/** Each case as the predicates read it, for one variant: its trial and the reading scorer's score. */
async function viewsOf(
  context: Context,
  variant: Subject<unknown>,
  reading: Subject<unknown>,
  cases: readonly CaseInfo[],
  baseline?: Subject<unknown>,
): Promise<CaseView[]> {
  const { workspace, dataset, options } = context;
  const others = new Map<string, Subject<unknown>>();
  for (const predicate of options.where) {
    if (predicate.kind === "differs" && !others.has(predicate.scorer)) {
      others.set(predicate.scorer, await context.scorer(predicate.scorer));
    }
  }
  const lost = options.where.some((p) => p.kind === "lost");
  if (lost && !baseline) throw new UsageError("--where lost needs a --baseline");
  const states = await statesOf(workspace, dataset, variant.key, cases);
  const theirs = lost ? await statesOf(workspace, dataset, baseline!.key, cases) : [];
  return cases.map((info, index): CaseView => {
    const stored = currentTrial(states[index]!);
    const score = stored && passingScore(stored, reading.key, info.key.revision);
    const view: CaseView = {
      case: info.id,
      ...(stored ? { trial: stored } : {}),
      ...(score ? { score } : {}),
      others: new Map(
        [...others].map(([name, other]) => [
          name,
          stored && passingScore(stored, other.key, info.key.revision),
        ]),
      ),
    };
    if (lost) {
      const other = currentTrial(theirs[index]!);
      const otherScore = other && passingScore(other, reading.key, info.key.revision);
      view.lost =
        stored !== undefined &&
        score !== undefined &&
        other !== undefined &&
        otherScore !== undefined &&
        compareCases(
          caseMetrics(
            stored.trial,
            score,
            info.key,
            options.categories ? { categories: options.categories } : {},
          ),
          caseMetrics(
            other.trial,
            otherScore,
            info.key,
            options.categories ? { categories: options.categories } : {},
          ),
        ) < 0;
    }
    return view;
  });
}

type Context = {
  workspace: Workspace;
  options: Options;
  dataset: string;
  cwd: string;
  variant: (text: string) => Promise<Subject<DefinedVariant>>;
  scorer: (text: string) => Promise<Subject<DefinedScorer>>;
  /** How text for a person is styled, and how wide its lines may run. */
  view: { paint: Paint; width?: number };
};

/** The command's variants, each once: two names for one version would count it twice. */
async function variantsOf(context: Context, names: readonly string[]) {
  const variants: Subject<DefinedVariant>[] = [];
  for (const name of names) {
    const variant = await context.variant(name);
    const same = variants.find((v) => v.key === variant.key);
    if (same) throw new UsageError(`${same.label} and ${variant.label} are the same version`);
    variants.push(variant);
  }
  for (const address of context.options.only ?? []) {
    if (address.variant && !variants.some((v) => v.label === address.variant)) {
      throw new UsageError(
        `${formatAddress(address)}: ${address.variant} is not one of ${variants.map((v) => v.label).join(", ")}`,
      );
    }
  }
  return variants;
}

async function askOperator(plan: string, stderr: (text: string) => void): Promise<boolean> {
  stderr(plan);
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await prompt.question("run it? [y/N] ")).trim());
  } finally {
    prompt.close();
  }
}

const refOf = (subject: Subject<unknown>) => ({ name: subject.label, version: subject.version });
const recordRef = ({ name, version }: { name: string; version: string }) => ({ name, version });

/** The plan as `--json` prints it, and with `result`, what became of each step. */
function runDocument(
  planned: Planned,
  context: {
    dryRun: boolean;
    dataset: string;
    scorer: Subject<unknown>;
    restFrom?: Subject<unknown>;
  },
  result?: {
    exitCode: number;
    listPrice: number;
    stopped: boolean;
    outcomes: Outcomes;
    compared: RunDocument["compared"];
  },
): RunDocument {
  const steps = planned.variants.flatMap(({ variant, steps }) =>
    steps.map((step) => {
      const id = stepAddress(planned, variant.label, step.case);
      const made = result?.outcomes.trials.get(id);
      const error = result?.outcomes.errors.get(id);
      const trial: RunDocument["steps"][number]["trial"] =
        step.trial.do === "run"
          ? {
              do: "run",
              ...(made
                ? { trial: made.id, outcome: made.run.outcome, findings: made.findings.length }
                : {}),
              ...(error && !made ? { why: error } : {}),
            }
          : step.trial.do === "reuse"
            ? {
                do: "reuse",
                trial: step.trial.trial.id,
                findings: step.trial.trial.findings.length,
              }
            : { do: "skip", why: step.trial.why };
      const scored = result?.outcomes.scores.get(id);
      const outcome = scored
        ? {
            status: scored.result.status,
            ...(scored.result.status === "failed" ? { reason: scored.result.reason } : {}),
          }
        : error && made
          ? { status: "failed" as const, reason: error }
          : {};
      const next = step.score;
      const score: RunDocument["steps"][number]["score"] =
        next.do === "partial"
          ? {
              do: next.do,
              picked: next.picked,
              asked: next.asked,
              restFrom: recordRef(next.restFrom.scorer),
              ...outcome,
            }
          : next.do === "reuse-partial"
            ? {
                do: next.do,
                picked: next.record.picked,
                asked: next.record.asked,
                restFrom: recordRef(next.restFrom.scorer),
              }
            : next.do === "record" || next.do === "skip"
              ? { do: next.do, why: next.why, ...outcome }
              : { do: next.do, ...outcome };
      return { id, variant: variant.label, case: step.case, trial, score };
    }),
  );
  return {
    format: RUN_FORMAT,
    command: planned.command,
    dryRun: context.dryRun,
    dataset: context.dataset,
    scorer: refOf(context.scorer),
    ...(context.restFrom ? { restFrom: refOf(context.restFrom) } : {}),
    variants: planned.variants.map(({ variant }) => ({
      name: variant.label,
      version: variant.version,
    })),
    steps,
    estimate: estimateOfPlan(planned),
    ...(result
      ? {
          outcome: {
            exitCode: result.exitCode,
            listPrice: result.listPrice,
            stopped: result.stopped,
          },
          ...(result.compared && result.compared.length > 0 ? { compared: result.compared } : {}),
        }
      : {}),
  };
}

async function runOrScore(
  command: "run" | "score",
  context: Context,
  names: readonly string[],
  lab: Lab,
  environment: LabEnvironment,
  out: { stdout: (text: string) => void; stderr: (text: string) => void },
): Promise<number> {
  const { workspace, options, dataset } = context;
  if (names.length === 0) throw new UsageError(`${command} takes a variant`);
  if (options.scorers.length > 1) throw new UsageError(`${command} takes one --scorer`);
  if (options.restFrom && command === "run") throw new UsageError("--rest-from goes with score");
  const variants = await variantsOf(context, names);
  if (command === "run") {
    for (const v of variants) {
      if (!v.defined) throw new UsageError(`${v.label} is a stored version; only a file can run`);
    }
  }
  const scorer = await context.scorer(options.scorers[0] ?? workspace.config.scorer);
  if (!scorer.defined)
    throw new UsageError(`${scorer.label} is a stored version; only a file can score`);
  const restFrom =
    command === "score"
      ? await context.scorer(options.restFrom ?? workspace.config.scorer)
      : undefined;
  // Only `--where lost` reads the baseline here, so one that fails to load blocks nothing else.
  const baselineName = options.where.some((p) => p.kind === "lost")
    ? (options.baseline ?? workspace.config.baseline)
    : undefined;
  const baseline = baselineName ? await context.variant(baselineName) : undefined;
  const { ids } = await selectedCases(workspace, options);
  const cases = await readCases(workspace, dataset, ids);
  const chosen: { variant: Subject<DefinedVariant>; chosen: Map<string, Choice> }[] = [];
  for (const variant of variants) {
    // On score, the predicates read the scores kept for the rest; --scorer is the one being run.
    const reading = restFrom ?? scorer;
    const views = await viewsOf(context, variant, reading, cases, baseline);
    const picked = choose({
      variant: variant.label,
      cases: views,
      ...(options.only ? { only: options.only } : {}),
      where: options.where,
    });
    chosen.push({
      variant,
      chosen:
        command === "run" ? new Map([...picked.keys()].map((id) => [id, {} as Choice])) : picked,
    });
  }
  let planned: Planned;
  try {
    planned = await planRun(lab, {
      command,
      dataset,
      variants: chosen,
      scorer,
      ...(restFrom ? { restFrom } : {}),
      cases,
    });
  } catch (error) {
    if (error instanceof PlanError) throw new UsageError(error.message);
    throw error;
  }
  const heading = [
    variants.map((v) => `${v.label} ${v.version}`).join(", "),
    `scorer ${scorer.label} ${scorer.version}`,
    ...(restFrom &&
    planned.variants.some((v) =>
      v.steps.some((s) => s.score.do === "partial" || s.score.do === "reuse-partial"),
    )
      ? [`the rest from ${restFrom.label} ${restFrom.version}`]
      : []),
    `dataset ${dataset}`,
  ].join(", ");
  const plan = [heading, ...describePlan(planned)].join("\n");
  const documentContext = { dataset, scorer, ...(restFrom ? { restFrom } : {}) };
  if (options.dryRun) {
    out.stdout(
      options.json
        ? JSON.stringify(runDocument(planned, { ...documentContext, dryRun: true }), null, 2)
        : plan,
    );
    return 0;
  }
  const confirm =
    environment.confirm ??
    (process.stdin.isTTY && !options.yes
      ? (text: string) => askOperator(text, out.stderr)
      : undefined);
  if (confirm && !options.yes && !(await confirm(plan))) {
    out.stderr("declined; nothing run");
    return 4;
  }
  const budget = options.budget ?? workspace.config.budget?.usd;
  const result = await executePlan(lab, {
    dataset,
    scorer,
    cases,
    planned,
    ...(budget === undefined ? {} : { budget }),
    ...(options.jobs === undefined ? {} : { jobs: options.jobs }),
  });
  out.stderr(`$${result.listPrice.toFixed(2)} at list prices, estimated`);
  if (options.json) {
    out.stdout(
      JSON.stringify(runDocument(planned, { ...documentContext, dryRun: false }, result), null, 2),
    );
  }
  return result.exitCode;
}

async function report(context: Context, names: readonly string[]): Promise<string> {
  const { workspace, options, dataset } = context;
  if (names.length === 0) throw new UsageError("report takes a variant");
  if (options.scorers.length > 2) throw new UsageError("report takes one or two --scorer");
  if (options.scorers.length === 2 && options.baseline) {
    throw new UsageError(
      "--baseline compares variants on one scorer; two --scorer compare scorers",
    );
  }
  const scorers = [];
  for (const name of options.scorers.length > 0 ? options.scorers : [workspace.config.scorer]) {
    scorers.push(await context.scorer(name));
  }
  if (scorers.length === 2 && scorers[0]!.key === scorers[1]!.key) {
    throw new UsageError(`${scorers[0]!.label} and ${scorers[1]!.label} are the same version`);
  }
  const variants = await variantsOf(context, names);
  const baselineName =
    scorers.length === 1 ? (options.baseline ?? workspace.config.baseline) : undefined;
  let baseline: Subject<DefinedVariant> | undefined;
  if (baselineName) {
    const named = await context.variant(baselineName);
    baseline = variants.find((v) => v.key === named.key);
    if (!baseline) {
      baseline = named;
      variants.push(named);
    }
  }
  const { ids, entries } = await selectedCases(workspace, options);
  const cases = await readCases(workspace, dataset, ids);
  const reading = scorers[0]!;
  const chosenBy = new Map<Subject<DefinedVariant>, Set<string>>();
  for (const variant of variants) {
    if (variant === baseline && variants.length > 1) continue;
    const views = await viewsOf(context, variant, reading, cases, baseline);
    const picked = choose({
      variant: variant.label,
      cases: views,
      ...(options.only ? { only: options.only } : {}),
      where: options.where.filter((p) => p.kind !== "lost" || variant !== baseline),
    });
    chosenBy.set(variant, new Set(picked.keys()));
  }
  // The baseline is counted on every case another variant was chosen on.
  if (baseline && variants.length > 1) {
    chosenBy.set(baseline, new Set([...chosenBy.values()].flatMap((s) => [...s])));
  }
  const subjects: ReportSubject[] = [];
  for (const variant of variants) {
    const chosen = cases.filter((info) => chosenBy.get(variant)!.has(info.id));
    const states = await statesOf(workspace, dataset, variant.key, chosen);
    subjects.push({
      name: variant.name,
      label: variant.label,
      version: variant.version,
      key: variant.key,
      commit: variant.commit,
      ...(variant.defined?.tunedOn ? { tunedOn: variant.defined.tunedOn } : {}),
      rows: chosen.map((info, index) => ({
        case: info.id,
        digest: info.digest,
        key: info.key,
        at: entries.find((e) => e.id === info.id)?.at ?? info.fixture.request.asOf,
        stored: states[index]!.stored,
      })),
    });
  }
  const document = buildReport({
    dataset,
    subjects,
    scorers: scorers.map((s) => ({ ...refOf(s), key: s.key })),
    ...(baseline ? { baseline: baseline.label } : {}),
    ...(options.categories ? { filter: { categories: options.categories } } : {}),
    where: options.where.map(describePredicate),
  });
  if (options.json) return JSON.stringify(document, null, 2);
  return options.md ? renderMarkdown(document) : renderReport(document, context.view);
}

async function show(context: Context, names: readonly string[]): Promise<string> {
  const { workspace, options, dataset } = context;
  if (names.length !== 2) throw new UsageError("show takes a variant and an address");
  if (options.scorers.length > 2) throw new UsageError("show takes one or two --scorer");
  const [variant] = await variantsOf(context, [names[0]!]);
  const address = parseAddress(names[1]!);
  if (!address)
    throw new UsageError(`${names[1]} is not an address: {case}, {case}/{trial}, {case}#{finding}`);
  if (address.variant && address.variant !== variant!.label) {
    throw new UsageError(`${names[1]} is ${address.variant}'s, not ${variant!.label}'s`);
  }
  const { entries } = await datasetCases(workspace, dataset);
  if (!entries.some((e) => e.id === address.case)) {
    throw new UsageError(`${address.case} is not in ${dataset}`);
  }
  if ((address.trial ?? 1) > 1) {
    throw new UsageError(`${names[1]}: one trial per case until variant-matrix-runner, so only /1`);
  }
  const [info] = await readCases(workspace, dataset, [address.case]);
  const scorers = [];
  for (const name of options.scorers.length > 0 ? options.scorers : [workspace.config.scorer]) {
    scorers.push(await context.scorer(name));
  }
  const [state] = await statesOf(workspace, dataset, variant!.key, [info!]);
  const stored: Stored | undefined = currentTrial(state!);
  const count = stored?.trial.findings.length ?? 0;
  if (address.finding !== undefined && address.finding >= count) {
    throw new UsageError(`${names[1]}: the trial has ${count} findings`);
  }
  let findings: readonly number[] | undefined =
    address.finding === undefined ? undefined : [address.finding];
  if (options.where.length > 0) {
    const baselineName = options.baseline ?? workspace.config.baseline;
    const baseline = baselineName ? await context.variant(baselineName) : undefined;
    const views = await viewsOf(context, variant!, scorers[0]!, [info!], baseline);
    const picked = choose({
      variant: variant!.label,
      cases: views,
      only: [address],
      where: options.where,
    }).get(info!.id);
    findings = picked ? (picked.findings ?? findings) : [];
  }
  const scores = [];
  for (const scorer of scorers) {
    // A passing score, else the latest passing partial one, else the latest that failed.
    const newest = <T extends { at: string }>(list: T[]) =>
      list.toSorted((a, b) => (a.at < b.at ? 1 : -1))[0];
    const mine = <T extends Score | PartialScore>(list: T[]) =>
      list.filter((s) => keyOf(s.scorer) === scorer.key && s.key.revision === info!.key.revision);
    const score: Score | PartialScore | undefined = stored
      ? (passingScore(stored, scorer.key, info!.key.revision) ??
        newest(mine(stored.partials).filter((p) => p.result.status === "scored")) ??
        newest(mine(stored.scores)))
      : undefined;
    scores.push({
      scorer: refOf(scorer),
      ...(score ? { score } : {}),
      runDir: await runDirOf(workspace.runs, score?.run?.id),
    });
  }
  const request = await Bun.file(join(info!.dir, "request.md")).text();
  const document = buildShow({
    id: formatAddress({ ...address, variant: undefined }),
    dataset,
    variant: refOf(variant!),
    info: info!,
    title: request.split("\n")[0]!.replace(/^#+\s*/, ""),
    ...(stored ? { trial: stored } : {}),
    trialRunDir: await runDirOf(workspace.runs, stored?.trial.run.id),
    scorers: scores,
    ...(findings ? { findings } : {}),
  });
  return options.json ? JSON.stringify(document, null, 2) : renderShow(document);
}

async function list(
  context: Context,
  names: readonly string[],
): Promise<{ text: string; broken: boolean }> {
  const { workspace, options, dataset } = context;
  const kinds = ["datasets", "cases", "variants", "scorers"] as const;
  if (names.length > 1 || (names[0] && !(kinds as readonly string[]).includes(names[0]))) {
    throw new UsageError(`list takes one of ${kinds.join(", ")}, or nothing`);
  }
  const wanted = names[0] ? [names[0]] : ["datasets", "variants", "scorers"];
  const document: ListDocument = {
    format: LIST_FORMAT,
    workspace: {
      config: workspace.file,
      clone: workspace.clone,
      datasets: workspace.datasets,
      results: workspace.results,
      runs: workspace.runs,
      dataset,
      scorer: workspace.config.scorer,
      ...(workspace.config.baseline ? { baseline: workspace.config.baseline } : {}),
      ...(workspace.config.budget ? { budget: workspace.config.budget.usd } : {}),
    },
  };
  let broken = false;
  if (wanted.includes("datasets")) {
    document.datasets = [];
    const dirs = existsSync(workspace.datasets)
      ? readdirSync(workspace.datasets, { withFileTypes: true })
          .filter((e) => e.isDirectory() && existsSync(join(workspace.datasets, e.name, SET_FILE)))
          .map((e) => e.name)
          .sort()
      : [];
    for (const name of dirs) {
      try {
        const { dir, set } = await datasetCases(workspace, name);
        document.datasets.push({ name, dir, cases: set.fixtures.length, builtAt: set.builtAt });
      } catch {
        broken = true;
      }
    }
  }
  if (wanted.includes("cases")) {
    const { ids } = await selectedCases(workspace, options);
    const cases = await readCases(workspace, dataset, ids);
    const { entries } = await datasetCases(workspace, dataset);
    document.cases = cases.map((info) => ({
      id: info.id,
      keyRevision: info.key.revision,
      issues: Object.fromEntries(
        SEVERITIES.map((s) => [s, info.key.issues.filter((i) => i.severity === s).length]),
      ),
      at: entries.find((e) => e.id === info.id)!.at,
    }));
  }
  const stored = await inventory(workspace.results, dataset);
  for (const kind of ["variants", "scorers"] as const) {
    if (!wanted.includes(kind)) continue;
    const known = kind === "variants" ? workspace.variants : workspace.scorers;
    const versions = kind === "variants" ? stored.variants : stored.scorers;
    const entries: NonNullable<ListDocument["variants"]> = [];
    for (const [name, file] of known) {
      let version: string | null = null;
      let key: string | undefined;
      let error: string | undefined;
      try {
        const subject =
          kind === "variants" ? await context.variant(name) : await context.scorer(name);
        version = subject.version;
        key = subject.key;
      } catch (e) {
        broken = true;
        error = (e as Error).message;
      }
      entries.push({
        name,
        file,
        version,
        ...(error ? { error } : {}),
        stored: [...versions]
          .filter(([k]) => parseKey(k)?.name === name)
          .sort(([, a], [, b]) => (a.at < b.at ? 1 : -1))
          .map(([k, v]) => ({
            ref: k,
            versions: [...v.versions].sort(),
            current: k === key,
            cases: v.cases.size,
            ...("trials" in v ? { trials: v.trials } : { scores: v.scores }),
          })),
      });
    }
    document[kind] = entries;
  }
  if (options.json) return { text: JSON.stringify(document, null, 2), broken };
  const w = document.workspace;
  const lines = [
    `config    ${w.config}`,
    `clone     ${w.clone}`,
    `datasets  ${w.datasets} (dataset ${w.dataset})`,
    `results   ${w.results}`,
    `runs      ${w.runs}`,
    `scorer    ${w.scorer}`,
    ...(w.baseline ? [`baseline  ${w.baseline}`] : []),
    ...(w.budget !== undefined ? [`budget    $${w.budget}`] : []),
  ];
  for (const d of document.datasets ?? []) {
    lines.push(`dataset   ${d.name.padEnd(24)} ${plural(d.cases, "case")}, built ${d.builtAt}`);
  }
  for (const c of document.cases ?? []) {
    const issues = Object.entries(c.issues)
      .filter(([, n]) => n > 0)
      .map(([s, n]) => `${n} ${s}`)
      .join(", ");
    lines.push(`case      ${c.id.padEnd(24)} key r${c.keyRevision}, ${issues}`);
  }
  for (const kind of ["variants", "scorers"] as const) {
    for (const entry of document[kind] ?? []) {
      const label = kind === "variants" ? "variant" : "scorer";
      lines.push(
        entry.version
          ? `${label.padEnd(9)} ${entry.name.padEnd(24)} ${entry.version.padEnd(8)}  ${entry.file}`
          : `${label.padEnd(9)} ${entry.name.padEnd(24)} fails to load: ${entry.error}`,
      );
      for (const version of entry.stored) {
        const what =
          version.trials !== undefined
            ? plural(version.trials, "trial")
            : plural(version.scores ?? 0, "score");
        lines.push(
          `          ${version.ref.padEnd(32)} ${plural(version.cases, "case")}, ${what}${version.current ? " (current)" : ""}`,
        );
      }
    }
  }
  return { text: lines.join("\n"), broken };
}

function schema(names: readonly string[], json: boolean): string {
  const all = Object.keys(SCHEMA_FILES) as SchemaName[];
  if (names.length > 1) throw new UsageError("schema takes one format or file name");
  if (names.length === 0) {
    const document: SchemasDocument = {
      format: SCHEMAS_FORMAT,
      schemas: all.map((name) => ({
        name,
        title: SCHEMA_FILES[name].title,
        ...(formatOf(name) ? { format: formatOf(name)! } : {}),
      })),
    };
    if (json) return JSON.stringify(document, null, 2);
    return document.schemas
      .map((s) => `${(s.format ?? "-").padEnd(26)} ${s.name.padEnd(32)} ${s.title}`)
      .join("\n");
  }
  const wanted = names[0]!;
  const found = all.find(
    (name) => name === wanted || name === `${wanted}.schema.json` || formatOf(name) === wanted,
  );
  if (!found) throw new UsageError(`no schema ${wanted}; awf-lab schema lists them`);
  return renderSchemaFile(found).trimEnd();
}

export async function runLab(
  argv: readonly string[],
  environment: LabEnvironment = {},
): Promise<number> {
  const cwd = environment.cwd ?? process.cwd();
  const stdout = environment.stdout ?? ((text) => console.log(text));
  const stderr = environment.stderr ?? ((text) => console.error(text));
  try {
    const { command, names, options } = parse(argv);
    if (command === "schema") {
      stdout(schema(names, options.json));
      return 0;
    }
    const workspace = await openWorkspace(findConfig(cwd, options.config));
    const lab: Lab = { workspace, runner: environment.runner ?? awfRunner(), log: stderr };
    const dataset = options.dataset ?? workspace.config.dataset;
    let stored: Promise<Inventory> | undefined;
    const inventoryOnce = () => {
      stored ??= inventory(workspace.results, dataset);
      return stored;
    };
    const context: Context = {
      workspace,
      options,
      dataset,
      cwd,
      variant: (text) => subjectOf<DefinedVariant>(workspace, "variant", text, cwd, inventoryOnce),
      scorer: (text) => subjectOf<DefinedScorer>(workspace, "scorer", text, cwd, inventoryOnce),
      view:
        !environment.stdout && process.stdout.isTTY
          ? { paint: process.env.NO_COLOR ? PLAIN : ANSI, width: process.stdout.columns }
          : { paint: PLAIN },
    };
    switch (command) {
      case "list": {
        const { text, broken } = await list(context, names);
        stdout(text);
        return broken ? 1 : 0;
      }
      case "run":
      case "score":
        return await runOrScore(command, context, names, lab, environment, { stdout, stderr });
      case "report":
        stdout(await report(context, names));
        return 0;
      case "show":
        stdout(await show(context, names));
        return 0;
      default:
        throw new UsageError(`unknown command ${command}`);
    }
  } catch (error) {
    if (error instanceof HelpRequested) {
      stdout(USAGE);
      return 0;
    }
    if (error instanceof UsageError || error instanceof RenamedConfigKeys) {
      stderr(error.message ? `awf-lab: ${error.message}\nawf-lab --help for usage` : USAGE);
      return 2;
    }
    stderr(`awf-lab: ${(error as Error).message}`);
    return 1;
  }
}

if (import.meta.main) process.exit(await runLab(Bun.argv.slice(2)));
