import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { checkSchema, describeProblems } from "../../shared/validate";
import {
  FINAL_KIND,
  type Final,
  FinalSchema,
  type Hypothesis,
  LOOP_KIND,
  type Loop,
  LoopSchema,
  PROPOSAL_KIND,
  type Proposal,
  ProposalSchema,
  TRY_KIND,
  type Try,
  TrySchema,
} from "../format/loop";
import type { CaseInfo } from "./dataset";
import { Refusal } from "./refusal";
import type { CaseWorkspace } from "./workspace";

// The loop (story 044, task 12): a proposer changes a copy of the incumbent's code, the copy runs
// against the incumbent on the tuning cases until the dataset's `compare` stops it, and it becomes
// the incumbent only on `better`. Its code and records live in the store, `loops/{name}/`.

/** How many tries in a row that kept nothing end a loop: the stall a person should look at. */
export const STALL = 3;

/** A run of this many characters of a tuning key's text in changed code is copied, not written. */
export const PASTE = 40;

export function loopDirOf(store: string, name: string): string {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name)) {
    throw new Refusal(`a loop is named with letters, digits, - and _, not ${name}`);
  }
  return join(store, "loops", name);
}

/** The tuning cases in the loop's seeded order: by a digest of the loop's name and each case's. */
export function seededOrder(name: string, cases: readonly string[]): string[] {
  const rank = (c: string) => createHash("sha256").update(`${name}\0${c}`).digest("hex");
  return [...cases].sort((a, b) => (rank(a) < rank(b) ? -1 : 1));
}

function git(dir: string, args: readonly string[]): string {
  const run = Bun.spawnSync(
    ["git", "-c", "user.name=awf-lab", "-c", "user.email=awf-lab@localhost", "-C", dir, ...args],
    { stdout: "pipe", stderr: "pipe", stdin: "ignore" },
  );
  if (run.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} in ${dir}: ${run.stderr.toString().trim()}`);
  }
  return run.stdout.toString();
}

/**
 * The `node_modules` folders git ignores under `top`, linked into `code` at the same paths: a copy
 * runs on your install, as an `--against` worktree runs on its own.
 */
function linkInstalls(top: string, code: string): void {
  const listed = git(top, [
    "ls-files",
    "-z",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--directory",
  ]);
  for (const path of listed.split("\0").filter(Boolean)) {
    const clean = path.replace(/\/$/, "");
    if (clean.split("/").at(-1) !== "node_modules") continue;
    const target = join(code, clean);
    if (existsSync(target)) continue;
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(realpathSync(join(top, clean)), target);
  }
  writeFileSync(join(code, ".git", "info", "exclude"), "node_modules\n");
}

/**
 * The start: what git would hold in your repository, less each dataset's cases, the records
 * folder and `hide`'s paths, copied into `code` and committed there, its installs linked.
 */
export function copyStart(top: string, code: string, workspace: CaseWorkspace): void {
  const listed = git(top, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  const evals = relative(top, workspace.evals);
  const records = workspace.records ? relative(top, workspace.records) : undefined;
  // `hide`'s paths hold what the box hides as it does keys: a copy never has them.
  const hidden = (workspace.hide ?? []).map((h) => join(relative(top, workspace.root), h));
  const under = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`);
  const left = (path: string) =>
    hidden.some((dir) => under(path, dir)) ||
    (records !== undefined && (path === records || path.startsWith(`${records}/`))) ||
    (path.startsWith(`${evals}/`) && path.slice(evals.length + 1).split("/")[1] === "cases");
  mkdirSync(code, { recursive: true });
  for (const path of new Set(listed.split("\0").filter(Boolean))) {
    if (left(path)) continue;
    const from = join(top, path);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(from);
    } catch {
      continue; // deleted in the working tree
    }
    const to = join(code, path);
    mkdirSync(dirname(to), { recursive: true });
    if (stat.isSymbolicLink()) symlinkSync(readlinkSync(from), to);
    else if (stat.isFile()) copyFileSync(from, to);
  }
  git(code, ["init", "-q"]);
  linkInstalls(top, code);
  git(code, ["add", "-A"]);
  git(code, ["commit", "-q", "--allow-empty", "-m", "the start"]);
}

/** A try's code: a clone of its parent's, its installs linked as the start's. */
export function branchCode(parent: string, code: string, top: string): void {
  mkdirSync(dirname(code), { recursive: true });
  // Git's objects never change once written: the clone links them rather than copying.
  const run = Bun.spawnSync(["git", "clone", "-q", parent, code], {
    stdout: "ignore",
    stderr: "pipe",
  });
  if (run.exitCode !== 0) throw new Error(`git clone ${parent}: ${run.stderr.toString().trim()}`);
  git(code, ["remote", "remove", "origin"]);
  linkInstalls(top, code);
}

/** The paths a try changed, added, edited or deleted: its commit against its parent's. */
export function changedFiles(code: string): string[] {
  const listed = git(code, ["diff", "--name-only", "--no-renames", "-z", "HEAD~1", "HEAD"]);
  return [...new Set(listed.split("\0").filter(Boolean))].sort();
}

/** What a try may not have done, from its changed files: nothing when it is in scope. */
export function outOfScope(
  code: string,
  changed: readonly string[],
  evals: string,
  tuning: readonly CaseInfo[],
): string[] {
  if (changed.length === 0) return ["it changed nothing"];
  const problems: string[] = [];
  for (const path of changed) {
    if (path === evals || path.startsWith(`${evals}/`)) problems.push(`${path}: under ${evals}/`);
    if (path.split("/").includes("node_modules")) problems.push(`${path}: an install`);
  }
  const texts = tuning.flatMap((c) => keyTexts(c));
  const markers = tuning.map((c) => c.key.marker);
  for (const path of changed) {
    const file = join(code, path);
    if (!existsSync(file) || !lstatSync(file).isFile()) continue;
    const content = readFileSync(file, "utf8");
    for (const marker of markers) {
      if (content.includes(marker)) problems.push(`${path}: holds a tuning key's marker`);
    }
    const flat = content.replace(/\s+/g, " ").toLowerCase();
    const copied = texts.find((text) => {
      for (let at = 0; at + PASTE <= text.length; at += PASTE / 4) {
        if (flat.includes(text.slice(at, at + PASTE))) return true;
      }
      return false;
    });
    if (copied) problems.push(`${path}: copies a tuning key's words`);
  }
  return problems;
}

/** A key's own words, flattened: its note, criteria, expected strings and its `key/` files. */
function keyTexts(info: CaseInfo): string[] {
  const { key } = info;
  const values = Object.values(key.expect ?? {}).filter((v): v is string => typeof v === "string");
  return [info.note, ...(key.must ?? []), ...(key["must-not"] ?? []), ...values]
    .concat(info.keyFiles.map((f) => Buffer.from(f.bytes).toString("utf8")))
    .map((text) => text.replace(/\s+/g, " ").toLowerCase())
    .filter((text) => text.length >= PASTE);
}

/** The proposer's change, committed as the try, whatever it is: the scope check reads it. */
export function commitTry(code: string, n: number): void {
  git(code, ["add", "-A"]);
  git(code, ["commit", "-q", "--allow-empty", "-m", `try ${n}`]);
}

/** The kept code against the start, as a patch. */
export function patchOf(code: string): string {
  const root = git(code, ["rev-list", "--max-parents=0", "HEAD"]).trim().split("\n")[0]!;
  return git(code, ["diff", "--no-color", root, "HEAD"]);
}

const writeJson = (file: string, value: unknown, flag = "w") =>
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag });

function readChecked<T>(file: string, schema: Parameters<typeof checkSchema>[0]): T {
  const checked = checkSchema(schema, JSON.parse(readFileSync(file, "utf8")));
  if (!checked.ok) throw new Error(describeProblems(file, checked.problems));
  return checked.value as T;
}

export function readLoop(dir: string): Loop | undefined {
  const file = join(dir, "loop.json");
  return existsSync(file) ? readChecked<Loop>(file, LoopSchema) : undefined;
}

export function readTries(dir: string): Try[] {
  const root = join(dir, "tries");
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((entry) => existsSync(join(root, entry, "try.json")))
    .map((entry) => readChecked<Try>(join(root, entry, "try.json"), TrySchema))
    .sort((a, b) => a.n - b.n);
}

export function readFinals(dir: string): Final[] {
  const root = join(dir, "finals");
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readChecked<Final>(join(root, f), FinalSchema))
    .sort((a, b) => a.k - b.k);
}

/** The code of try `n`, or the start's for 0. */
export const codeOf = (dir: string, n: number) =>
  n === 0 ? join(dir, "start") : join(dir, "tries", String(n), "code");

/** The incumbent: the last kept try, or the start. */
export const incumbentOf = (tries: readonly Try[]) =>
  tries.filter((t) => t.decision === "kept").at(-1)?.n ?? 0;

/** What a try's run gave the loop: its run, how it ended, the verdict on the second column. */
export type TryRun = {
  runId: string;
  /** `budget`, the cap stopped it; `compare`, the comparison did. */
  stopped?: "budget" | "compare";
  verdict?: { verdict: string; stop: boolean; reason: string } | { error: string };
  /** The estimates of what it ran: its own trials and grades, not those it reused. */
  spend: number;
};

/** What the loop is given to run trials and its proposer: `cli.ts` binds these to `run`. */
export type LoopDeps = {
  /** The cases in `order` on these folders, the reference first, under a cap; `stop` per case. */
  runFolders(args: {
    folders: readonly string[];
    order: readonly string[];
    budget: number;
    stopOnVerdict: boolean;
    holdout?: boolean;
  }): Promise<TryRun>;
  /** The feedback of a run's column, for the proposer's bundle. */
  feedback(runId: string, column: number): unknown;
  /** The proposer, in the box: its answer and its estimate. */
  propose(args: {
    tryDir: string;
    code: string;
    bundle: string;
    proposer: string;
  }): Promise<{ hypothesis?: Hypothesis; why?: string; spend: number; runId?: string }>;
  /** Waits while a plan window the loop draws on is nearly used. */
  waitForAllowance(): Promise<void>;
  /** The comparison's version, from `graders.ts`, as a loop records it. */
  comparison: string;
  log(line: string): void;
  now(): Date;
};

export type LoopRequest = {
  name: string;
  dataset: string;
  dir: string;
  top: string;
  workspace: CaseWorkspace;
  /** The tuning cases, every one the dataset doesn't hold out. */
  tuning: readonly CaseInfo[];
  holdout: readonly string[];
  /** Only the first `cases` of the seeded order, when given. */
  cases?: number;
  trials: number;
  rounds: number;
  budget: number;
  program?: string;
  proposer: string;
  from: { path: string; commit: string | null; dirty: boolean };
};

export type LoopOutcome = { exit: 0 | 1 | 3; why: string };

/** The loop as it stands, made or resumed; a resumed loop is refused what would judge tries apart. */
function startOrResume(request: LoopRequest, deps: LoopDeps): Loop {
  const { dir } = request;
  const loop = readLoop(dir);
  const order = seededOrder(
    request.name,
    request.tuning.map((c) => c.name),
  );
  const tuning = request.cases ? order.slice(0, request.cases) : order;
  if (loop) {
    const now = {
      dataset: request.dataset,
      holdout: JSON.stringify([...request.holdout].sort()),
      comparison: deps.comparison,
      trials: String(request.trials),
      tuning: JSON.stringify(tuning),
    };
    const then = {
      dataset: loop.dataset,
      holdout: JSON.stringify(loop.holdout),
      comparison: loop.comparison,
      trials: String(loop.trials),
      tuning: JSON.stringify(loop.tuning),
    };
    const moved = (Object.keys(now) as (keyof typeof now)[]).filter((k) => now[k] !== then[k]);
    if (moved.length > 0) {
      throw new Refusal(
        `loop ${loop.name} was started with another ${moved.join(", ")}: a loop's tries are judged alike; start another loop`,
      );
    }
    if (request.program) {
      const digest = digestOf(readFileSync(request.program));
      if (digest !== loop.program) {
        throw new Refusal(`loop ${loop.name} was started with another program`);
      }
    }
    return loop;
  }
  if (!request.program) {
    throw new Refusal(`no loop ${request.name}: start one with --program {file}`);
  }
  mkdirSync(dir, { recursive: true });
  copyFileSync(request.program, join(dir, "program.md"));
  copyStart(request.top, codeOf(dir, 0), request.workspace);
  const made: Loop = {
    kind: LOOP_KIND,
    name: request.name,
    dataset: request.dataset,
    started: deps.now().toISOString(),
    from: request.from,
    program: digestOf(readFileSync(request.program)),
    proposer: request.proposer,
    trials: request.trials,
    cap: { usd: request.budget },
    tuning,
    holdout: [...request.holdout].sort(),
    comparison: deps.comparison,
  };
  writeJson(join(dir, "loop.json"), made, "wx");
  return made;
}

const digestOf = (bytes: Uint8Array) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

const usd = (n: number) => `$${n.toFixed(2)}`;

/**
 * Tries until the rounds, the cap or a stall. Each try: the incumbent runs on the tuning cases (its
 * trials reused where nothing changed), the proposer changes a copy of it from that feedback, the
 * change's scope is checked, and the copy runs against the incumbent case by case until `compare`
 * stops it. Every try is written once, so a loop resumes where it stopped, its spend summed from its
 * own records.
 */
export async function runLoop(request: LoopRequest, deps: LoopDeps): Promise<LoopOutcome> {
  const loop = startOrResume(request, deps);
  const { dir } = request;
  const byName = new Map(request.tuning.map((c) => [c.name, c]));
  const tuning = loop.tuning.flatMap((name) => byName.get(name) ?? []);
  const evals = relative(request.top, request.workspace.evals);
  const tries = readTries(dir);
  let spent = tries.reduce((sum, t) => sum + t.spend.proposer + t.spend.trials, 0);
  for (let round = 0; round < request.rounds; round++) {
    const left = loop.cap.usd - spent;
    if (left <= 0) return { exit: 3, why: `the cap of ${usd(loop.cap.usd)} is spent` };
    const recent = tries.slice(-STALL);
    if (recent.length === STALL && recent.every((t) => t.decision !== "kept")) {
      return { exit: 0, why: `${STALL} tries in a row kept nothing: look before spending more` };
    }
    const n = tries.length + 1;
    const parent = incumbentOf(tries);
    const tryDir = join(dir, "tries", String(n));
    const code = codeOf(dir, n);
    const decide = (fields: Omit<Try, "kind" | "n" | "at" | "parent">) => {
      const record: Try = { kind: TRY_KIND, n, at: deps.now().toISOString(), parent, ...fields };
      writeJson(join(tryDir, "try.json"), record, "wx");
      tries.push(record);
      spent += record.spend.proposer + record.spend.trials;
      deps.log(`try ${n}: ${record.decision}: ${record.why}`);
      return record;
    };

    // A try cut short after its proposal resumes with it; before, it is proposed again.
    const proposalFile = join(tryDir, "proposal.json");
    let proposal: Proposal | undefined =
      existsSync(proposalFile) && existsSync(code)
        ? readChecked<Proposal>(proposalFile, ProposalSchema)
        : undefined;
    let feedbackSpend = proposal?.feedback ?? 0;
    if (proposal) {
      deps.log(
        `try ${n}: resumed against try ${parent}, ${usd(left - feedbackSpend - proposal.spend)} left`,
      );
    } else {
      rmSync(tryDir, { recursive: true, force: true });
      mkdirSync(tryDir, { recursive: true });
      await deps.waitForAllowance();
      deps.log(`try ${n}: the incumbent, try ${parent}, on ${tuning.length} tuning cases`);
      const fed = await deps.runFolders({
        folders: [codeOf(dir, parent)],
        order: loop.tuning,
        budget: left,
        stopOnVerdict: false,
      });
      feedbackSpend = fed.spend;
      if (fed.stopped === "budget") {
        decide({
          decision: "unfinished",
          why: `the cap stopped the incumbent's run ${fed.runId} before it proposed`,
          changed: [],
          runId: fed.runId,
          spend: { proposer: 0, trials: feedbackSpend },
        });
        return { exit: 3, why: `the cap ended try ${n}` };
      }
      branchCode(codeOf(dir, parent), code, request.top);
      const bundle = join(tryDir, "bundle");
      mkdirSync(bundle, { recursive: true });
      copyFileSync(join(dir, "program.md"), join(bundle, "program.md"));
      writeJson(join(bundle, "feedback.json"), deps.feedback(fed.runId, 0));
      writeJson(
        join(bundle, "history.json"),
        tries.map(({ n, parent, decision, why, hypothesis, changed }) => ({
          n,
          parent,
          decision,
          why,
          ...(hypothesis ? { hypothesis } : {}),
          changed,
        })),
      );
      writeJson(join(bundle, "rules.json"), {
        comparison: loop.comparison,
        cases: tuning.length,
        trials: loop.trials,
        spendLeft: Number((left - feedbackSpend).toFixed(2)),
      });
      await deps.waitForAllowance();
      deps.log(`try ${n}: proposing against try ${parent}`);
      const answer = await deps.propose({ tryDir, code, bundle, proposer: loop.proposer });
      if (!answer.hypothesis) {
        decide({
          decision: "failed",
          why: answer.why ?? "the proposer gave no hypothesis",
          changed: [],
          spend: { proposer: answer.spend, trials: feedbackSpend },
        });
        continue;
      }
      commitTry(code, n);
      proposal = {
        kind: PROPOSAL_KIND,
        hypothesis: answer.hypothesis,
        spend: answer.spend,
        feedback: feedbackSpend,
        ...(answer.runId ? { runId: answer.runId } : {}),
      };
      writeJson(proposalFile, proposal, "wx");
    }
    const { hypothesis, spend: proposer } = proposal;
    const changed = changedFiles(code);
    const problems = outOfScope(code, changed, evals, tuning);
    if (problems.length > 0) {
      decide({
        decision: "refused",
        why: problems.join("; "),
        hypothesis,
        changed,
        spend: { proposer, trials: feedbackSpend },
      });
      continue;
    }
    await deps.waitForAllowance();
    const ran = await deps.runFolders({
      folders: [codeOf(dir, parent), code],
      order: loop.tuning,
      budget: Math.max(0, left - feedbackSpend - proposer),
      stopOnVerdict: true,
    });
    const verdict = ran.verdict && "verdict" in ran.verdict ? ran.verdict : undefined;
    const capped = ran.stopped === "budget";
    const record = decide({
      decision: capped
        ? "unfinished"
        : !verdict
          ? "failed"
          : verdict.verdict === "better"
            ? "kept"
            : "discarded",
      why: capped
        ? `the cap stopped run ${ran.runId}`
        : verdict
          ? `${verdict.verdict}${verdict.stop ? "" : ", not stopped"}: ${verdict.reason}`
          : ran.verdict && "error" in ran.verdict
            ? `the comparison failed: ${ran.verdict.error}`
            : "no comparison: the dataset has no compare",
      hypothesis,
      changed,
      runId: ran.runId,
      verdict: verdict?.verdict ?? null,
      spend: { proposer, trials: feedbackSpend + ran.spend },
    });
    if (capped) return { exit: 3, why: `the cap ended try ${n}: ${record.why}` };
  }
  return { exit: 0, why: `${request.rounds} round${request.rounds === 1 ? "" : "s"} run` };
}

/**
 * The final check: the kept code against the start, on the held-out cases no try saw. Each check
 * is recorded; a second one says it was asked again.
 */
export async function runFinal(
  request: { dir: string; budget: number },
  deps: LoopDeps,
): Promise<LoopOutcome> {
  const loop = readLoop(request.dir);
  if (!loop) throw new Refusal(`no loop at ${request.dir}`);
  if (loop.holdout.length === 0) {
    throw new Refusal(`${loop.dataset} holds out no case: nothing for a final check`);
  }
  const kept = incumbentOf(readTries(request.dir));
  if (kept === 0)
    return { exit: 1, why: `loop ${loop.name} kept nothing: there is nothing to check` };
  const ran = await deps.runFolders({
    folders: [codeOf(request.dir, 0), codeOf(request.dir, kept)],
    order: loop.holdout,
    budget: request.budget,
    stopOnVerdict: false,
    holdout: true,
  });
  const finals = join(request.dir, "finals");
  mkdirSync(finals, { recursive: true });
  const k = readFinals(request.dir).length + 1;
  const verdict = ran.verdict && "verdict" in ran.verdict ? ran.verdict : undefined;
  const why = verdict
    ? `${verdict.verdict}: ${verdict.reason}`
    : ran.verdict && "error" in ran.verdict
      ? `the comparison failed: ${ran.verdict.error}`
      : "no comparison";
  const record: Final = {
    kind: FINAL_KIND,
    k,
    at: deps.now().toISOString(),
    incumbent: kept,
    runId: ran.runId,
    verdict: verdict?.verdict ?? null,
    why,
    spend: ran.spend,
  };
  writeJson(join(finals, `${k}.json`), record, "wx");
  const again = k > 1 ? ` (checked ${k - 1} time${k > 2 ? "s" : ""} before)` : "";
  return {
    exit: ran.stopped === "budget" ? 3 : 0,
    why: `final check ${k}${again}: try ${kept} against the start on ${loop.holdout.length} held-out cases: ${why}`,
  };
}

/** Copies a boxed run's records into the store's, where `awf logs` finds them. */
export function keepRuns(from: string, storeRuns: string): void {
  if (existsSync(from)) cpSync(from, storeRuns, { recursive: true });
}
