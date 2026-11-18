import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { OUTPUT_RECORD_VERSION } from "@agentswf/contract/records";
import type { Runner, RunOutput, RunRequest } from "../../shared/runner";
import { type GradeCase, gradeCase } from "../env/grade-case";
import { parseKey } from "../format/key";
import { TRIAL_ENV } from "../format/trial-env";
import type { TrialLine } from "../format/trial-file";
import { type CasesEnvironment, runCases } from "./cli";
import type { LabGrader } from "./grading";
import { type FolderSetup, inspectFolder, MIN_AGENTSWF } from "./inspect";
import { Refusal } from "./refusal";
import { readTrials, runIds } from "./store";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]) {
  const run = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
}

/** Never loaded: the runner here is scripted, so any filled-in env.ts will do. */
const ENV_TS = "export default {};\n";

type CaseSpec = {
  key?: string;
  files?: Record<string, string>;
  keyFiles?: Record<string, string>;
};

/** A project outside the repository: evals/awf-lab.json and one dataset `ds`. */
function project(cases: Record<string, CaseSpec>, dataset: object = {}) {
  const top = realpathSync(mkdtempSync(join(tmpdir(), "awf-lab-cases-test-")));
  roots.push(top);
  const root = join(top, "project");
  const evals = join(root, "evals");
  const ds = join(evals, "ds");
  mkdirSync(ds, { recursive: true });
  writeFileSync(join(evals, "awf-lab.json"), JSON.stringify({ kind: "awf.lab-workspace/0" }));
  writeFileSync(
    join(ds, "dataset.json"),
    JSON.stringify({
      kind: "awf.case-dataset/0",
      sandbox: "workflow",
      agentReach: { network: [] },
      ...dataset,
    }),
  );
  writeFileSync(join(ds, "env.ts"), ENV_TS);
  for (const [name, spec] of Object.entries(cases)) addCase(ds, name, spec);
  git(root, "init", "-q", "-b", "main");
  git(root, "add", "-A");
  git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base");
  const home = join(top, "home");
  const tmp = join(top, "tmp");
  mkdirSync(home);
  mkdirSync(tmp);
  return { top, root, evals, ds, home, tmp };
}

const MARKER = "lantern-copper-walrus-tangerine";
const keyMd = (front: string) =>
  `---\nkind: awf.case-key/0\nmarker: ${MARKER}\n${front}---\n\nWhy.\n`;
const expectOk = keyMd("expect:\n  ok: true\n");

function addCase(ds: string, name: string, spec: CaseSpec) {
  const dir = join(ds, "cases", name);
  mkdirSync(join(dir, "files"), { recursive: true });
  writeFileSync(join(dir, "key.md"), spec.key ?? expectOk);
  writeFileSync(join(dir, "files", "name.txt"), name);
  for (const [path, text] of Object.entries(spec.files ?? {})) {
    mkdirSync(dirname(join(dir, "files", path)), { recursive: true });
    writeFileSync(join(dir, "files", path), text);
  }
  for (const [path, text] of Object.entries(spec.keyFiles ?? {})) {
    mkdirSync(dirname(join(dir, "key", path)), { recursive: true });
    writeFileSync(join(dir, "key", path), text);
  }
}

/** What a trial's process does, scripted: the lines it writes and how its run ends. */
type Behaviour =
  | { facts: Record<string, unknown>; unused?: string[] }
  | { workflowError: string }
  | { setupError: string }
  | { refused: string }
  | { stop: string }
  | { login: true }
  | { breaks: true }
  | { scratch: Record<string, string>; facts: Record<string, unknown> }
  | { log: object[]; sandboxes?: object[]; facts: Record<string, unknown> }
  /** The trial file's lines as written, and the run's ending. */
  | { lines: (TrialLine | string)[]; outcome: string; reason: string }
  /** awf printed a record this lab can't read. */
  | { unread: string }
  /** The run's own folder holds these files, beside its records. */
  | { runFiles: Record<string, string>; facts: Record<string, unknown> }
  /** The run record's stages: name, milliseconds, and whether the case gave its value. */
  | { facts: Record<string, unknown>; runStages: [string, number, boolean?][] };

const pass: Behaviour = { facts: { ok: true } };
const fail: Behaviour = { facts: { ok: false } };

function record(request: RunRequest, runDir: string, outcome: string, extra: object): RunOutput {
  return {
    version: OUTPUT_RECORD_VERSION,
    ref: `case-env-ds/${request.id}`,
    runId: request.id,
    attempt: 1,
    workflow: { name: "case-env-ds", file: request.workflow },
    accounting: {
      wallMs: 5,
      totals: { agents: 0, known: 0, priced: 0, estimate: 0.001 },
      byModel: [],
    },
    usage: [],
    artifacts: runDir,
    outcome,
    ...extra,
  } as unknown as RunOutput;
}

/** A grader workflow's run, scripted: what it answers, given what `gradeCase()` read. */
type GraderPlay = (
  input: GradeCase,
  request: RunRequest,
) => { value: unknown; estimate?: number } | { outcome: "failed"; reason: string };

/** A runner that plays each case's behaviours in turn, as a trial's `defineEnv` would. */
function scripted(
  plays: Record<string, Behaviour[]>,
  grader?: GraderPlay,
  /** Plays for the trials of another code folder, by its root. */
  byRoot: Record<string, Record<string, Behaviour[]>> = {},
  /** Plays for the trials under some parameters, by them as `name=value`, space-separated. */
  byParams: Record<string, Record<string, Behaviour[]>> = {},
) {
  const calls: RunRequest[] = [];
  const graded: { input: GradeCase; files: string[]; request: RunRequest }[] = [];
  const seen: { name: string; caseFiles: string[]; scratchFiles: string[] }[] = [];
  const count = new Map<string, number>();
  const runner: Runner = async (request) => {
    calls.push(request);
    const env = request.env ?? {};
    const gradeDir = env[TRIAL_ENV.grade];
    if (gradeDir) {
      if (!grader) throw new Error("a grader workflow ran with no grader play");
      const was = process.env[TRIAL_ENV.grade];
      process.env[TRIAL_ENV.grade] = gradeDir;
      let input: GradeCase;
      try {
        input = gradeCase();
      } finally {
        if (was === undefined) delete process.env[TRIAL_ENV.grade];
        else process.env[TRIAL_ENV.grade] = was;
      }
      graded.push({
        input,
        files: readdirSync(gradeDir, { recursive: true }).map(String).sort(),
        request,
      });
      const runDir = join(request.runRoot, "grader", request.id);
      mkdirSync(runDir, { recursive: true });
      const played = grader(input, request);
      const base = record(request, runDir, "completed", {});
      const accounting = {
        ...base.accounting,
        wallMs: 7,
        totals: {
          ...base.accounting.totals,
          estimate: "estimate" in played ? (played.estimate ?? 0) : 0,
        },
        byModel: [{ model: "claude-haiku-5-5" }],
      };
      return {
        exitCode: 0,
        stderr: "",
        ms: 7,
        record:
          "outcome" in played
            ? record(request, runDir, "failed", { reason: played.reason, accounting })
            : record(request, runDir, "completed", { value: played.value, accounting }),
      };
    }
    const caseDir = env[TRIAL_ENV.case]!;
    const name = readFileSync(join(caseDir, "name.txt"), "utf8");
    const root = env[TRIAL_ENV.root] ?? "";
    const params = Object.entries(JSON.parse(env[TRIAL_ENV.params] ?? "{}") as object)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    const at = count.get(`${root}\0${params}\0${name}`) ?? 0;
    count.set(`${root}\0${params}\0${name}`, at + 1);
    const list = (byParams[params] ?? byRoot[root] ?? plays)[name] ?? [pass];
    const play = list[Math.min(at, list.length - 1)]!;
    seen.push({
      name,
      caseFiles: readdirSync(caseDir, { recursive: true }).map(String),
      scratchFiles: readdirSync(request.cwd, { recursive: true }).map(String),
    });
    const trialFile = env[TRIAL_ENV.trial]!;
    const write = (line: TrialLine) =>
      writeFileSync(trialFile, `${JSON.stringify(line)}\n`, { flag: "a" });
    const runDir = join(request.runRoot, "case-env-ds", request.id);
    mkdirSync(runDir, { recursive: true });
    const done = (facts: Record<string, unknown>, extra: object = {}) => {
      write({ phase: "setup" });
      write({ phase: "body" });
      write({ phase: "observe" });
      return {
        exitCode: 0,
        stderr: "",
        ms: 5,
        record: record(request, runDir, "completed", {
          value: {
            workflow: { name: "w" },
            result: { done: true },
            facts,
            stages: {},
            given: [],
            unused: [],
            refused: [],
            ...extra,
          },
        }),
      };
    };
    const failed = (reason: string) => ({
      exitCode: 1,
      stderr: "",
      ms: 5,
      record: record(request, runDir, "failed", { reason }),
    });
    if ("breaks" in play) throw new Error("the disk is full");
    if ("unread" in play) return { exitCode: 0, stderr: "", ms: 5, unread: play.unread };
    if ("lines" in play) {
      for (const line of play.lines) {
        writeFileSync(trialFile, `${typeof line === "string" ? line : JSON.stringify(line)}\n`, {
          flag: "a",
        });
      }
      return {
        exitCode: 1,
        stderr: "",
        ms: 5,
        record: record(request, runDir, play.outcome, { reason: play.reason }),
      };
    }
    if ("runFiles" in play) {
      for (const [path, text] of Object.entries(play.runFiles)) {
        writeFileSync(join(runDir, path), text);
      }
    }
    if ("login" in play) {
      return failed("subscription authentication is required for claude: log in");
    }
    if ("setupError" in play) {
      write({ phase: "setup" });
      write({ error: { by: "dataset", phase: "setup", code: "threw", reason: play.setupError } });
      return failed(play.setupError);
    }
    if ("workflowError" in play) {
      write({ phase: "setup" });
      write({ phase: "body" });
      write({ error: { by: "workflow", phase: "body", reason: play.workflowError } });
      return failed(play.workflowError);
    }
    if ("refused" in play) {
      write({ phase: "setup" });
      write({ phase: "body" });
      write({
        refused: { what: "store.drop", by: "function", phase: "body", message: play.refused },
      });
      return done({ ok: true });
    }
    if ("stop" in play) {
      write({ phase: "setup" });
      write({ phase: "body" });
      write({ stopped: { reason: play.stop } });
      return {
        exitCode: 1,
        stderr: "",
        ms: 5,
        record: record(request, runDir, "stopped", { reason: play.stop }),
      };
    }
    if ("scratch" in play) {
      for (const [path, text] of Object.entries(play.scratch)) {
        mkdirSync(dirname(join(request.cwd, path)), { recursive: true });
        writeFileSync(join(request.cwd, path), text);
      }
    }
    if ("log" in play) {
      writeFileSync(join(runDir, "log.jsonl"), play.log.map((l) => JSON.stringify(l)).join("\n"));
      return done(play.facts, {});
    }
    if ("runStages" in play) {
      const completed = done(play.facts, {
        given: play.runStages.filter(([, , given]) => given).map(([stage]) => stage),
      });
      return {
        ...completed,
        record: {
          ...completed.record,
          // A given stage runs through the engine as any other, its work handing the value back.
          stages: play.runStages.map(([stage, spanMs]) => ({
            stage,
            source: "ran",
            outcome: "completed",
            attempt: 1,
            spanMs,
          })),
        } as unknown as RunOutput,
      };
    }
    return done(play.facts, "unused" in play && play.unused ? { unused: play.unused } : {});
  };
  return { runner, calls, seen, graded };
}

/** The store a project's runs went to, under its home. */
/** The store's nth run, from 1, oldest first. */
const nthRun = (store: string, n: number) => runIds(store)[n - 1]!;

const storeOf = (where: { home: string }) =>
  join(
    where.home,
    ".awf/lab",
    readdirSync(join(where.home, ".awf/lab")).find((n) => n.startsWith("project-"))!,
  );

const fakeFolder = (root: string): FolderSetup => ({
  root,
  awf: { bin: join(root, "node_modules/agentswf/src/awf.ts"), dir: root, preload: "/fetch.ts" },
  version: "0.1.1",
  bin: join(root, "node_modules/.bin"),
});

async function lab(
  where: { root: string; home: string; tmp: string; evals: string },
  argv: string[],
  extra: CasesEnvironment = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCases(argv, {
    cwd: where.root,
    home: where.home,
    tmp: where.tmp,
    env: { PATH: "/usr/bin:/bin" },
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    inspect: async (root) => fakeFolder(root),
    logs: async () => ({ text: "" }),
    ...extra,
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

async function run(
  cases: Record<string, CaseSpec>,
  plays: Record<string, Behaviour[]>,
  trials = 1,
  extra: CasesEnvironment = {},
  dataset: object = {},
) {
  const where = project(cases, dataset);
  const fake = scripted(plays);
  const result = await lab(where, ["run", "--yes", "--trials", String(trials)], {
    runner: fake.runner,
    ...extra,
  });
  return { ...result, where, fake };
}

const undecided: LabGrader = {
  name: "unsure",
  grade: async () => ({ verdict: "undecided", reasons: [{ about: "x", text: "could not tell" }] }),
};

describe("a case's verdict and the exit code, through the command line", () => {
  test("every case passed: 0", async () => {
    const { code, out } = await run({ a: {}, b: {} }, {}, 1);
    expect(code).toBe(0);
    expect(out).toContain("passed 2 · failed 0");
    expect(out).toContain("exit 0");
  });

  test("a case that must pass failed: 1, with the failing fact", async () => {
    const { code, out } = await run({ a: {}, b: {} }, { b: [fail] });
    expect(code).toBe(1);
    expect(out).toContain("failed, must pass");
    expect(out).toContain("ok is false, the key wants true");
  });

  test("2 of 3 passed with one failed: flaky, 3", async () => {
    const { code, out } = await run({ a: {} }, { a: [pass, fail, pass] }, 3);
    expect(code).toBe(3);
    expect(out).toContain("flaky");
    expect(out).toContain("2/3");
  });

  test("a grader that can't tell leaves the case unclear: 3", async () => {
    const { code, out } = await run({ a: {} }, {}, 1, { graders: [undecided] });
    expect(code).toBe(3);
    expect(out).toContain("unclear");
  });

  test("the workflow erring on every trial fails the case: 1", async () => {
    const { code, out } = await run({ a: {} }, { a: [{ workflowError: "it crashed" }] }, 2);
    expect(code).toBe(1);
    expect(out).toContain("the workflow erred: it crashed");
  });

  test("setup erring on every trial is the dataset's: 5", async () => {
    const { code, out } = await run({ a: {} }, { a: [{ setupError: "no such file" }] }, 2);
    expect(code).toBe(5);
    expect(out).toContain("errored by dataset (threw): no such file");
  });

  test("a stopped run fails the case: 1", async () => {
    const { code, out } = await run({ a: {} }, { a: [{ stop: "nothing to do" }] });
    expect(code).toBe(1);
    expect(out).toContain("stopped: nothing to do");
  });

  test("a refused call errors the trial as the dataset's, though the run completed", async () => {
    const { code, out } = await run(
      { a: {} },
      { a: [{ refused: "no fake for store.drop in this case" }] },
    );
    expect(code).toBe(5);
    expect(out).toContain("no fake for store.drop");
  });

  test("a known-failing case that fails leaves 0; one errored by the dataset gives 5", async () => {
    const known = { key: keyMd("expect:\n  ok: true\nknown-failing: true\n") };
    const failing = await run({ a: {}, k: known }, { k: [fail] });
    expect(failing.code).toBe(0);
    expect(failing.out).toContain("known failing 1");
    const broken = await run({ a: {}, k: known }, { k: [{ setupError: "bad" }] });
    expect(broken.code).toBe(5);
  });

  test("a known-failing case passing at three trials: 0, now passing", async () => {
    const known = { key: keyMd("expect:\n  ok: true\nknown-failing: true\n") };
    const { code, out } = await run({ k: known }, {}, 3);
    expect(code).toBe(0);
    expect(out).toContain("known failing, now passing");
    expect(out).toContain("remove known-failing from its key?");
  });

  test("a pass: 2/3 case with one failed trial passes", async () => {
    const twoOfThree = { key: keyMd("expect:\n  ok: true\npass: 2/3\n") };
    const { code } = await run({ a: twoOfThree }, { a: [pass, fail, pass] }, 3);
    expect(code).toBe(0);
  });

  test("a run where no case is graded exits 3", async () => {
    const { code, out } = await run({ a: { key: keyMd("") } }, {});
    expect(code).toBe(3);
    expect(out).toContain("no case was graded");
  });

  test("a grader that throws on every trial exits 5", async () => {
    const throws: LabGrader = {
      name: "broken",
      grade: async () => {
        throw new Error("grader bug");
      },
    };
    const { code, out } = await run({ a: {} }, {}, 2, { graders: [throws] });
    expect(code).toBe(5);
    expect(out).toContain("by grading");
  });

  test("a dataset's own grader in graders.ts fails a trial expect passed: 1, with its reason", async () => {
    const where = project({ a: {} }, { graders: ["strict"] });
    writeFileSync(
      join(where.ds, "graders.ts"),
      `export const strict = { kind: "awf.case-grader/0", readsFacts: true,
        grade: ({ facts }) => ({ verdict: "failed", reasons: [{ about: "ok", text: "ok is " + facts.ok + ", and strict wants more" }] }) };`,
    );
    const fake = scripted({});
    const { code, out } = await lab(where, ["run", "--yes"], { runner: fake.runner });
    expect(code).toBe(1);
    expect(out).toContain("strict: ok is true, and strict wants more");
  });

  test("a dataset's grader runs after expect failed, and is given setupTimeout", async () => {
    const where = project(
      { a: { key: keyMd("expect:\n  ok: false\n") } },
      { graders: ["counts", "slow"], setupTimeout: "1s" },
    );
    writeFileSync(
      join(where.ds, "graders.ts"),
      `const kind = "awf.case-grader/0";
      export const counts = { kind, readsFacts: false, grade: () => ({ numbers: { hits: { count: 1, of: 2 } } }) };
      export const slow = { kind, readsFacts: false, grade: () => new Promise(() => setInterval(() => {}, 1000)) };`,
    );
    const { code } = await lab(where, ["run", "--yes"], { runner: scripted({}).runner });
    expect(code).toBe(5);
    const [trial] = readTrials(storeOf(where), nthRun(storeOf(where), 1));
    const entries = trial!.scores.at(-1)!.entries;
    expect(entries.map((e) => [e.grader, e.verdict ?? e.errored?.reason ?? e.numbers])).toEqual([
      ["expect", "failed"],
      ["counts", { hits: { count: 1, of: 2 } }],
      ["slow", "grader slow took longer than 1s"],
    ]);
  });

  test("the lab breaking mid-run exits 4 and leaves the run partial", async () => {
    const { code, where } = await run({ a: {}, b: {} }, { b: [{ breaks: true }] });
    expect(code).toBe(4);
    const runs = await lab(where, ["runs"]);
    expect(runs.out).toContain("the lab broke");
  });

  test("a provider's login refusal is tried once more at the end of its round", async () => {
    const { code, fake, out } = await run({ a: {} }, { a: [{ login: true }, pass] });
    expect(fake.calls).toHaveLength(2);
    expect(code).toBe(0);
    expect(out).toContain("passed 1");
  });

  test("a fact of no flat type errors the trial as fact-type", async () => {
    const { code, out } = await run({ a: {} }, { a: [{ facts: { ok: { nested: true } } }] });
    expect(code).toBe(5);
    expect(out).toContain("fact-type");
  });

  test("an unused mock is noted on a passing case", async () => {
    const { code, out } = await run(
      { a: {} },
      { a: [{ facts: { ok: true }, unused: ["store.list"] }] },
    );
    expect(code).toBe(0);
    expect(out).toContain("passed, with notes");
    expect(out).toContain("store.list was faked but never called");
  });

  test("a teardown that throws after the workflow failed errors the trial as the dataset's: 5", async () => {
    const lines: TrialLine[] = [
      { phase: "setup" },
      { phase: "body" },
      { error: { by: "workflow", phase: "body", reason: "the workflow broke" } },
      { phase: "teardown" },
      { error: { by: "dataset", phase: "teardown", code: "threw", reason: "teardown broke" } },
    ];
    const { code, out } = await run(
      { a: {} },
      { a: [{ lines, outcome: "failed", reason: "the workflow broke" }] },
    );
    expect(code).toBe(5);
    expect(out).toContain("errored by dataset (threw): teardown broke");
  });

  test("a cancelled run errors the trial as the lab's: 4", async () => {
    const lines: TrialLine[] = [{ phase: "setup" }, { phase: "body" }, { cancelled: "body" }];
    const { code, out } = await run(
      { a: {} },
      { a: [{ lines, outcome: "cancelled", reason: "cancelled" }] },
    );
    expect(code).toBe(4);
    expect(out).toContain("1 by lab");
  });
});

describe("what the lab can't read errors the trial as the lab's, never graded: 4", () => {
  test("a run record of another version", async () => {
    const { code, out } = await run(
      { a: {} },
      { a: [{ unread: "awf printed a run record of version 99; this lab reads version 6" }] },
    );
    expect(code).toBe(4);
    expect(out).toContain("errored 1 (1 by lab)");
    expect(out).toContain("exit 4");
  });

  test("a trial file line that fits no shape", async () => {
    const lines = [{ phase: "setup" }, "not a line", { phase: "body" }] as (TrialLine | string)[];
    const { code, where } = await run(
      { a: {} },
      { a: [{ lines, outcome: "failed", reason: "x" }] },
    );
    expect(code).toBe(4);
    const [trial] = readTrials(storeOf(where), nthRun(storeOf(where), 1));
    expect(trial!.record.errored).toMatchObject({ by: "lab", phase: "after" });
    expect(trial!.record.errored?.reason).toContain("1 line of the trial file fit no shape");
    expect(trial!.scores).toEqual([]);
  });

  test("awf logs that can't be read whole: fail closed", async () => {
    const { code, out } = await run({ a: {} }, {}, 1, {
      logs: async () => ({ unread: "awf logs left out the run's oldest events" }),
    });
    expect(code).toBe(4);
    expect(out).toContain("1 by lab");
  });
});

describe("the marker search reads the run's own folder", () => {
  test("a run file holding the marker is leaked, though awf logs showed nothing", async () => {
    const { code, out } = await run(
      { a: {} },
      { a: [{ runFiles: { "out.json": `{"x":"${MARKER}"}` }, facts: { ok: true } }] },
    );
    expect(code).toBe(5);
    expect(out).toContain("leaked 1");
  });
});

describe("the code folder", () => {
  test("is the nearest folder above evals/ holding node_modules/agentswf, not the repository's top", async () => {
    const where = project({ a: {} });
    // A monorepo: the package `app` has its own agentswf and its own evals/.
    const app = join(where.root, "app");
    mkdirSync(join(app, "node_modules", "agentswf"), { recursive: true });
    renameSync(where.evals, join(app, "evals"));
    const roots: string[] = [];
    const { code } = await lab({ ...where, root: app }, ["run", "--yes"], {
      runner: scripted({}).runner,
      inspect: async (root) => {
        roots.push(root);
        return fakeFolder(root);
      },
    });
    expect(code).toBe(0);
    expect(roots).toEqual([app]);
  });

  test("a store inside the repository is refused, though the code folder is a package of it", async () => {
    const where = project({ a: {} });
    const app = join(where.root, "app");
    mkdirSync(join(app, "node_modules", "agentswf"), { recursive: true });
    renameSync(where.evals, join(app, "evals"));
    writeFileSync(
      join(app, "evals", "awf-lab.json"),
      JSON.stringify({ kind: "awf.lab-workspace/0", store: "../../runs" }),
    );
    const { code, err } = await lab({ ...where, root: app }, ["run", "--yes"], {
      runner: scripted({}).runner,
    });
    expect(code).toBe(2);
    expect(err).toContain("is inside the repository");
  });
});

describe("the checks of a folder before the first trial: exit 2", () => {
  /** A project whose node_modules hold an agentswf of `version`, its bin `awf`, and a lab. */
  function installed(version: string, awf: string, lab: "this" | "another") {
    const where = project({ a: {} });
    const pkg = join(where.root, "node_modules", "agentswf");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ version, bin: { awf: "awf.ts" } }));
    writeFileSync(join(pkg, "awf.ts"), awf);
    const scope = join(where.root, "node_modules", "@agentswf");
    mkdirSync(scope, { recursive: true });
    if (lab === "this") symlinkSync(join(import.meta.dir, "../../.."), join(scope, "lab"));
    else {
      mkdirSync(join(scope, "lab"));
      writeFileSync(
        join(scope, "lab", "package.json"),
        JSON.stringify({
          name: "@agentswf/lab",
          exports: { "./cases": "./cases.ts", "./cases/fetch": "./fetch.ts" },
        }),
      );
      writeFileSync(join(scope, "lab", "cases.ts"), "export {};\n");
      writeFileSync(join(scope, "lab", "fetch.ts"), "export {};\n");
    }
    return where;
  }

  async function checked(where: ReturnType<typeof installed>) {
    const fake = scripted({});
    const result = await lab(where, ["run", "--yes"], {
      runner: fake.runner,
      inspect: inspectFolder,
    });
    expect(fake.calls).toHaveLength(0);
    return result;
  }

  const prints = (record: object) => `console.log(${JSON.stringify(JSON.stringify(record))});\n`;

  test("an agentswf older than the lab reads: upgrade it", async () => {
    const { code, err } = await checked(
      installed("0.1.0-beta.2", prints({ version: OUTPUT_RECORD_VERSION }), "this"),
    );
    expect(code).toBe(2);
    expect(err).toContain(`agentswf 0.1.0-beta.2 in`);
    expect(err).toContain(
      `is older than ${MIN_AGENTSWF}, the oldest this lab reads: upgrade agentswf there`,
    );
  });

  test("an awf printing another record version, named with the lab's", async () => {
    const { code, err } = await checked(installed("0.1.1", prints({ version: 99 }), "this"));
    expect(code).toBe(2);
    expect(err).toContain(
      `prints run records of version 99; this lab reads version ${OUTPUT_RECORD_VERSION}`,
    );
  });

  test("an awf printing no record at all", async () => {
    const { code, err } = await checked(installed("0.1.1", "process.exit(3);\n", "this"));
    expect(code).toBe(2);
    expect(err).toContain("its awf run printed no record (exit 3)");
  });

  test("@agentswf/lab/cases resolving to another copy of the lab", async () => {
    const { code, err } = await checked(
      installed("0.1.1", prints({ version: OUTPUT_RECORD_VERSION }), "another"),
    );
    expect(code).toBe(2);
    expect(err).toContain("@agentswf/lab/cases resolves from");
    expect(err).toContain("not this lab's");
  });
});

describe("refusals before any trial: exit 2", () => {
  test("graders a dataset can't have: no graders.ts, a missing export or workflow, the lab's own names", async () => {
    const cases: [unknown[], string][] = [
      [["accuracy"], "has no graders.ts"],
      [["missing"], "exports no grader missing"],
      [[{ workflow: "graders/judge.ts" }], "graders/judge.ts doesn't exist"],
      [[{ workflow: "graders/../env.ts" }], "outside the dataset's graders/"],
      [[{ workflow: "judge.ts" }], "graders/"],
      [["expect"], "expect is the lab's own"],
      [["criteria"], "criteria is the lab's own"],
      [["a-b"], "a-b is no export name of graders.ts"],
      [["x", "x"], "x is named twice"],
    ];
    for (const [graders, said] of cases) {
      const where = project({ a: {} }, { graders });
      if (graders[0] !== "accuracy") writeFileSync(join(where.ds, "graders.ts"), "");
      const fake = scripted({});
      const { code, err } = await lab(where, ["run", "--yes"], { runner: fake.runner });
      expect(code).toBe(2);
      expect(err).toContain(said);
      expect(fake.calls).toHaveLength(0);
    }
  });

  test("a keep path reaching outside the scratch folder", async () => {
    const where = project({ a: {} }, { keep: ["../outside.txt"] });
    const { code, err } = await lab(where, ["run", "--yes"], { runner: scripted({}).runner });
    expect(code).toBe(2);
    expect(err).toContain("keep ../outside.txt reaches outside the scratch folder");
  });

  test("a symlink in a case's files/ or key/, or the dataset's files/", async () => {
    for (const where of ["case files", "case key", "dataset files"] as const) {
      const at = project({ a: {} });
      const caseDir = join(at.ds, "cases", "a");
      const dir =
        where === "case files"
          ? join(caseDir, "files")
          : where === "case key"
            ? join(caseDir, "key")
            : join(at.ds, "files");
      mkdirSync(dir, { recursive: true });
      // A case's file that is a link to its own key: copied as a link, the workflow reads the key.
      symlinkSync(join(caseDir, "key.md"), join(dir, "notes.md"));
      const fake = scripted({});
      const { code, err } = await lab(at, ["run", "--yes"], { runner: fake.runner });
      expect({ where, code }).toEqual({ where, code: 2 });
      expect(err).toContain("notes.md: a symlink");
      expect(fake.calls).toHaveLength(0);
    }
  });

  test("a missing env.ts", async () => {
    const where = project({ a: {} });
    rmSync(join(where.ds, "env.ts"));
    const fake = scripted({});
    const { code, err } = await lab(where, ["run", "--yes"], { runner: fake.runner });
    expect(code).toBe(2);
    expect(err).toContain("env.ts is missing");
    expect(fake.calls).toHaveLength(0);
  });

  test("a dataset whose sandbox is not workflow", async () => {
    const where = project({ a: {} }, { sandbox: "lab" });
    const { code, err } = await lab(where, ["run", "--yes"], { runner: scripted({}).runner });
    expect(code).toBe(2);
    expect(err).toContain('only "workflow"');
  });

  test("a dataset without agentReach", async () => {
    const where = project({ a: {} }, { agentReach: undefined });
    const { code, err } = await lab(where, ["run", "--yes"], { runner: scripted({}).runner });
    expect(code).toBe(2);
    expect(err).toContain("agentReach");
  });

  test("a key with an unknown field", async () => {
    const where = project({ a: { key: keyMd("expects:\n  ok: true\n") } });
    const { code, err } = await lab(where, ["run", "--yes"], { runner: scripted({}).runner });
    expect(code).toBe(2);
    expect(err).toContain("key.md is not valid");
  });

  test("an empty key/ file", async () => {
    const where = project({ a: { keyFiles: { "empty.txt": "" } } });
    const { code, err } = await lab(where, ["run", "--yes"], { runner: scripted({}).runner });
    expect(code).toBe(2);
    expect(err).toContain("is empty");
  });

  test("keys with criteria and no judgeAgent", async () => {
    const where = project({ a: { key: keyMd("must:\n  - says hello\n") } });
    const { code, err } = await lab(where, ["run", "--yes"], { runner: scripted({}).runner });
    expect(code).toBe(2);
    expect(err).toContain("judgeAgent");
  });

  test("a declined plan runs nothing", async () => {
    const where = project({ a: {} });
    const fake = scripted({});
    const { code } = await lab(where, ["run"], { runner: fake.runner, confirm: async () => false });
    expect(code).toBe(2);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("case new", () => {
  test("writes awf-lab.json, dataset.json, a stub env.ts and the case; run refuses the stub, then runs", async () => {
    const top = realpathSync(mkdtempSync(join(tmpdir(), "awf-lab-new-test-")));
    roots.push(top);
    const root = join(top, "project");
    mkdirSync(root);
    git(root, "init", "-q", "-b", "main");
    const home = join(top, "home");
    const tmp = join(top, "tmp");
    mkdirSync(home);
    mkdirSync(tmp);
    const where = { root, home, tmp, evals: join(root, "evals") };
    const made = await lab(where, ["case", "new", "ds/first"]);
    expect(made.code).toBe(0);
    for (const file of ["awf-lab.json", "ds/dataset.json", "ds/env.ts", "ds/cases/first/key.md"]) {
      expect(existsSync(join(root, "evals", file))).toBe(true);
    }
    expect(JSON.parse(readFileSync(join(root, "evals/ds/dataset.json"), "utf8"))).toEqual({
      kind: "awf.case-dataset/0",
      sandbox: "workflow",
      agentReach: { network: [] },
    });
    const key = readFileSync(join(root, "evals/ds/cases/first/key.md"), "utf8");
    expect(key).toMatch(/marker: [a-z]+(-[a-z]+){3}\n/);

    const fake = scripted({});
    const refused = await lab(where, ["run", "--yes"], { runner: fake.runner });
    expect(refused.code).toBe(2);
    expect(refused.err).toContain("env.ts");
    expect(refused.err).toContain("stub");
    expect(fake.calls).toHaveLength(0);

    writeFileSync(join(root, "evals/ds/env.ts"), ENV_TS);
    writeFileSync(join(root, "evals/ds/cases/first/files/name.txt"), "first");
    writeFileSync(
      join(root, "evals/ds/cases/first/key.md"),
      key.replace("# expect:\n#   done: true", "expect:\n  ok: true"),
    );
    const ran = await lab(where, ["run", "--yes"], { runner: fake.runner });
    expect(ran.code).toBe(0);
    expect(fake.calls).toHaveLength(1);

    const second = await lab(where, ["case", "new", "second"]);
    expect(second.code).toBe(0);
    expect(existsSync(join(root, "evals/ds/cases/second/key.md"))).toBe(true);
  });
});

describe("the key stays hidden", () => {
  test("the lab copies neither key.md nor key/ into the case or scratch folder", async () => {
    const { code, fake } = await run(
      { a: { keyFiles: { "evidence.txt": "the evidence itself" } } },
      {},
    );
    expect(code).toBe(0);
    const [seen] = fake.seen;
    expect(seen!.caseFiles.sort()).toEqual(["name.txt"]);
    expect(seen!.scratchFiles).toEqual([]);
  });

  test("a case folder holding the marker is leaked without running", async () => {
    const { code, fake, out } = await run({ a: { files: { "notes.md": `copied ${MARKER}` } } }, {});
    expect(fake.calls).toHaveLength(0);
    expect(code).toBe(5);
    expect(out).toContain("leaked 1");
  });

  test("a scratch folder holding the marker after the run is leaked", async () => {
    const { code, out } = await run(
      { a: {} },
      { a: [{ scratch: { "out/x.md": MARKER }, facts: { ok: true } }] },
    );
    expect(code).toBe(5);
    expect(out).toContain("leaked 1");
  });

  test("a copy of a key/ file in the scratch folder is found by its digest", async () => {
    const evidence = "the answer is forty-two, as the evidence shows";
    const { code, out } = await run(
      { a: { keyFiles: { "evidence.txt": evidence } } },
      { a: [{ scratch: { "renamed.bin": evidence }, facts: { ok: true } }] },
    );
    expect(code).toBe(5);
    expect(out).toContain("leaked 1");
  });

  test("a marker only in a commit of a repository in the scratch folder is caught", async () => {
    const runner: Runner = async (request) => {
      const repo = join(request.cwd, "repo");
      mkdirSync(repo);
      git(repo, "init", "-q", "-b", "main");
      writeFileSync(join(repo, "k.md"), MARKER);
      git(repo, "add", "-A");
      git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "k");
      git(repo, "rm", "-q", "k.md");
      git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "gone");
      return scripted({}).runner(request);
    };
    const { code, out } = await run({ a: {} }, {}, 1, { runner });
    expect(code).toBe(5);
    expect(out).toContain("leaked 1");
  });
});

describe("--failed and history across runs", () => {
  test("runs the cases whose newest verdict was failed, flaky or unclear, with that run's trials", async () => {
    const where = project({ a: {}, b: {}, c: {} });
    const first = scripted({ a: [fail], b: [pass, fail, pass], c: [pass] });
    expect(
      (await lab(where, ["run", "--yes", "--fresh", "--trials", "3"], { runner: first.runner }))
        .code,
    ).toBe(1);
    const second = scripted({ a: [pass] });
    const again = await lab(where, ["run", "--yes", "--fresh", "--failed", "--cases", "a"], {
      runner: second.runner,
    });
    expect(again.code).toBe(0);
    expect(second.calls).toHaveLength(3);
    const third = scripted({});
    const rest = await lab(where, ["run", "--yes", "--fresh", "--failed"], {
      runner: third.runner,
    });
    // a passed in run 2; b is still flaky from run 1, at its three trials.
    expect(third.calls).toHaveLength(3);
    expect(third.seen.map((s) => s.name)).toEqual(["b", "b", "b"]);
    expect(rest.code).toBe(0);
    const firstRun = nthRun(storeOf(where), 1);
    const report = await lab(where, ["report", firstRun.slice(-4)]);
    expect(report.code).toBe(1);
    expect(report.out).toContain(`run ${firstRun}`);
    const shown = await lab(where, ["report", "--case", "b"]);
    expect(shown.out).toContain("trial 1: passed");
    expect(shown.out).toContain("logs:");
    const listed = await lab(where, ["runs"]);
    expect(listed.out.split("\n")[0]!.startsWith(nthRun(storeOf(where), 3))).toBe(true);
  });

  test("a case's earlier verdicts show as its history", async () => {
    const where = project({ a: {} });
    await lab(where, ["run", "--yes", "--fresh"], { runner: scripted({ a: [pass] }).runner });
    await lab(where, ["run", "--yes", "--fresh"], { runner: scripted({ a: [pass] }).runner });
    const last = await lab(where, ["run", "--yes", "--fresh"], {
      runner: scripted({ a: [fail] }).runner,
    });
    expect(last.out).toContain("history ✓✓");
    const store = readdirSync(join(where.home, ".awf/lab")).find((n) => n.startsWith("project-"))!;
    expect(runIds(join(where.home, ".awf/lab", store))).toHaveLength(3);
    const trials = readTrials(
      join(where.home, ".awf/lab", store),
      nthRun(join(where.home, ".awf/lab", store), 3),
    );
    expect(trials[0]!.record.input).toMatch(/^[0-9a-f]{64}$/);
    expect(trials[0]!.scores[0]!.entries[0]!.grader).toBe("expect");
  });
});

describe("reach, end to end", () => {
  const opened = (agent: string, extra: object = {}) => ({
    version: 1,
    attempt: 1,
    at: "2026-11-15T00:00:00Z",
    kind: "agent-opened",
    agent,
    callPath: [],
    harness: "claude",
    cwd: "/x",
    ...extra,
  });
  const sandbox = (key: string, spec: object) => ({
    version: 1,
    attempt: 1,
    at: "2026-11-15T00:00:00Z",
    kind: "sandbox-opened",
    callPath: [],
    key,
    provider: "srt",
    spec: { srt: {}, cwd: "/x", ...spec },
    directory: "/d",
    gitdirs: [],
    domains: [],
    agents: [],
  });

  test("an agent with no sandbox errors the trial as reach: 5", async () => {
    const { code, out } = await run(
      { a: {} },
      { a: [{ log: [opened("reader")], facts: { ok: true } }] },
    );
    expect(code).toBe(5);
    expect(out).toContain("(reach): agent reader ran with no sandbox");
  });

  test("a sandbox within agentReach and its model domains passes", async () => {
    const { code } = await run(
      { a: {} },
      {
        a: [
          {
            log: [
              sandbox("box", { network: ["api.anthropic.com", "a.example.com"] }),
              opened("reader", { sandbox: "box", domains: ["api.anthropic.com"] }),
            ],
            facts: { ok: true },
          },
        ],
      },
      1,
      {},
      { agentReach: { network: ["*.example.com"] } },
    );
    expect(code).toBe(0);
  });
});

/** A grader workflow in the dataset's `graders/`: only its version is read, by the helper. */
function graderWorkflow(where: { ds: string }, name: string, version = "1.0.0") {
  mkdirSync(join(where.ds, "graders"), { recursive: true });
  writeFileSync(
    join(where.ds, "graders", `${name}.ts`),
    `export default { kind: "awf.workflow", meta: { name: "${name}", version: "${version}" } };\n`,
  );
}

const judged =
  (verdict: string, estimate = 0.25): GraderPlay =>
  () => ({
    value: {
      verdict,
      numbers: { recall: { count: 2, of: 3 } },
      reasons: [{ about: "finding 0", text: "gives K1's cause" }],
      parts: [
        {
          about: "finding 0",
          label: "hit",
          data: { issue: "K1" },
          settled: "majority",
          votes: [
            { by: "v1", label: "hit" },
            { by: "v2", label: "hit" },
            { by: "v3", label: "noise", why: "vague" },
          ],
        },
      ],
    },
    estimate,
  });

const keyWith = (front: string) => ({ key: keyMd(front), keyFiles: { "answer.json": '{"n":1}' } });

describe("grader workflows and score", () => {
  test("a grader workflow is given its grade folder; its parts, numbers and cost reach the score entry", async () => {
    const where = project(
      { a: keyWith("expect:\n  ok: true\n") },
      { graders: [{ workflow: "graders/judge.ts", readsFacts: true }] },
    );
    graderWorkflow(where, "judge", "1.2.0");
    let answer = "";
    let cwdFiles: string[] = ["unread"];
    const fake = scripted({}, (input, request) => {
      answer = readFileSync(join(input.case.keyDir!, "answer.json"), "utf8");
      cwdFiles = readdirSync(request.cwd);
      return judged("passed")(input, request);
    });
    const { code, out } = await lab(where, ["run", "--yes"], { runner: fake.runner });
    expect(code).toBe(0);
    const [{ input, files, request }] = fake.graded as [(typeof fake.graded)[number]];
    expect(input.case.name).toBe("a");
    expect(input.case.key).toEqual({ kind: "awf.case-key/0", expect: { ok: true } });
    expect(answer).toBe('{"n":1}');
    expect(input.facts).toEqual({ ok: true });
    expect(input.result).toEqual({ done: true });
    expect(typeof input.scratch).toBe("string");
    expect(input.params).toEqual({});
    expect(input.previous).toBeUndefined();
    expect(files).toEqual(
      expect.arrayContaining([
        "grade.json",
        "case/name.txt",
        "key.json",
        "key/answer.json",
        "result.json",
        "facts.json",
        "kept",
      ]),
    );
    expect(request.workflow).toBe(join(where.ds, "graders", "judge.ts"));
    expect(request.awf?.preload).toBeUndefined();
    expect(cwdFiles).toEqual([]);
    const [trial] = readTrials(storeOf(where), nthRun(storeOf(where), 1));
    const entry = trial!.scores[0]!.entries.find((e) => e.grader === "judge")!;
    expect(entry).toMatchObject({
      version: "1.2.0",
      verdict: "passed",
      estimate: 0.25,
      models: ["claude-haiku-5-5"],
      numbers: { recall: { count: 2, of: 3 } },
    });
    expect(entry.runId).toBe(request.id);
    expect(entry.parts![0]!.votes).toHaveLength(3);
    expect(out).toContain("numbers: judge recall 2/3 (67%)");
    // The grade folder, which holds the key, is gone.
    expect(existsSync(dirname(input.case.dir))).toBe(false);
  });

  test("a grader workflow is skipped when expect failed; score judges it once the key's expect passes", async () => {
    const where = project(
      { a: keyWith("expect:\n  ok: false\n") },
      { graders: [{ workflow: "graders/judge.ts" }] },
    );
    graderWorkflow(where, "judge");
    const fake = scripted({}, judged("passed"));
    expect((await lab(where, ["run", "--yes"], { runner: fake.runner })).code).toBe(1);
    expect(fake.graded).toHaveLength(0);
    const unchanged = await lab(where, ["score", "--yes"], { runner: fake.runner });
    expect(unchanged.err).toMatch(/nothing in run \S+ to grade again/);
    writeFileSync(join(where.ds, "cases/a/key.md"), keyMd("expect:\n  ok: true\n"));
    const scored = await lab(where, ["score", "--yes"], { runner: fake.runner });
    expect(scored.code).toBe(0);
    expect(scored.out).toContain("graded again: expect ×1, judge ×1");
    expect(fake.graded).toHaveLength(1);
    expect(fake.graded[0]!.input.scratch).toBeNull();
  });

  test("score never runs env.ts, grades again on a key edit with previous.json, on a minor bump without it, never on a patch", async () => {
    const where = project(
      { a: keyWith("expect:\n  ok: true\n") },
      { graders: [{ workflow: "graders/judge.ts" }] },
    );
    graderWorkflow(where, "judge", "1.0.0");
    const fake = scripted({}, judged("passed"));
    await lab(where, ["run", "--yes"], { runner: fake.runner });
    const trialRuns = () => fake.calls.filter((c) => !c.env?.[TRIAL_ENV.grade]).length;
    expect(trialRuns()).toBe(1);
    const firstKey = readTrials(
      storeOf(where),
      nthRun(storeOf(where), 1),
    )[0]!.scores[0]!.entries.find((e) => e.grader === "judge")!.key;

    writeFileSync(join(where.ds, "cases/a/key/answer.json"), '{"n":2}');
    const edited = await lab(where, ["score", "--yes"], { runner: fake.runner });
    expect(edited.code).toBe(0);
    expect(fake.graded).toHaveLength(2);
    expect(fake.graded[1]!.input.previous).toEqual({
      key: firstKey,
      parts: expect.arrayContaining([
        expect.objectContaining({ about: "finding 0", label: "hit" }),
      ]),
    });

    graderWorkflow(where, "judge", "1.0.1");
    const patch = await lab(where, ["score", "--yes"], { runner: fake.runner });
    expect(patch.err).toMatch(/nothing in run \S+ to grade again/);

    graderWorkflow(where, "judge", "1.1.0");
    await lab(where, ["score", "--yes"], { runner: fake.runner });
    expect(fake.graded).toHaveLength(3);
    expect(fake.graded[2]!.input.previous).toBeUndefined();
    expect(trialRuns()).toBe(1);
    const scores = readTrials(storeOf(where), nthRun(storeOf(where), 1))[0]!.scores;
    expect(scores).toHaveLength(3);
  });

  test("score leaves trials the workflow failed, drafts, and cases changed since they ran", async () => {
    const where = project(
      {
        a: keyWith("expect:\n  ok: true\n"),
        b: keyWith("expect:\n  ok: true\n"),
        c: { key: keyMd("expect:\n  ok: true\ndraft: true\n"), keyFiles: { "answer.json": "{}" } },
        d: keyWith("expect:\n  ok: true\n"),
      },
      { graders: [{ workflow: "graders/judge.ts" }] },
    );
    graderWorkflow(where, "judge");
    const fake = scripted({ b: [{ workflowError: "it crashed" }] }, judged("passed"));
    await lab(where, ["run", "--yes"], { runner: fake.runner });
    expect(fake.graded.map((g) => g.input.case.name)).toEqual(["a", "d"]);
    for (const name of ["a", "b", "c", "d"]) {
      writeFileSync(join(where.ds, "cases", name, "key/answer.json"), '{"n":9}');
    }
    writeFileSync(join(where.ds, "cases/d/files/name.txt"), "d, changed");
    const scored = await lab(where, ["score", "--yes"], { runner: fake.runner });
    expect(fake.graded.map((g) => g.input.case.name)).toEqual(["a", "d", "a"]);
    expect(scored.err).toContain(
      "1 trial left: the case changed since it ran; run it again: awf-lab run --cases d",
    );
  });

  test("an onDemand grader runs only with score --grader, and never decides a verdict", async () => {
    const where = project(
      { a: keyWith("expect:\n  ok: true\n") },
      { graders: ["first", { workflow: "graders/second.ts", onDemand: true }] },
    );
    graderWorkflow(where, "second");
    writeFileSync(
      join(where.ds, "graders.ts"),
      `export const first = { kind: "awf.case-grader/0", version: "1.0.0", readsFacts: false, grade: () => ({ verdict: "passed" }) };`,
    );
    const fake = scripted({}, judged("failed"));
    expect((await lab(where, ["run", "--yes"], { runner: fake.runner })).code).toBe(0);
    expect(fake.graded).toHaveLength(0);
    expect((await lab(where, ["score", "--yes"], { runner: fake.runner })).err).toMatch(
      /nothing in run \S+ to grade again/,
    );
    const scored = await lab(where, ["score", "--grader", "second", "--yes"], {
      runner: fake.runner,
    });
    expect(fake.graded).toHaveLength(1);
    expect(scored.code).toBe(0);
    const entry = readTrials(storeOf(where), nthRun(storeOf(where), 1))[0]!.scores.at(-1)!
      .entries[0]!;
    expect(entry).toMatchObject({ grader: "second", verdict: "failed" });
    expect(scored.out).toContain("agreement, first and second: the same verdict on 0 of 1 trial");
    expect(scored.out).not.toContain("agreement, expect");
    const shown = await lab(where, ["report", "--case", "a"]);
    expect(shown.out).toContain("second: failed (1.0.0, not in the verdict");
  });

  test("a grader that throws leaves the trial errored by grading, and score grades it again", async () => {
    const where = project({ a: {} }, { graders: ["flaky"] });
    writeFileSync(
      join(where.ds, "graders.ts"),
      `import { existsSync } from "node:fs";
      export const flaky = { kind: "awf.case-grader/0", version: "1.0.0", readsFacts: false,
        grade: () => { if (existsSync(${JSON.stringify(join(where.ds, "broken"))})) throw new Error("no order.json"); return { verdict: "passed" }; } };`,
    );
    writeFileSync(join(where.ds, "broken"), "");
    const fake = scripted({});
    const ran = await lab(where, ["run", "--yes"], { runner: fake.runner });
    expect(ran.code).toBe(5);
    expect(ran.out).toContain("1 by grading");
    rmSync(join(where.ds, "broken"));
    const scored = await lab(where, ["score", "--yes"], { runner: fake.runner });
    expect(scored.out).toContain("graded again: flaky ×1");
    expect(scored.code).toBe(0);
    expect(fake.calls).toHaveLength(1);
  });

  test("pooled numbers leave out trials the workflow failed, and say how many", async () => {
    const where = project({ a: {} }, { graders: ["counts"] });
    writeFileSync(
      join(where.ds, "graders.ts"),
      `export const counts = { kind: "awf.case-grader/0", version: "1.0.0", readsFacts: false,
        grade: () => ({ numbers: { hits: { count: 1, of: 2 }, words: { value: 40 } } }) };`,
    );
    const { out } = await run({ a: {} }, {}, 1, {}, {});
    expect(out).not.toContain("numbers:");
    const fake = scripted({ a: [pass, { workflowError: "it crashed" }, pass] });
    const ran = await lab(where, ["run", "--yes", "--trials", "3"], { runner: fake.runner });
    expect(ran.out).toContain(
      "numbers: counts hits 2/4 (50%), words median 40; 1 trial the workflow failed left out",
    );
    const json = JSON.parse((await lab(where, ["report", "--json"])).out);
    expect(json.numbers).toEqual({
      counts: { hits: { count: 2, of: 4 }, words: { values: [40, 40] } },
    });
    expect(json.numbersLeftOut).toBe(1);
    expect(json.cases[0]).toMatchObject({ name: "a", verdict: "flaky", passed: 2, trials: 3 });
  });

  test("score's plan prices from earlier grades; --dry-run grades nothing; --budget stops and exits 3", async () => {
    const where = project(
      { a: keyWith("expect:\n  ok: true\n"), b: keyWith("expect:\n  ok: true\n") },
      { graders: [{ workflow: "graders/judge.ts" }] },
    );
    graderWorkflow(where, "judge");
    const fake = scripted({}, judged("passed", 0.25));
    await lab(where, ["run", "--yes"], { runner: fake.runner });
    for (const name of ["a", "b"])
      writeFileSync(join(where.ds, "cases", name, "key/answer.json"), "{}");
    const report = await lab(where, ["report"]);
    expect(report.out).toMatch(
      /2 grades out of date, a key or grader changed: awf-lab score [0-9a-f]{4}$/m,
    );
    const dry = await lab(where, ["score", "--dry-run"], { runner: fake.runner });
    expect(dry.out).toMatch(/score run \S+: 2 trials · judge ×2/);
    expect(dry.out).toContain("est. $0.50");
    expect(fake.graded).toHaveLength(2);
    const json = JSON.parse((await lab(where, ["score", "--dry-run", "--json"])).out);
    expect(json.plan).toMatchObject({ trials: 2, grades: { judge: 2 }, estimate: 0.5 });
    const capped = await lab(where, ["score", "--yes", "--budget", "0.2"], { runner: fake.runner });
    expect(fake.graded).toHaveLength(3);
    expect(capped.code).toBe(3);
    expect(capped.out).toContain("stopped at the budget, $0.20");
  });

  test("only the graders dataset.json and the key name now decide: one removed, made onDemand, or an expect taken out", async () => {
    const where = project({ a: { key: keyMd("expect:\n  ok: false\n") } }, { graders: ["g"] });
    writeFileSync(
      join(where.ds, "graders.ts"),
      `export const g = { kind: "awf.case-grader/0", version: "1.0.0", readsFacts: false,
        grade: () => ({ verdict: "failed", reasons: [{ about: "x", text: "no" }] }) };`,
    );
    const fake = scripted({});
    expect((await lab(where, ["run", "--yes"], { runner: fake.runner })).code).toBe(1);
    // expect taken out of the key: its old failed grade is shown, never deciding.
    writeFileSync(join(where.ds, "cases/a/key.md"), keyMd(""));
    expect((await lab(where, ["report"])).code).toBe(1);
    const datasetFile = join(where.ds, "dataset.json");
    const dataset = JSON.parse(readFileSync(datasetFile, "utf8"));
    writeFileSync(
      datasetFile,
      JSON.stringify({ ...dataset, graders: [{ grader: "g", onDemand: true }] }),
    );
    const aside = await lab(where, ["report"]);
    expect(aside.code).toBe(3);
    expect(aside.out).toContain("no case was graded");
    writeFileSync(datasetFile, JSON.stringify({ ...dataset, graders: [] }));
    expect((await lab(where, ["report"])).code).toBe(3);
    // Back as a deciding grader, its grade decides again without grading.
    writeFileSync(datasetFile, JSON.stringify(dataset));
    expect((await lab(where, ["report"])).code).toBe(1);
  });

  test("--budget stops between two grader workflows of one trial", async () => {
    const where = project(
      { a: keyWith("expect:\n  ok: true\n") },
      { graders: [{ workflow: "graders/j1.ts" }, { workflow: "graders/j2.ts" }] },
    );
    graderWorkflow(where, "j1");
    graderWorkflow(where, "j2");
    const fake = scripted({}, judged("passed", 0.25));
    await lab(where, ["run", "--yes"], { runner: fake.runner });
    expect(fake.graded).toHaveLength(2);
    writeFileSync(join(where.ds, "cases/a/key/answer.json"), "{}");
    const capped = await lab(where, ["score", "--yes", "--budget", "0.1"], { runner: fake.runner });
    expect(fake.graded).toHaveLength(3);
    expect(capped.code).toBe(3);
    expect(capped.out).toContain("graded again: j1 ×1");
  });

  test("a skipped grader workflow is planned only if the cheap graders regraded now pass, and priced as up to", async () => {
    const where = project(
      { a: keyWith("expect:\n  ok: false\n") },
      { graders: [{ workflow: "graders/judge.ts" }] },
    );
    graderWorkflow(where, "judge");
    const fake = scripted({}, judged("passed", 0.25));
    await lab(where, ["run", "--yes"], { runner: fake.runner });
    // A key change that keeps expect failing: the judge is a maybe, and stays skipped.
    writeFileSync(join(where.ds, "cases/a/key.md"), keyMd("expect:\n  ok: 3\n"));
    const dry = await lab(where, ["score", "--dry-run"], { runner: fake.runner });
    expect(dry.out).toContain("judge ×1 if the cheaper graders now pass");
    writeFileSync(join(where.ds, "cases/a/key.md"), keyMd("expect:\n  ok: false\n"));
    await lab(where, ["score", "--yes"], { runner: fake.runner });
    expect(fake.graded).toHaveLength(0);
  });

  test("report --json and score --json print their schemas' shapes", async () => {
    const where = project(
      { a: keyWith("expect:\n  ok: true\n") },
      { graders: [{ workflow: "graders/judge.ts" }] },
    );
    graderWorkflow(where, "judge");
    const fake = scripted({}, judged("passed"));
    await lab(where, ["run", "--yes"], { runner: fake.runner });
    const report = JSON.parse((await lab(where, ["report", "--json"])).out);
    expect(report).toMatchObject({
      kind: "awf.case-report/0",
      run: nthRun(storeOf(where), 1),
      exit: 0,
      stale: 0,
    });
    const one = JSON.parse((await lab(where, ["report", "--case", "a", "--json"])).out);
    expect(one.trials).toHaveLength(1);
    writeFileSync(join(where.ds, "cases/a/key/answer.json"), "{}");
    const scored = JSON.parse(
      (await lab(where, ["score", "--yes", "--json"], { runner: fake.runner })).out,
    );
    expect(scored).toMatchObject({
      kind: "awf.case-scored/0",
      plan: { grades: { judge: 1 } },
      done: { graded: { judge: 1 }, stopped: false },
      report: { kind: "awf.case-report/0", exit: 0 },
    });
  });

  test("a grader workflow and a graders.ts export of one name are refused", async () => {
    const where = project({ a: {} }, { graders: [{ workflow: "graders/recall.ts" }] });
    graderWorkflow(where, "recall");
    writeFileSync(
      join(where.ds, "graders.ts"),
      `export const recall = { kind: "awf.case-grader/0", version: "1.0.0", readsFacts: false, grade: () => ({ verdict: "passed" }) };`,
    );
    const { code, err } = await lab(where, ["run", "--yes"], { runner: scripted({}).runner });
    expect(code).toBe(2);
    expect(err).toContain("share the name");
  });
});

describe("the criteria judge, through the command line", () => {
  const JUDGE = { harness: "claude", model: "claude-haiku-5-5" };
  /** A project whose awf-lab.json names a judge, and a key with `expect` and criteria. */
  function judged(expectOk = "true", must = ["the reply is short"]) {
    const where = project({
      a: {
        key: keyMd(`expect:\n  ok: ${expectOk}\nmust:\n${must.map((m) => `  - ${m}\n`).join("")}`),
      },
    });
    writeFileSync(
      join(where.evals, "awf-lab.json"),
      JSON.stringify({ kind: "awf.lab-workspace/0", judgeAgent: JUDGE }),
    );
    return where;
  }
  /** The judge, scripted: every criterion met, all three voters agreeing. */
  const judge: GraderPlay = (input) => ({
    value: {
      verdict: "passed",
      reasons: [],
      parts: [...(input.case.key.must ?? [])].map((text) => ({
        about: `must: ${text}`,
        verdict: "passed",
        settled: "agreed",
        why: "short enough",
        votes: [],
      })),
    },
    estimate: 0.01,
  });

  test("labels clear the judge's mark: 10 labeled trials it graded, 3 of them needs-work", async () => {
    const where = judged();
    await lab(where, ["run", "--yes", "--trials", "10"], { runner: scripted({}, judge).runner });
    const trials = readTrials(storeOf(where), nthRun(storeOf(where), 1));
    for (const [i, t] of trials.entries()) {
      const mark = i < 3 ? ["--needs-work", "too long"] : ["--good"];
      if (i < 9) await lab(where, ["label", t.record.runId!, ...mark]);
    }
    const nine = (await lab(where, ["report"])).out;
    expect(nine).toContain("not checked against a person (labeled 9 of 10, needs-work 3 of 3");
    await lab(where, ["label", trials[9]!.record.runId!, "--good"]);
    const ten = (await lab(where, ["report"])).out;
    expect(ten).toContain("judge: claude/claude-haiku-5-5\n");
    expect(ten).toContain("labels: 10 trials · good 7, passed 7 · needs-work 3, failed 0");
  });

  test("criteria are judged after expect, on the lab's own awf, recording the judge's agent", async () => {
    const where = judged();
    const fake = scripted({}, judge);
    const { code, out } = await lab(where, ["run", "--yes"], { runner: fake.runner });
    expect(code).toBe(0);
    const [{ request, input }] = fake.graded as [(typeof fake.graded)[number]];
    expect(request.workflow).toEndWith("cases/judge/criteria.workflow.ts");
    expect(request.argv).toEqual(["--harness", "claude", "--model", "claude-haiku-5-5"]);
    expect(request.awf).toBeUndefined();
    expect(input.facts).toEqual({ ok: true });
    const entry = readTrials(storeOf(where), nthRun(storeOf(where), 1))[0]!.scores[0]!.entries.find(
      (e) => e.grader === "criteria",
    )!;
    expect(entry).toMatchObject({ version: "1.0.0", agent: JUDGE, verdict: "passed" });
    expect(out).toContain("criteria judged 1\n");
    // Its grade folder holds the criteria alone: no expect, no key/.
    expect(input.case.key).toEqual({ kind: "awf.case-key/0", must: ["the reply is short"] });
    expect(input.case.keyDir).toBeUndefined();
    expect(out).toContain("judge: claude/claude-haiku-5-5, not checked against a person");
  });

  test("a trial expect failed skips the judge; score judges it once the key's expect passes", async () => {
    const where = judged("false");
    const fake = scripted({}, judge);
    const ran = await lab(where, ["run", "--yes"], { runner: fake.runner });
    expect(ran.code).toBe(1);
    expect(fake.graded).toHaveLength(0);
    expect(ran.out).toContain("not judged on 1 trial a cheaper grader failed");
    // While expect still fails, a key edit leaves the criteria not judged.
    writeFileSync(
      join(where.ds, "cases/a/key.md"),
      keyMd("expect:\n  ok: 7\nmust:\n  - the reply is short\n"),
    );
    await lab(where, ["score", "--yes"], { runner: fake.runner });
    expect(fake.graded).toHaveLength(0);
    writeFileSync(
      join(where.ds, "cases/a/key.md"),
      keyMd("expect:\n  ok: true\nmust:\n  - the reply is short\n"),
    );
    const scored = await lab(where, ["score", "--yes"], { runner: fake.runner });
    expect(scored.code).toBe(0);
    expect(scored.out).toContain("graded again: expect ×1, criteria ×1");
  });

  test("an edited criterion is judged again with the earlier parts; an expect edit leaves the judge alone", async () => {
    const where = judged("true", ["the reply is short", "the reply is polite"]);
    const fake = scripted({}, judge);
    await lab(where, ["run", "--yes"], { runner: fake.runner });
    // The judge's grades are kept against the criteria alone: an expect edit plans expect only.
    writeFileSync(
      join(where.ds, "cases/a/key.md"),
      keyMd("expect:\n  ok: false\nmust:\n  - the reply is short\n  - the reply is polite\n"),
    );
    const dry = await lab(where, ["score", "--dry-run"], { runner: fake.runner });
    expect(dry.out).toMatch(/score run \S+: 1 trial · expect ×1/);
    expect(dry.out).not.toContain("criteria");
    writeFileSync(
      join(where.ds, "cases/a/key.md"),
      keyMd("expect:\n  ok: true\nmust:\n  - the reply is short\n  - the reply is kind\n"),
    );
    await lab(where, ["score", "--yes"], { runner: fake.runner });
    expect(fake.graded).toHaveLength(2);
    expect(fake.graded[1]!.input.previous?.parts.map((p) => p.about)).toEqual([
      "must: the reply is short",
      "must: the reply is polite",
    ]);
  });

  test("after judgeAgent changes, score judges every criterion again, with no earlier parts", async () => {
    const where = judged();
    const fake = scripted({}, judge);
    await lab(where, ["run", "--yes"], { runner: fake.runner });
    const other = { harness: "codex", model: "gpt-6-luna" };
    writeFileSync(
      join(where.evals, "awf-lab.json"),
      JSON.stringify({ kind: "awf.lab-workspace/0", judgeAgent: other }),
    );
    expect((await lab(where, ["report"])).out).toContain("1 grade out of date");
    await lab(where, ["score", "--yes"], { runner: fake.runner });
    expect(fake.graded).toHaveLength(2);
    expect(fake.graded[1]!.input.previous).toBeUndefined();
    expect(fake.graded[1]!.request.argv).toEqual(["--harness", "codex", "--model", "gpt-6-luna"]);
    const newest = readTrials(storeOf(where), nthRun(storeOf(where), 1))[0]!.scores.at(-1)!
      .entries[0]!;
    expect(newest.agent).toEqual(other);
  });
});

test("a run whose records don't read is left out of history and named by runs, not a stop", async () => {
  const where = project({ a: {} });
  const fake = scripted({});
  await lab(where, ["run", "--yes"], { runner: fake.runner });
  const [trial] = readTrials(storeOf(where), nthRun(storeOf(where), 1));
  writeFileSync(join(trial!.dir, "scores.jsonl"), '{"kind":"awf.case-score/0","old":true}\n');
  const again = await lab(where, ["run", "--yes"], { runner: fake.runner });
  expect(again.code).toBe(0);
  const listed = await lab(where, ["runs"]);
  expect(listed.out).toContain("records don't read (scores.jsonl:");
  expect(listed.out).toContain("left out of history");
  expect(again.out).toContain("history leaves out 1 earlier run whose records don't read");
});

describe("--against: the same cases on code in another folder", () => {
  /** Your checkout and a clone of it, the other folder. */
  function twoFolders(cases: Record<string, CaseSpec>) {
    const where = project(cases);
    const other = join(where.top, "other");
    git(where.top, "clone", "-q", where.root, other);
    // Its own install, as a checkout that runs trials has.
    mkdirSync(join(other, "node_modules", "agentswf"), { recursive: true });
    return { where, other };
  }
  const inspect = async (root: string) => ({
    ...fakeFolder(root),
    version: root.endsWith("other") ? "0.1.2" : "0.1.1",
  });

  test("two folders whose workflows answer differently: two columns, and the case that came out differently", async () => {
    const { where, other } = twoFolders({ a: {}, b: {}, c: {} });
    // The other folder's own cases, keys and graders are never read: break them.
    writeFileSync(join(other, "evals/ds/cases/a/key.md"), "not a key");
    addCase(join(other, "evals/ds"), "only-there", {});
    writeFileSync(
      join(other, "evals/ds/dataset.json"),
      JSON.stringify({ kind: "awf.case-dataset/0", graders: ["missing"] }),
    );
    writeFileSync(
      join(other, "evals/ds/graders.ts"),
      "throw new Error('the other graders.ts loaded');",
    );
    const fake = scripted({ b: [fail], c: [fail] }, undefined, {
      [other]: { a: [fail], c: [fail] },
    });
    const { code, out } = await lab(where, ["run", "--yes", "--against", other], {
      runner: fake.runner,
      inspect,
    });
    expect(code).toBe(1);
    expect(fake.calls).toHaveLength(6);
    expect(out).toContain("columns");
    expect(out).toContain(`against 1: ${other}, branch main`);
    expect(out).toContain("came out differently in against 1, largest difference first");
    expect(out).toMatch(/\n {2}a\s+this checkout 1\/1 passed · against 1 0\/1 failed/);
    expect(out).toMatch(/\n {2}b\s+this checkout 0\/1 failed · against 1 1\/1 passed/);
    expect(out).toContain("more passes: against 1 on 1 case, this checkout on 1 case");
    expect(out).toContain("also fails in against 1");
    expect(out).toContain("One trial each: these are examples, not rates.");
    const record = JSON.parse(
      readFileSync(join(storeOf(where), "runs", nthRun(storeOf(where), 1), "run.json"), "utf8"),
    );
    expect(record.folders.map((f: { path: string }) => f.path)).toEqual([where.root, other]);
    const json = JSON.parse((await lab(where, ["report", "--json"])).out);
    expect(json.columns[0]).toMatchObject({ path: other, envDiffers: false });
    expect(json.columns[0].cases.map((c: { verdict: string }) => c.verdict)).toEqual([
      "failed",
      "passed",
      "failed",
    ]);
  });

  test("each folder's trials run on its own awf, started there, on its own env.ts", async () => {
    const { where, other } = twoFolders({ a: {} });
    writeFileSync(join(other, "evals/ds/env.ts"), "export default { other: true };\n");
    const fake = scripted({});
    await lab(where, ["run", "--yes", "--against", other], { runner: fake.runner, inspect });
    const theirs = fake.calls.find((c) => c.awf?.dir === other)!;
    expect(theirs.workflow).toBe(join(other, "evals/ds/env.ts"));
    expect(theirs.env?.[TRIAL_ENV.root]).toBe(other);
    const trials = readTrials(storeOf(where), nthRun(storeOf(where), 1));
    expect(trials.map((t) => [t.record.column, t.record.awf.version])).toEqual([
      [0, "0.1.1"],
      [1, "0.1.2"],
    ]);
    expect((await lab(where, ["report"])).out).toContain(", env.ts differs");
  });

  test("a case failing in the other folder alone leaves the exit code 0", async () => {
    const { where, other } = twoFolders({ a: {} });
    const fake = scripted({}, undefined, { [other]: { a: [fail] } });
    const { code } = await lab(where, ["run", "--yes", "--against", other], {
      runner: fake.runner,
      inspect,
    });
    expect(code).toBe(0);
  });

  test("a folder missing what it needs stops run before the first trial: 2", async () => {
    const { where, other } = twoFolders({ a: {} });
    const refused = async (args: string[], extra: CasesEnvironment = {}) => {
      const fake = scripted({});
      const result = await lab(where, ["run", "--yes", ...args], {
        runner: fake.runner,
        inspect,
        ...extra,
      });
      expect(result.code).toBe(2);
      expect(fake.calls).toHaveLength(0);
      return result.err;
    };
    expect(await refused(["--against", join(where.top, "nowhere")])).toContain("no such folder");
    expect(await refused(["--against", where.root])).toContain("your checkout");
    expect(
      await refused(["--against", other], {
        inspect: async (root) => {
          if (root === other) {
            throw new Refusal(`${root} can't run trials:\n  @agentswf/lab/cases does not resolve`);
          }
          return inspect(root);
        },
      }),
    ).toContain("@agentswf/lab/cases does not resolve");
    rmSync(join(other, "evals/ds/env.ts"));
    expect(await refused(["--against", other])).toContain("no evals/ds/env.ts there");
  });
});

test("the plan's estimate counts the grading earlier trials were given", async () => {
  const where = project(
    { a: keyWith("expect:\n  ok: true\n") },
    { graders: [{ workflow: "graders/judge.ts" }] },
  );
  graderWorkflow(where, "judge");
  const fake = scripted({}, judged("passed", 0.25));
  await lab(where, ["run", "--yes", "--fresh"], { runner: fake.runner });
  const again = await lab(where, ["run", "--yes", "--fresh", "--trials", "2"], {
    runner: fake.runner,
  });
  expect(again.err).toContain("est. $0.50, grading $0.50 of it");
});

describe("--against, its report and refusals", () => {
  function twoFolders(cases: Record<string, CaseSpec>, dataset: object = {}) {
    const where = project(cases, dataset);
    const other = join(where.top, "other");
    git(where.top, "clone", "-q", where.root, other);
    mkdirSync(join(other, "node_modules", "agentswf"), { recursive: true });
    return { where, other };
  }
  const inspect = async (root: string) => fakeFolder(root);

  test("a checkout with no install of its own is refused, never one above it", async () => {
    const where = project({ a: {} });
    mkdirSync(join(where.root, "node_modules", "agentswf"), { recursive: true });
    const nested = join(where.root, ".worktrees", "b");
    git(where.root, "worktree", "add", "-q", nested);
    const fake = scripted({});
    const { code, err } = await lab(where, ["run", "--yes", "--against", nested], {
      runner: fake.runner,
      inspect,
    });
    expect(code).toBe(2);
    expect(err).toContain("no agentswf installed in it");
    expect(fake.calls).toHaveLength(0);
  });

  test("the cases that came out differently, largest difference first; per-column numbers, time and case tallies; score on two columns", async () => {
    const { where, other } = twoFolders({ x: {}, y: {} }, { graders: ["counts"] });
    writeFileSync(
      join(where.ds, "graders.ts"),
      `export const counts = { kind: "awf.case-grader/0", version: "1.0.0", readsFacts: true,
        grade: ({ facts }) => ({ numbers: { hits: { count: facts.ok ? 1 : 0, of: 1 } } }) };`,
    );
    const fake = scripted({}, undefined, {
      [other]: { x: [fail, fail, fail], y: [pass, fail, pass] },
    });
    const ran = await lab(where, ["run", "--yes", "--trials", "3", "--against", other], {
      runner: fake.runner,
      inspect,
    });
    expect(ran.code).toBe(0);
    const differ = ran.out.split("came out differently in against 1")[1]!.split("\n");
    expect(differ[1]).toMatch(/^ {2}x\s+this checkout 3\/3 passed · against 1 0\/3 failed/);
    expect(differ[2]).toMatch(/^ {2}y\s+this checkout 3\/3 passed · against 1 2\/3 flaky/);
    expect(ran.out).toContain("numbers, against 1: counts hits 2/6 (33%)");
    expect(ran.out).toContain("numbers: counts hits 6/6 (100%)");
    expect(ran.out).toContain("time, median");
    expect(ran.out).toContain("No compare in graders.ts says which is better. Read the cases.");
    const one = await lab(where, ["report", "--case", "x"]);
    expect(one.out).toMatch(/x · run \S+ · passed 3\/3\nagainst 1: failed 0\/3/);
    expect(one.out).toContain("trial 1 (against 1): failed");
    const json = JSON.parse((await lab(where, ["report", "--json"])).out);
    expect(json.columns[0].numbers).toEqual({ counts: { hits: { count: 2, of: 6 } } });
    const scored = await lab(where, ["score", "--yes"], { runner: fake.runner, inspect });
    expect(scored.code).toBe(0);
    expect(scored.out).toContain("columns");
  });

  test("a trial errored in the other column is counted as its own, and still exits 5", async () => {
    const { where, other } = twoFolders({ a: {} });
    const fake = scripted({}, undefined, {
      [other]: { a: [{ setupError: "their env.ts broke" }] },
    });
    const { code, out } = await lab(where, ["run", "--yes", "--against", other], {
      runner: fake.runner,
      inspect,
    });
    expect(out).toContain("errored 1 (1 by dataset), 1 in against 1");
    expect(code).toBe(0);
  });
});

test("each stage's time, recorded per trial and shown as a median; a given stage ran nothing", async () => {
  const where = project({ a: {}, b: {} });
  const fake = scripted({
    a: [
      {
        facts: { ok: true },
        runStages: [
          ["read", 1000, true],
          ["decide", 4000],
          ["act", 300],
        ],
      },
    ],
    b: [
      {
        facts: { ok: true },
        runStages: [
          ["read", 1000, true],
          ["decide", 6000],
          ["act", 500],
        ],
      },
    ],
  });
  const { out } = await lab(where, ["run", "--yes"], { runner: fake.runner });
  expect(out).toContain("time per stage, median across cases: decide 5.0s · act 0.4s");
  const [first] = readTrials(storeOf(where), nthRun(storeOf(where), 1));
  expect(first!.record.stageMs).toEqual({ decide: 4000, act: 300 });
  expect((await lab(where, ["report", "--case", "a"])).out).toContain(
    "time per stage, median: decide 4.0s · act 0.3s",
  );
});

describe("capture: a past run becomes a case", () => {
  test("a trial's run is captured from its case without capture.ts; a taken name gets a number; the key is a draft no grader runs on", async () => {
    const where = project({ a: { files: { "ticket.md": "a broken lid" } } });
    writeFileSync(join(where.ds, "cases/a/input.json"), '{"day":3}');
    const prose =
      "Thank you for writing: we refunded the chipped lid, and we're sorry it arrived so.";
    const fake = scripted({ a: [{ facts: { ok: true, error: null, words: 12, reply: prose } }] });
    await lab(where, ["run", "--yes"], { runner: fake.runner });
    const runId = fake.calls[0]!.id;
    const good = await lab(where, ["capture", runId, "--good"]);
    expect(good.code).toBe(0);
    expect(good.out).toMatch(/evals\/ds\/cases\/a-2, from trial 1 of case a in run \S+/);
    const made = join(where.ds, "cases/a-2");
    expect(readFileSync(join(made, "files/ticket.md"), "utf8")).toBe("a broken lid");
    expect(readFileSync(join(made, "input.json"), "utf8")).toContain('"day": 3');
    const key = readFileSync(join(made, "key.md"), "utf8");
    expect(key).toContain("draft: true");
    expect(key).toContain(`run: "${runId}"`);
    expect(key).toContain("mark: good");
    expect(key).toContain("expect:\n  ok: true\n  words: 12\n  # reply: ");
    // The draft reads as a key, the prose left commented for the person.
    expect(parseKey(key).ok).toBe(true);
    expect(key).not.toContain("error");
    const again = await lab(where, ["capture", runId, "--needs-work", "the reply was rude"]);
    expect(again.out).toContain("cases/a-3");
    const rude = readFileSync(join(where.ds, "cases/a-3/key.md"), "utf8");
    expect(rude).toContain('note: "the reply was rude"');
    expect(rude).not.toContain("expect:");
    // The drafts run, and no grader runs on them.
    const ran = await lab(where, ["run", "--yes", "--cases", "a-2,a-3"], {
      runner: scripted({}).runner,
    });
    expect(ran.out).toContain("no verdict");
    const trials = readTrials(storeOf(where), nthRun(storeOf(where), 2));
    expect(trials.every((t) => t.scores.length === 0)).toBe(true);
  });

  test("a real run becomes cases through the dataset's capture.ts", async () => {
    const where = project({ a: {} });
    const runDir = join(where.root, ".awf/runs/mail-triage/R-7");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "run.json"),
      JSON.stringify({
        format: 1,
        id: "R-7",
        workflow: "mail-triage",
        argv: ["--dry-run"],
        cwd: where.root,
      }),
    );
    writeFileSync(
      join(runDir, "out.json"),
      JSON.stringify({
        outcome: "completed",
        value: {
          read: [
            { id: "m1", short: true },
            { id: "m2", short: false },
          ],
        },
      }),
    );
    writeFileSync(
      join(where.ds, "capture.ts"),
      `export default { kind: "awf.case-capture/0", capture: ({ run }) =>
        run.result.read.map((m) => ({ name: m.id === "m1" ? "a" : m.id, input: { id: m.id }, files: { "email.md": "mail " + m.id }, facts: { short: m.short } })) };`,
    );
    const { code, out } = await lab(where, ["capture", "R-7", "--good"]);
    expect(code).toBe(0);
    expect(out).toContain("cases/a-2, from mail-triage's run R-7");
    expect(out).toContain("cases/m2, from mail-triage's run R-7");
    expect(readFileSync(join(where.ds, "cases/m2/files/email.md"), "utf8")).toBe("mail m2");
    expect(readFileSync(join(where.ds, "cases/m2/key.md"), "utf8")).toContain(
      "expect:\n  short: false",
    );
  });

  test("refusals: no such run, a real run without capture.ts, neither mark or both", async () => {
    const where = project({ a: {} });
    expect((await lab(where, ["capture", "R-1", "--good"])).err).toContain("no run R-1");
    expect((await lab(where, ["capture", "R-1"])).err).toContain("--good or --needs-work");
    expect((await lab(where, ["capture", "R-1", "--good", "--needs-work", "x"])).code).toBe(2);
    const runDir = join(where.root, ".awf/runs/w/R-2");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "run.json"),
      JSON.stringify({ format: 1, id: "R-2", workflow: "w", argv: [] }),
    );
    const none = await lab(where, ["capture", "R-2", "--good"]);
    expect(none.code).toBe(2);
    expect(none.err).toContain("is a real run");
  });
});

describe("capture, what it refuses and keeps whole", () => {
  test("a --good capture whose facts are all prose still writes a key the reader takes", async () => {
    const where = project({ a: {} });
    const prose = "A long reply the agent wrote, which no later run would give back word for word.";
    const fake = scripted({ a: [{ facts: { summary: prose } }] });
    await lab(where, ["run", "--yes"], { runner: fake.runner });
    await lab(where, ["capture", fake.calls[0]!.id, "--good"]);
    const key = readFileSync(join(where.ds, "cases/a-2/key.md"), "utf8");
    expect(key).toContain("# expect:\n  # summary: ");
    expect(parseKey(key).ok).toBe(true);
    expect((await lab(where, ["report"])).code).not.toBe(2);
  });

  test("a real run: --good refused unless its last attempt completed; an id in two workflows refused; a file path that is no file refused", async () => {
    const where = project({ a: {} });
    const realRun = (workflow: string, id: string, attempts: object[], out?: object) => {
      const dir = join(where.root, ".awf/runs", workflow, id);
      mkdirSync(join(dir, "attempts"), { recursive: true });
      writeFileSync(join(dir, "run.json"), JSON.stringify({ format: 1, id, workflow, argv: [] }));
      for (const [i, a] of attempts.entries()) {
        writeFileSync(join(dir, "attempts", `${i + 1}.json`), JSON.stringify(a));
      }
      if (out) writeFileSync(join(dir, "out.json"), JSON.stringify(out));
    };
    writeFileSync(
      join(where.ds, "capture.ts"),
      `export default { kind: "awf.case-capture/0", capture: ({ run }) => [{ name: "c", files: run.argv.includes("dot") ? { ".": "x" } : { "a.md": "x" } }] };`,
    );
    // Attempt 1 completed, attempt 2 is still going: not ended.
    realRun("w", "R-1", [{ outcome: "completed" }, {}], {
      attempt: 1,
      outcome: "completed",
      value: {},
    });
    const going = await lab(where, ["capture", "R-1", "--good"]);
    expect(going.code).toBe(2);
    expect(going.err).toContain("has not ended");
    expect((await lab(where, ["capture", "R-1", "--needs-work", "slow"])).code).toBe(0);
    realRun("w", "R-2", [{ outcome: "completed" }], {
      attempt: 1,
      outcome: "completed",
      value: {},
    });
    realRun("v", "R-2", [{ outcome: "completed" }], {
      attempt: 1,
      outcome: "completed",
      value: {},
    });
    expect((await lab(where, ["capture", "R-2", "--good"])).err).toContain(
      "in more than one workflow's runs",
    );
    const dir = join(where.root, ".awf/runs/w/R-3");
    realRun("w", "R-3", [{ outcome: "completed" }], {
      attempt: 1,
      outcome: "completed",
      value: {},
    });
    writeFileSync(
      join(dir, "run.json"),
      JSON.stringify({ format: 1, id: "R-3", workflow: "w", argv: ["dot"] }),
    );
    const dot = await lab(where, ["capture", "R-3", "--good"]);
    expect(dot.code).toBe(2);
    expect(dot.err).toContain("is no file inside its files/");
    // Nothing half-made is left among the cases.
    expect(readdirSync(join(where.ds, "cases")).sort()).toEqual(["a", "c"]);
    expect(readdirSync(where.ds).filter((n) => n.startsWith(".capture-"))).toEqual([]);
  });
});

describe("--param and --vary: a column per combination of parameters", () => {
  const paramsOf = (calls: readonly RunRequest[]) =>
    calls.map((c) => JSON.parse(c.env?.[TRIAL_ENV.params] ?? "null"));

  test("--vary runs every combination, each trial and grader given its parameters; the reference column decides the exit code", async () => {
    const where = project({ a: {}, b: {} });
    const given: Record<string, string>[] = [];
    const sees: LabGrader = {
      name: "sees",
      grade: async (call) => {
        given.push(call.params);
        return { verdict: "passed", reasons: [] };
      },
    };
    // model=b fails a; the reference column, model=a, passes both.
    const fake = scripted(
      {},
      undefined,
      {},
      {
        "tz=utc model=b effort=low": { a: [fail] },
        "tz=utc model=b effort=high": { a: [fail] },
      },
    );
    const { code, out } = await lab(
      where,
      ["run", "--yes", "--param", "tz=utc", "--vary", "model=a,b", "--vary", "effort=low,high"],
      { runner: fake.runner, graders: [sees] },
    );
    expect(code).toBe(0);
    expect(fake.calls).toHaveLength(8);
    expect(new Set(paramsOf(fake.calls).map((p) => JSON.stringify(p)))).toEqual(
      new Set([
        JSON.stringify({ tz: "utc", model: "a", effort: "low" }),
        JSON.stringify({ tz: "utc", model: "a", effort: "high" }),
        JSON.stringify({ tz: "utc", model: "b", effort: "low" }),
        JSON.stringify({ tz: "utc", model: "b", effort: "high" }),
      ]),
    );
    expect(given).toHaveLength(8);
    expect(given.every((p) => p.tz === "utc")).toBe(true);
    const record = JSON.parse(
      readFileSync(join(storeOf(where), "runs", nthRun(storeOf(where), 1), "run.json"), "utf8"),
    );
    expect(record.columns).toEqual([
      { folder: 0, params: { tz: "utc", model: "a", effort: "low" } },
      { folder: 0, params: { tz: "utc", model: "a", effort: "high" } },
      { folder: 0, params: { tz: "utc", model: "b", effort: "low" } },
      { folder: 0, params: { tz: "utc", model: "b", effort: "high" } },
    ]);
    const trial = JSON.parse(
      readFileSync(
        join(storeOf(where), "runs", nthRun(storeOf(where), 1), "trials", "a", "2-1", "trial.json"),
        "utf8",
      ),
    );
    expect(trial).toMatchObject({ column: 2, params: { model: "b", effort: "low" } });
    expect(out).toContain("params: tz=utc");
    expect(out).toContain(
      "reference column: model=a effort=low; the exit code and history are its",
    );
    expect(out).toMatch(/\n {2}model=b effort=low\s+1\s+1\s/);
    expect(out).toContain("came out differently in model=b effort=high");
    const json = JSON.parse((await lab(where, ["report", "--json"])).out);
    expect(json.params).toEqual({ tz: "utc", model: "a", effort: "low" });
    expect(json.columns.map((c: { label: string }) => c.label)).toEqual([
      "model=a effort=high",
      "model=b effort=low",
      "model=b effort=high",
    ]);
  });

  test("a failure in the reference column alone sets the exit code; another column's never does", async () => {
    const where = project({ a: {} });
    const fake = scripted({}, undefined, {}, { "model=a": { a: [fail] } });
    const { code } = await lab(where, ["run", "--yes", "--vary", "model=b,a"], {
      runner: fake.runner,
    });
    expect(code).toBe(0);
    const again = scripted({}, undefined, {}, { "model=a": { a: [fail] } });
    expect(
      (await lab(where, ["run", "--yes", "--vary", "model=a,b"], { runner: again.runner })).code,
    ).toBe(1);
  });

  test("--vary with --against: each folder under each combination, the folders outermost", async () => {
    const where = project({ a: {} });
    const other = join(where.top, "other");
    git(where.top, "clone", "-q", where.root, other);
    mkdirSync(join(other, "node_modules", "agentswf"), { recursive: true });
    const fake = scripted({});
    const { out } = await lab(where, ["run", "--yes", "--against", other, "--vary", "model=a,b"], {
      runner: fake.runner,
    });
    const record = JSON.parse(
      readFileSync(join(storeOf(where), "runs", nthRun(storeOf(where), 1), "run.json"), "utf8"),
    );
    expect(record.columns).toEqual([
      { folder: 0, params: { model: "a" } },
      { folder: 0, params: { model: "b" } },
      { folder: 1, params: { model: "a" } },
      { folder: 1, params: { model: "b" } },
    ]);
    expect(fake.calls.map((c) => c.env?.[TRIAL_ENV.root])).toEqual([
      where.root,
      where.root,
      other,
      other,
    ]);
    expect(out).toContain("against 1 model=b");
  });

  test("history and --failed follow the reference column: your checkout under the same parameters", async () => {
    const where = project({ a: {}, b: {} });
    // model=a fails a; model=b fails b.
    const plays = { "model=a": { a: [fail] }, "model=b": { b: [fail] } };
    await lab(where, ["run", "--yes", "--fresh", "--vary", "model=a,b"], {
      runner: scripted({}, undefined, {}, plays).runner,
    });
    const onB = scripted({}, undefined, {}, plays);
    await lab(where, ["run", "--yes", "--fresh", "--failed", "--param", "model=b"], {
      runner: onB.runner,
    });
    // Under model=b, the newest verdict that failed is b's, from the earlier run's second column.
    expect(onB.seen.map((s) => s.name)).toEqual(["b"]);
    const shown = await lab(where, ["report", "--json"]);
    const b = JSON.parse(shown.out).cases.find((c: { name: string }) => c.name === "b");
    expect(b.history).toEqual(["failed"]);
    const none = scripted({});
    const plain = await lab(where, ["run", "--yes", "--fresh", "--failed"], {
      runner: none.runner,
    });
    // Without parameters, no earlier run had that column: nothing to run again.
    expect(none.calls).toHaveLength(0);
    expect(plain.out).toContain("nothing to run");
  });

  test("bad parameters are refused before any trial", async () => {
    const where = project({ a: {} });
    const refused = async (argv: string[]) => {
      const { code, err } = await lab(where, ["run", "--yes", ...argv], {
        runner: scripted({}).runner,
      });
      expect(code).toBe(2);
      return err;
    };
    expect(await refused(["--param", "model"])).toContain("give {name}={value}");
    expect(await refused(["--param", "1x=a"])).toContain("give {name}={value}");
    expect(await refused(["--param", "judge.model=a"])).toContain("give {name}={value}");
    expect(await refused(["--param", "m=a", "--vary", "m=b,c"])).toContain("m is given twice");
    expect(await refused(["--vary", "m=a"])).toContain("one is --param m=a");
    expect(await refused(["--vary", "m=a,,b"])).toContain("none empty");
    expect(await refused(["--vary", "m=a,a"])).toContain("each value once");
  });
});

describe("one store per project, run ids, and records to commit", () => {
  const commit = (dir: string, message: string) => {
    git(dir, "add", "-A");
    git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", message);
  };

  test("every worktree of a project shares one store, named by the project and its first commit", async () => {
    const where = project({ a: {} });
    const tree = join(where.top, "tree");
    git(where.root, "worktree", "add", "-q", tree);
    const first = Bun.spawnSync(["git", "rev-list", "--max-parents=0", "HEAD"], { cwd: where.root })
      .stdout.toString()
      .trim()
      .slice(0, 12);
    await lab(where, ["run", "--yes"], { runner: scripted({}).runner });
    await lab({ ...where, root: tree }, ["run", "--yes"], { runner: scripted({}).runner });
    expect(
      readdirSync(join(where.home, ".awf/lab")).filter((n) => n.startsWith("project-")),
    ).toEqual([`project-${first}`]);
    const listed = await lab({ ...where, root: tree }, ["runs"]);
    expect(listed.out.split("\n")).toHaveLength(2);
    // History is your checkout's: the worktree's run has none from the main checkout.
    const json = JSON.parse((await lab({ ...where, root: tree }, ["report", "--json"])).out);
    expect(json.cases[0].history).toEqual([]);
  });

  test("a run is named by its id or the last four characters of it; a built case is kept once", async () => {
    const where = project({ a: {} });
    await lab(where, ["run", "--yes", "--trials", "3"], { runner: scripted({}).runner });
    const id = nthRun(storeOf(where), 1);
    expect(id).toMatch(/^[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$/);
    expect((await lab(where, ["report", id])).out).toContain(`run ${id}`);
    expect((await lab(where, ["report", id.slice(-4)])).out).toContain(`run ${id}`);
    const unknown = await lab(where, ["report", "ffff"]);
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain("no run ffff");
    const wrong = await lab(where, ["report", "7"]);
    expect(wrong.code).toBe(2);
    expect(wrong.err).toContain("or its last four characters");
    expect(readdirSync(join(storeOf(where), "inputs"))).toHaveLength(1);
    const trial = readTrials(storeOf(where), id)[0]!;
    expect(existsSync(join(trial.dir, "input"))).toBe(false);
  });

  test("records: each run's records are written into evals/, and a fresh clone elsewhere reads and grades them", async () => {
    const where = project({ a: {} });
    writeFileSync(
      join(where.evals, "awf-lab.json"),
      JSON.stringify({ kind: "awf.lab-workspace/0", records: "records" }),
    );
    await lab(where, ["run", "--yes", "--trials", "2"], { runner: scripted({}).runner });
    const id = nthRun(storeOf(where), 1);
    const recorded = join(where.evals, "records/runs", id);
    expect(existsSync(join(recorded, "run.json"))).toBe(true);
    expect(readdirSync(join(recorded, "trials/a")).sort()).toEqual(["0-1", "0-2"]);
    // Each grade is a file of its own in the records: two branches that grade never conflict.
    expect(readdirSync(join(recorded, "trials/a/0-1")).sort()).toEqual(["scores", "trial.json"]);
    expect(readdirSync(join(recorded, "trials/a/0-1/scores"))).toHaveLength(1);
    commit(where.root, "records");

    // Another machine: a clone, and a home with no store. It reads the run, and reuses its trials.
    const clone = join(where.top, "clone");
    git(where.top, "clone", "-q", where.root, clone);
    const elsewhere = { ...where, root: clone, home: join(where.top, "home2") };
    mkdirSync(elsewhere.home);
    const shown = await lab(elsewhere, ["report", id.slice(-4)]);
    expect(shown.code).toBe(0);
    expect(shown.out).toContain(`run ${id}`);
    const reran = scripted({});
    const reusedThere = await lab(elsewhere, ["run", "--yes", "--trials", "2"], {
      runner: reran.runner,
    });
    expect(reran.calls).toHaveLength(0);
    expect(reusedThere.err).toContain("reuses 2 of 2 trials");

    // Both machines change the key and grade the run again; both grades survive the merge.
    const failing = keyMd("expect:\n  ok: false\n");
    for (const [at, dir] of [
      [where, where.root],
      [elsewhere, clone],
    ] as const) {
      writeFileSync(join(dir, "evals/ds/cases/a/key.md"), failing);
      const scored = await lab(at, ["score", "--yes", id.slice(-4)], {
        runner: scripted({}).runner,
        now: () => new Date(dir === clone ? "2026-11-18T10:00:01Z" : "2026-11-18T10:00:00Z"),
      });
      expect(scored.code).toBe(1);
      commit(dir, "scored");
    }
    git(
      where.root,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "pull",
      "-q",
      "--no-rebase",
      clone,
      "main",
    );
    expect(readdirSync(join(recorded, "trials/a/0-1/scores"))).toHaveLength(3);
    await lab(where, ["report", id.slice(-4)]);
    const store = readTrials(storeOf(where), id).find((t) => t.record.trial === 1)!;
    expect(store.scores).toHaveLength(3);
  });

  test("records must be a folder inside evals/", async () => {
    const where = project({ a: {} });
    writeFileSync(
      join(where.evals, "awf-lab.json"),
      JSON.stringify({ kind: "awf.lab-workspace/0", records: "../outside" }),
    );
    const { code, err } = await lab(where, ["runs"]);
    expect(code).toBe(2);
    expect(err).toContain("must be a folder inside");
  });
});

describe("trials reused when nothing that shaped them changed", () => {
  const commit = (dir: string) => {
    git(dir, "add", "-A");
    git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "change");
  };

  test("an unchanged run reuses every trial; more trials run only the difference; --fresh runs all", async () => {
    const where = project({ a: {}, b: {} });
    const first = scripted({});
    await lab(where, ["run", "--yes", "--trials", "2"], { runner: first.runner });
    expect(first.calls).toHaveLength(4);
    const again = scripted({ a: [fail] });
    const reused = await lab(where, ["run", "--yes", "--trials", "2"], { runner: again.runner });
    expect(again.calls).toHaveLength(0);
    expect(reused.code).toBe(0);
    expect(reused.err).toContain("reuses 4 of 4 trials: nothing that shaped them changed");
    expect(reused.out).toContain("trials 4 · reused 4");
    const trial = readTrials(storeOf(where), nthRun(storeOf(where), 2))[0]!;
    expect(trial.record.reused?.run).toBe(nthRun(storeOf(where), 1));
    expect(trial.scores).toHaveLength(1);
    // A copy is never counted twice: three trials of a run 1, 2 and 2 again need one new.
    const more = scripted({});
    await lab(where, ["run", "--yes", "--trials", "3"], { runner: more.runner });
    expect(more.calls).toHaveLength(2);
    const fresh = scripted({});
    await lab(where, ["run", "--yes", "--fresh"], { runner: fresh.runner });
    expect(fresh.calls).toHaveLength(2);
  });

  test("a change to what shapes a trial runs it again: the code, env.ts, a parameter, the case, the trial settings", async () => {
    const where = project({ a: {}, b: {} });
    const runs = async (argv: string[] = []) => {
      const fake = scripted({});
      await lab(where, ["run", "--yes", ...argv], { runner: fake.runner });
      return fake.seen.map((s) => s.name).sort();
    };
    expect(await runs()).toEqual(["a", "b"]);
    expect(await runs()).toEqual([]);
    writeFileSync(join(where.root, "workflow.ts"), "export const changed = true;\n");
    expect(await runs()).toEqual(["a", "b"]);
    commit(where.root);
    expect(await runs()).toEqual([]);
    writeFileSync(join(where.ds, "env.ts"), "export default { changed: true };\n");
    expect(await runs()).toEqual(["a", "b"]);
    expect(await runs(["--param", "model=b"])).toEqual(["a", "b"]);
    expect(await runs(["--param", "model=b"])).toEqual([]);
    writeFileSync(join(where.ds, "cases/a/files/more.txt"), "more");
    expect(await runs()).toEqual(["a"]);
    const dataset = JSON.parse(readFileSync(join(where.ds, "dataset.json"), "utf8"));
    writeFileSync(join(where.ds, "dataset.json"), JSON.stringify({ ...dataset, timeout: "5m" }));
    expect(await runs()).toEqual(["a", "b"]);
    // What only grades is not: the bar, and a dataset's graders.
    writeFileSync(
      join(where.ds, "dataset.json"),
      JSON.stringify({ ...dataset, timeout: "5m", pass: "all" }),
    );
    expect(await runs()).toEqual([]);
  });

  test("a key edit grades the reused trials again and runs nothing", async () => {
    const where = project({ a: {} });
    await lab(where, ["run", "--yes"], { runner: scripted({}).runner });
    writeFileSync(join(where.ds, "cases/a/key.md"), keyMd("expect:\n  ok: false\n"));
    const fake = scripted({});
    const { code, err } = await lab(where, ["run", "--yes"], { runner: fake.runner });
    expect(fake.calls).toHaveLength(0);
    expect(err).toContain("grading 1 reused trial again: a key or grader changed");
    expect(code).toBe(1);
    const trial = readTrials(storeOf(where), nthRun(storeOf(where), 2))[0]!;
    expect(trial.scores).toHaveLength(2);
  });

  test("never an errored or leaked trial, nor one older than reuseDays; 0 never reuses", async () => {
    const where = project({ a: {}, b: {} }, { reuseDays: 3 });
    const at = new Date("2026-11-10T12:00:00Z");
    await lab(where, ["run", "--yes"], {
      runner: scripted({ a: [{ setupError: "setup broke" }] }).runner,
      now: () => at,
    });
    const later = scripted({});
    await lab(where, ["run", "--yes"], {
      runner: later.runner,
      now: () => new Date("2026-11-12T12:00:00Z"),
    });
    expect(later.seen.map((s) => s.name)).toEqual(["a"]);
    const past = scripted({});
    await lab(where, ["run", "--yes"], {
      runner: past.runner,
      now: () => new Date("2026-11-20T12:00:00Z"),
    });
    expect(past.seen.map((s) => s.name).sort()).toEqual(["a", "b"]);
    const dataset = JSON.parse(readFileSync(join(where.ds, "dataset.json"), "utf8"));
    writeFileSync(join(where.ds, "dataset.json"), JSON.stringify({ ...dataset, reuseDays: 0 }));
    const never = scripted({});
    await lab(where, ["run", "--yes"], {
      runner: never.runner,
      now: () => new Date("2026-11-20T12:00:01Z"),
    });
    expect(never.calls).toHaveLength(2);
  });
});

describe("the person's labels", () => {
  const runIdOf = (where: { home: string }, run: number, name: string, trial = 1) =>
    readTrials(storeOf(where), nthRun(storeOf(where), run)).find(
      (t) => t.record.case === name && t.record.trial === trial,
    )!.record.runId!;

  test("labels give agreement for good and needs-work apart, with each disagreement", async () => {
    const where = project({ a: {}, b: {}, c: {} });
    await lab(where, ["run", "--yes"], { runner: scripted({ c: [fail] }).runner });
    expect((await lab(where, ["label", runIdOf(where, 1, "a"), "--good"])).out).toBe(
      "labeled a trial 1 good",
    );
    // The lab passed b; the person says it needs work. The lab failed c; the person agrees.
    await lab(where, ["label", runIdOf(where, 1, "b"), "--needs-work", "the date is wrong"]);
    await lab(where, ["label", runIdOf(where, 1, "c"), "--needs-work", "no reply"]);
    const { out } = await lab(where, ["report"]);
    expect(out).toContain("labels: 3 trials · good 1, passed 1 · needs-work 2, failed 1");
    expect(out).toContain("  expect: good 1, passed 1 · needs-work 2, failed 1");
    expect(out).toContain(
      "  disagrees: b trial 1 labeled needs-work: the date is wrong; the lab: passed",
    );
    const json = JSON.parse((await lab(where, ["report", "--json"])).out);
    expect(json.labels).toMatchObject({
      good: { labeled: 1, agreed: 1 },
      needsWork: { labeled: 2, agreed: 1 },
      notCompared: 0,
    });
    const shown = await lab(where, ["report", "--case", "b"]);
    expect(shown.out).toContain("labeled needs-work: the date is wrong");
  });

  test("a label survives reuse, follows a score that grades again, and a newer one or --clear replaces it", async () => {
    const where = project({ a: {} });
    await lab(where, ["run", "--yes"], { runner: scripted({}).runner });
    const id = runIdOf(where, 1, "a");
    await lab(where, ["label", id, "--needs-work", "wrong"]);
    // Reused: the copy is the same workflow run, so it keeps the label.
    const reused = await lab(where, ["run", "--yes"], { runner: scripted({}).runner });
    expect(reused.out).toContain("labels: 1 trial · needs-work 1, failed 0");
    // The key is fixed to fail it: score grades again, and the lab now agrees.
    writeFileSync(join(where.ds, "cases/a/key.md"), keyMd("expect:\n  ok: false\n"));
    const scored = await lab(where, ["score", "--yes"], { runner: scripted({}).runner });
    expect(scored.out).toContain("labels: 1 trial · needs-work 1, failed 1");
    await lab(where, ["label", id, "--good"]);
    expect((await lab(where, ["report"])).out).toContain("labels: 1 trial · good 1, passed 0");
    expect((await lab(where, ["label", id, "--clear"])).out).toBe("cleared the label of a trial 1");
    expect((await lab(where, ["report"])).out).not.toContain("labels:");
  });

  test("capture of a trial labels it; labels go to the records folder and come back", async () => {
    const where = project({ a: {} });
    writeFileSync(
      join(where.evals, "awf-lab.json"),
      JSON.stringify({ kind: "awf.lab-workspace/0", records: "records" }),
    );
    await lab(where, ["run", "--yes"], { runner: scripted({}).runner });
    const id = runIdOf(where, 1, "a");
    await lab(where, ["capture", id, "--needs-work", "too long"]);
    // Each label is a file of its own in the records: two branches that label never conflict.
    const dir = join(where.evals, "records/labels/ds");
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(readFileSync(join(dir, files[0]!), "utf8")).toContain('"note":"too long"');
    // Another machine with the committed records sees the label.
    git(where.root, "add", "-A");
    git(where.root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "labels");
    const clone = join(where.top, "clone");
    git(where.top, "clone", "-q", where.root, clone);
    const elsewhere = { ...where, root: clone, home: join(where.top, "home2") };
    mkdirSync(elsewhere.home);
    expect((await lab(elsewhere, ["report"])).out).toContain("labels: 1 trial · needs-work 1");
  });

  test("label refuses an unknown trial and a missing or doubled verdict", async () => {
    const where = project({ a: {} });
    await lab(where, ["run", "--yes"], { runner: scripted({}).runner });
    const id = runIdOf(where, 1, "a");
    expect((await lab(where, ["label", "nope", "--good"])).err).toContain("no trial ran as nope");
    expect((await lab(where, ["label", id])).code).toBe(2);
    expect((await lab(where, ["label", id, "--good", "--clear"])).code).toBe(2);
  });
});

describe("tags and rates in the report", () => {
  const tagged = (tags: string, expect = "ok: true") =>
    keyMd(`expect:\n  ${expect}\ntags: [${tags}]\n`);

  test("tags group the report and --tags picks cases on run and score; editing tags grades nothing", async () => {
    const where = project({
      a: { key: tagged("forms, school") },
      b: { key: tagged("school") },
      c: { key: tagged("newsletter") },
    });
    const first = await lab(where, ["run", "--yes", "--trials", "2"], {
      runner: scripted({ b: [fail, fail] }).runner,
    });
    expect(first.out).toContain("by tag:");
    expect(first.out).toMatch(/\n {2}forms\s+1\/1 passed\n/);
    expect(first.out).toMatch(/\n {2}school\s+1\/2 passed · failing: b\n/);
    expect(first.out).toContain("rate: 2/3 cases passed, 95% ");
    expect(first.out).toContain("pass^2 2/3 · pass@2 2/3");
    const json = JSON.parse((await lab(where, ["report", "--json"])).out);
    expect(json.tags).toContainEqual({ tag: "school", cases: 2, passed: 1, failing: ["b"] });
    expect(json.rates).toMatchObject({ cases: 3, passed: 2, k: 2, passAll: 2, passAny: 2 });

    const picked = scripted({});
    await lab(where, ["run", "--yes", "--fresh", "--tags", "forms,newsletter"], {
      runner: picked.runner,
    });
    expect(picked.seen.map((s) => s.name).sort()).toEqual(["a", "c"]);

    writeFileSync(join(where.ds, "cases/a/key.md"), tagged("forms, school, trips"));
    const scored = await lab(where, ["score", "--yes"], { runner: scripted({}).runner });
    expect(scored.err).toMatch(/nothing in run \S+ to grade again/);
  });

  test("columns give each one's rates and its paired difference from the reference", async () => {
    const where = project({ a: {}, b: {}, c: {} });
    const fake = scripted({}, undefined, {}, { "model=b": { a: [fail], b: [fail], c: [fail] } });
    const { out } = await lab(where, ["run", "--yes", "--vary", "model=a,b"], {
      runner: fake.runner,
    });
    expect(out).toContain(
      "difference from model=a: −100 points on 3 cases, 95% −100 to −100: no difference shown",
    );
    expect(out).toContain("rates, model=a: 3/3 cases passed");
    expect(out).toContain("rates, model=b: 0/3 cases passed");
    const json = JSON.parse((await lab(where, ["report", "--json"])).out);
    expect(json.columns[0].difference).toMatchObject({ cases: 3, mean: -1, shown: false });
  });
});

describe("compare: a verdict per column, from graders.ts", () => {
  test("the dataset's compare judges each column against the reference; run still runs every trial", async () => {
    const where = project({ a: {}, b: {} });
    // As defineComparison makes it; it sees the reference's and the column's trials.
    writeFileSync(
      join(where.ds, "graders.ts"),
      `export const compare = {
  kind: "awf.case-comparison/0",
  version: "1.2.0",
  compare: ({ reference, column, planned }) => ({
    verdict: column.filter((t) => t.passed).length > reference.filter((t) => t.passed).length ? "better" : "worse",
    stop: true,
    reason: reference.length + " and " + column.length + " trials of " + planned + " cases",
    metrics: [],
  }),
};
`,
    );
    const fake = scripted({ a: [fail, fail] }, undefined, {}, { "model=b": {} });
    const { out } = await lab(where, ["run", "--yes", "--trials", "2", "--vary", "model=a,b"], {
      runner: fake.runner,
    });
    expect(fake.calls).toHaveLength(8);
    expect(out).toContain("compare 1.2.0, model=b: better · 4 and 4 trials of 2 cases");
    expect(out).not.toContain("No compare in graders.ts");
    const json = JSON.parse((await lab(where, ["report", "--json"])).out);
    expect(json.columns[0].compare).toMatchObject({
      version: "1.2.0",
      verdict: { verdict: "better" },
    });
  });

  test("a compare that is not a comparison is reported, not a stop", async () => {
    const where = project({ a: {} });
    writeFileSync(join(where.ds, "graders.ts"), "export const compare = 7;\n");
    const { code, out } = await lab(where, ["run", "--yes", "--vary", "model=a,b"], {
      runner: scripted({}).runner,
    });
    expect(code).toBe(0);
    expect(out).toContain("compare, model=b: could not tell:");
    expect(out).toContain("is not a comparison");
  });
});

describe("run --dry-run, --budget and --json; report --md", () => {
  test("--dry-run prints the plan and runs nothing", async () => {
    const where = project({ a: {}, b: {} });
    const fake = scripted({});
    const { code, out } = await lab(where, ["run", "--dry-run", "--vary", "model=a,b"], {
      runner: fake.runner,
    });
    expect(code).toBe(0);
    expect(fake.calls).toHaveLength(0);
    expect(out).toContain("ds · 2 cases · 1 trial each");
    expect(out).toContain("vary: model=a,b · 2 columns");
    expect(existsSync(join(where.home, ".awf/lab"))).toBe(false);
  });

  test("--budget stops starting trials once their estimates reach it: exit 3, the rest not run", async () => {
    const where = project({ a: {}, b: {}, c: {} });
    const fake = scripted({});
    // Each scripted trial is estimated at $0.001: two reach $0.0015.
    const { code, out, err } = await lab(where, ["run", "--yes", "--budget", "0.0015"], {
      runner: fake.runner,
    });
    expect(err).toContain("stops starting trials once their estimates reach $0.00");
    expect(fake.calls).toHaveLength(2);
    expect(code).toBe(3);
    expect(out).toContain("stopped at --budget: 1 trial not run");
  });

  test("run --json prints the report's JSON; report --md a table to paste", async () => {
    const where = project({ a: {}, b: {} });
    const ran = await lab(where, ["run", "--yes", "--json", "--vary", "model=a,b"], {
      runner: scripted({}, undefined, {}, { "model=b": { b: [fail] } }).runner,
    });
    const json = JSON.parse(ran.out);
    expect(json).toMatchObject({ kind: "awf.case-report/0", exit: 0 });
    expect(json.columns[0].label).toBe("model=b");
    const md = (await lab(where, ["report", "--md"])).out;
    expect(md).toContain("| case | model=a | model=b |");
    expect(md).toContain("| b | passed 1/1 | failed 0/1 |");
    expect(md).toContain("- **model=b**: 1/2 cases passed");
  });
});

describe("what the review of task 9 found", () => {
  test("--failed runs its cases fresh: the trials that failed are never its answer", async () => {
    const where = project({ a: {}, b: {} });
    await lab(where, ["run", "--yes"], { runner: scripted({ a: [fail] }).runner });
    const again = scripted({});
    const { code } = await lab(where, ["run", "--yes", "--failed"], { runner: again.runner });
    expect(again.seen.map((t) => t.name)).toEqual(["a"]);
    expect(code).toBe(0);
  });

  test("a run that only reused trials adds nothing to history", async () => {
    const where = project({ a: {} });
    await lab(where, ["run", "--yes"], { runner: scripted({}).runner });
    for (let i = 0; i < 3; i++) await lab(where, ["run", "--yes"], { runner: scripted({}).runner });
    const json = JSON.parse((await lab(where, ["report", "--json"])).out);
    expect(json.reused).toBe(1);
    expect(json.cases[0].history).toEqual(["passed"]);
  });

  test("two columns that shape trials alike never share a trial", async () => {
    const where = project({ a: {} });
    const other = join(where.top, "other");
    git(where.top, "clone", "-q", where.root, other);
    mkdirSync(join(other, "node_modules", "agentswf"), { recursive: true });
    await lab(where, ["run", "--yes", "--against", other], { runner: scripted({}).runner });
    await lab(where, ["run", "--yes", "--against", other], { runner: scripted({}).runner });
    const trials = readTrials(storeOf(where), nthRun(storeOf(where), 2));
    expect(new Set(trials.map((t) => t.record.runId)).size).toBe(2);
  });

  test("a reused trial is a pointer: its grades stay one list where it ran", async () => {
    const where = project({ a: {} });
    await lab(where, ["run", "--yes"], { runner: scripted({}).runner });
    await lab(where, ["run", "--yes"], { runner: scripted({}).runner });
    const second = nthRun(storeOf(where), 2);
    const slot = join(storeOf(where), "runs", second, "trials/a/0-1");
    expect(readdirSync(slot)).toEqual(["reused.json"]);
    writeFileSync(join(where.ds, "cases/a/key.md"), keyMd("expect:\n  ok: false\n"));
    await lab(where, ["score", "--yes", second.slice(-4)], { runner: scripted({}).runner });
    const first = readTrials(storeOf(where), nthRun(storeOf(where), 1))[0]!;
    expect(first.scores).toHaveLength(2);
  });

  test("the plan prices grading reused trials again, and --budget covers it", async () => {
    const where = project(
      { a: keyWith("expect:\n  ok: true\n") },
      { graders: [{ workflow: "graders/judge.ts" }] },
    );
    graderWorkflow(where, "judge");
    const fake = scripted({}, judged("passed", 0.25));
    await lab(where, ["run", "--yes", "--trials", "2"], { runner: fake.runner });
    writeFileSync(
      join(where.ds, "graders/judge.ts"),
      readFileSync(join(where.ds, "graders/judge.ts"), "utf8").replace(
        'version: "1.0.0"',
        'version: "1.1.0"',
      ),
    );
    const again = scripted({}, judged("passed", 0.25));
    const { code, err, out } = await lab(
      where,
      ["run", "--yes", "--trials", "2", "--budget", "0.2"],
      {
        runner: again.runner,
      },
    );
    expect(err).toContain("grades 2 reused trials again, a key or grader changed: est. $0.50");
    expect(again.graded).toHaveLength(1);
    expect(code).toBe(3);
    expect(out).toContain("stopped at --budget");
  });

  test("report with no run named shows your checkout's newest, not another worktree's", async () => {
    const where = project({ a: {} });
    const tree = join(where.top, "tree");
    git(where.root, "worktree", "add", "-q", tree);
    await lab(where, ["run", "--yes"], { runner: scripted({}).runner });
    await lab({ ...where, root: tree }, ["run", "--yes", "--fresh"], {
      runner: scripted({}).runner,
    });
    const mine = (await lab(where, ["report"])).out;
    expect(mine).toContain(`run ${nthRun(storeOf(where), 1)}`);
  });

  test("never a leaked or stopped trial is reused", async () => {
    const where = project({ a: {}, b: {} });
    await lab(where, ["run", "--yes"], {
      runner: scripted({
        a: [{ stop: "out of turns" }],
        b: [{ facts: { ok: true, leak: MARKER } }],
      }).runner,
    });
    const again = scripted({});
    await lab(where, ["run", "--yes"], { runner: again.runner });
    expect(again.seen.map((t) => t.name).sort()).toEqual(["a", "b"]);
  });

  test("run ids stay in the order runs were made, a second apart when they share one", async () => {
    const where = project({ a: {} });
    const at = () => new Date("2026-11-18T10:00:00.500Z");
    for (let i = 0; i < 3; i++) {
      await lab(where, ["run", "--yes", "--fresh"], { runner: scripted({}).runner, now: at });
    }
    const ids = runIds(storeOf(where));
    expect(ids.map((id) => id.slice(0, 15))).toEqual([
      "20261118-100000",
      "20261118-100001",
      "20261118-100002",
    ]);
  });
});
