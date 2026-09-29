import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OutputRecord } from "../packages/contract/src/records";
import { runOperatorCli } from "../packages/engine/src/operator-cli";
import { createSingleSessionHostFactory } from "../packages/harness/src/single-session-host";
import { createFakeAdapter } from "../packages/harness/src/testing/fake";
import { digestFixture } from "../packages/lab/src/review/fixtures/seal";
import { type AnswerKey, KEY_FORMAT } from "../packages/lab/src/review/format/format";
import type {
  ReportDocument,
  RunDocument,
  ShowDocument,
} from "../packages/lab/src/review/format/output";
import { checkWith, type Score, type Trial } from "../packages/lab/src/review/format/records";
import { runLab } from "../packages/lab/src/review/lab/cli";
import { AWF, awfArgv, type Runner, type RunRequest } from "../packages/lab/src/review/lab/runner";

const REVIEW_INDEX = join(import.meta.dir, "../packages/lab/src/review/index.ts");
const CANNED = join(import.meta.dir, "fixtures/lab/canned.workflow.ts");
const EXACT = join(import.meta.dir, "fixtures/lab/exact-judge.workflow.ts");

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const run = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
  return run.stdout.toString().trim();
}

const mechanism = (caseId: string, n: number) => `${caseId} issue ${n}: what goes wrong`;

function keyOf(caseId: string): AnswerKey {
  const issue = (n: number, severity: "must-fix" | "should-fix") => ({
    id: `K${n}`,
    mechanism: mechanism(caseId, n),
    visibleIn: "diff" as const,
    severity,
    category: "correctness" as const,
    scope: "change" as const,
    locations: [{ path: "src/app.ts", start: 1, end: 1 }],
    confirmation: { basis: "verified" as const, how: "traced" },
    sources: [{ commit: "c".repeat(40) }],
  });
  return {
    format: KEY_FORMAT,
    fixture: caseId,
    revision: 1,
    draftedBy: "hand",
    procedure: "hand",
    issues: [issue(1, "must-fix"), issue(2, "should-fix")],
    refuted: [],
    excluded: [],
  };
}

type Workspace = {
  root: string;
  heads: Record<string, string>;
  answers: string;
  variant: (name: string, body?: string) => Promise<string>;
  scorer: (name: string, mode: string) => Promise<string>;
};

const CONFIG = {
  clone: "project",
  datasets: "datasets",
  dataset: "first",
  results: "results",
  runs: "runs",
  variants: ["ideas/*.variant.ts"],
  scorers: ["scorers/*.scorer.ts"],
  scorer: "exact",
};

/**
 * A workspace with a sealed dataset of two cases cut from one project, a config, and a
 * tsconfig.json that finds the package, as a real one outside awf must.
 */
async function workspace(): Promise<Workspace> {
  const root = mkdtempSync(join(tmpdir(), "awf-lab-test-"));
  roots.push(root);
  const project = join(root, "project");
  mkdirSync(join(project, "src"), { recursive: true });
  git(project, "init", "--quiet", "--initial-branch", "main");
  git(project, "config", "user.email", "t@example.com");
  git(project, "config", "user.name", "t");
  await Bun.write(join(project, "src/app.ts"), "export const a = 1;\n");
  git(project, "add", ".");
  git(project, "commit", "--quiet", "-m", "base");
  const base = git(project, "rev-parse", "HEAD");
  const dataset = join(root, "datasets", "first");
  const heads: Record<string, string> = {};
  const entries = [];
  for (const [n, id] of ["app-1", "app-2"].entries()) {
    git(project, "checkout", "--quiet", "-b", id, base);
    await Bun.write(join(project, "src/app.ts"), `export const a = ${n + 2};\n`);
    git(project, "commit", "--quiet", "-am", id);
    const head = git(project, "rev-parse", "HEAD");
    heads[id] = head;
    const dir = join(dataset, id);
    mkdirSync(join(dir, "key"), { recursive: true });
    git(project, "update-ref", "refs/fixture/head", head);
    git(
      project,
      "bundle",
      "create",
      "--quiet",
      join(dir, "snapshot.bundle"),
      "refs/fixture/head",
      `^${base}`,
    );
    await Bun.write(
      join(dir, "fixture.json"),
      JSON.stringify({
        format: "awf.review-fixture/1",
        id,
        source: {
          forge: "gitlab",
          project: "group/app",
          number: n + 1,
          url: `https://gitlab.example/group/app/-/merge_requests/${n + 1}`,
          state: "merged",
        },
        snapshot: { version: 1, base, head, at: "2026-06-01T00:00:00Z" },
        request: { asOf: "2026-06-01T00:00:00Z", removed: [] },
      }),
    );
    await Bun.write(join(dir, "request.md"), `# Change ${id}\n\nIt changes a.\n`);
    await Bun.write(join(dir, "key", "key.json"), JSON.stringify(keyOf(id)));
    entries.push({ id, at: "2026-06-01T00:00:00Z", digest: await digestFixture(dir) });
  }
  git(project, "checkout", "--quiet", "main");
  await Bun.write(
    join(dataset, "set.json"),
    JSON.stringify({
      format: "awf.fixture-set/1",
      name: "first",
      builtAt: "2026-06-02T00:00:00Z",
      builder: "test",
      fixtures: entries,
      excluded: [],
    }),
  );
  await Bun.write(join(root, "awf-lab.json"), JSON.stringify(CONFIG));
  await Bun.write(
    join(root, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { paths: { "@agentswf/lab/review": [REVIEW_INDEX] } } }),
  );
  const answers = join(root, "answers.json");
  await Bun.write(answers, JSON.stringify({}));
  mkdirSync(join(root, "ideas"));
  mkdirSync(join(root, "scorers"));
  const ws: Workspace = {
    root,
    heads,
    answers,
    async variant(name, body) {
      const file = join(root, "ideas", `${name}.variant.ts`);
      await Bun.write(
        file,
        body ??
          `import { defineReviewVariant } from "@agentswf/lab/review";
import type canned from ${JSON.stringify(CANNED)};

export default defineReviewVariant<typeof canned>({
  workflow: new URL(${JSON.stringify(`file://${CANNED}`)}),
  argv: ["--answers", ${JSON.stringify(answers)}, "--head", "{head}", "--request", "{request}", "--range", "{base}...HEAD"],
  timeout: "1m",
  read: (result) => result.findings.map((f) => ({ path: f.file, line: f.line, text: f.claim })),
});
`,
      );
      return file;
    },
    async scorer(name, mode) {
      const file = join(root, "scorers", `${name}.scorer.ts`);
      await Bun.write(
        file,
        `import { defineReviewJudge } from "@agentswf/lab/review";

export default defineReviewJudge({
  workflow: new URL(${JSON.stringify(`file://${EXACT}`)}),
  argv: ["--mode", ${JSON.stringify(mode)}],
  timeout: "1m",
});
`,
      );
      return file;
    },
  };
  await ws.scorer("exact", "plain");
  return ws;
}

async function answer(ws: Workspace, byCase: Record<string, unknown>) {
  const byHead = Object.fromEntries(
    Object.entries(byCase).map(([id, findings]) => [ws.heads[id]!, findings]),
  );
  await Bun.write(ws.answers, JSON.stringify(byHead));
}

const finding = (claim: string) => ({ file: "src/app.ts", line: 1, claim });

/** A variant or scorer file's text, declaring `version`. */
const withVersion = (text: string, version: string) =>
  text.replace(`timeout: "1m",`, `timeout: "1m",\n  version: ${JSON.stringify(version)},`);
const fileOf = (ws: Workspace, path: string) => Bun.file(join(ws.root, path)).text();

/** `awf run` in-process with no agents, so no login is probed; `spend` prices every run. */
function inProcess(options: { spend?: number } = {}) {
  const calls: RunRequest[] = [];
  const runner: Runner = async (request) => {
    calls.push(request);
    const output: string[] = [];
    const errors: string[] = [];
    const started = Date.now();
    const exitCode = await runOperatorCli(awfArgv(request), {
      cwd: request.cwd,
      stdout: (text) => output.push(text),
      stderr: (text) => errors.push(text),
      installRuntime: async () => ({
        config: {
          aliases: {},
          host: createSingleSessionHostFactory(createFakeAdapter({ script: () => ({}) })),
        },
        cleanup: async () => undefined,
      }),
    });
    const text = output.join("\n").trim();
    const record = text.startsWith("{") ? (JSON.parse(text) as OutputRecord) : undefined;
    if (record && options.spend !== undefined) record.accounting.totals.estimate = options.spend;
    return {
      exitCode,
      stderr: errors.join("\n"),
      ms: Date.now() - started,
      ...(record ? { record } : {}),
    };
  };
  return { runner, calls, trials: () => calls.filter((c) => c.workflow === CANNED).length };
}

async function lab(ws: Workspace, argv: string[], runner?: Runner, confirm = true) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runLab(argv, {
    cwd: ws.root,
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
    ...(runner ? { runner } : {}),
    confirm: async () => confirm,
  });
  return { exitCode, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

/** A command's `--json`, checked against the schema `awf-lab schema` prints for its format. */
async function json<T>(ws: Workspace, argv: string[], runner?: Runner): Promise<T> {
  const { exitCode, stdout, stderr } = await lab(ws, [...argv, "--json"], runner);
  if (exitCode !== 0 && exitCode !== 1) throw new Error(stderr);
  const document = JSON.parse(stdout);
  const printed = await lab(ws, ["schema", document.format]);
  expect(printed.exitCode).toBe(0);
  const checked = checkWith(JSON.parse(printed.stdout), document);
  if (!checked.ok) throw new Error(`${document.format}: ${JSON.stringify(checked.problems)}`);
  return document as T;
}

const report = (ws: Workspace, ...argv: string[]) => json<ReportDocument>(ws, ["report", ...argv]);

const recordsIn = (ws: Workspace, pattern: string) => [
  ...new Bun.Glob(pattern).scanSync({ cwd: join(ws.root, "results", "first") }),
];

describe("awf-lab", () => {
  let ws: Workspace;
  beforeEach(async () => {
    ws = await workspace();
  });

  test("run then report gives the numbers, and a second run runs nothing", async () => {
    await ws.variant("canned");
    await answer(ws, {
      "app-1": [
        finding(mechanism("app-1", 1)),
        finding("a vague remark"),
        finding(mechanism("app-1", 1)),
      ],
      "app-2": [finding(mechanism("app-2", 2))],
    });
    const runs = inProcess();
    const first = await lab(ws, ["run", "canned"], runs.runner);
    expect(first.stderr).toContain("app-1: trial succeeded, 3 findings");
    expect(first.exitCode).toBe(0);
    // Every trial, then every score, in the seeded order: a scorer never runs beside a trial.
    expect(runs.calls.map((c) => c.workflow)).toEqual([CANNED, CANNED, EXACT, EXACT]);
    const trial = runs.calls[0]!;
    expect(trial.argv).toContain(`${git(join(ws.root, "project"), "rev-parse", "main")}...HEAD`);
    expect(trial.argv.join(" ")).not.toContain("{");
    expect(recordsIn(ws, "*/app-1/*/score.*.k1.1.json")).toHaveLength(1);

    const numbers = (await report(ws, "canned")).columns[0]!;
    expect(numbers.cases.map((c) => c.id).toSorted()).toEqual(["app-1", "app-2"]);
    expect(numbers.bySeverity["must-fix"]).toEqual({ total: 2, hit: 1 });
    expect(numbers.bySeverity["should-fix"]).toEqual({ total: 2, hit: 1 });
    expect(numbers.weightedRecall).toBe((3 + 2) / 10);
    expect(numbers.distinct).toBe(3);
    expect(numbers.precision).toBe(2 / 3);
    expect(numbers.noise).toBe(1 / 3);
    expect(numbers.labels.duplicate).toBe(1);
    expect(numbers.missed.map((m) => `${m.id} ${m.issue}`)).toEqual(["app-2 K1"]);

    const again = inProcess();
    expect((await lab(ws, ["run", "canned"], again.runner)).exitCode).toBe(0);
    expect(again.calls).toHaveLength(0);
    const plan = await lab(ws, ["run", "canned", "--dry-run"]);
    expect(plan.stdout).toContain("0 trials and 0 scores to run");
  });

  test("an edit that keeps {major}.{minor} keeps the results; a minor bump runs again", async () => {
    await ws.variant("canned");
    await answer(ws, { "app-1": [finding(mechanism("app-1", 1))], "app-2": [] });
    expect((await lab(ws, ["run", "canned"], inProcess().runner)).exitCode).toBe(0);

    // The scorer's argv changed, its version didn't: the researcher says it scores the same.
    await ws.scorer("exact", "strict");
    const same = inProcess();
    expect((await lab(ws, ["run", "canned"], same.runner)).exitCode).toBe(0);
    expect(same.calls).toHaveLength(0);
    await Bun.write(
      join(ws.root, "scorers/exact.scorer.ts"),
      withVersion(await fileOf(ws, "scorers/exact.scorer.ts"), "1.1.0"),
    );
    const rescore = inProcess();
    expect((await lab(ws, ["run", "canned"], rescore.runner)).exitCode).toBe(0);
    // app-2's trial found nothing, so its score is recorded without a scorer's run.
    expect(rescore.calls.map((c) => c.workflow)).toEqual([EXACT]);

    const edited = await fileOf(ws, "ideas/canned.variant.ts");
    await ws.variant("canned", withVersion(`${edited}// a change\n`, "1.0.1"));
    const patched = inProcess();
    expect((await lab(ws, ["run", "canned"], patched.runner)).exitCode).toBe(0);
    expect(patched.calls).toHaveLength(0);
    await ws.variant("canned", withVersion(edited, "2.0.0"));
    const again = inProcess();
    expect((await lab(ws, ["run", "canned"], again.runner)).exitCode).toBe(0);
    expect(again.trials()).toBe(2);
    const bad = await ws.variant("canned", withVersion(edited, "2.0"));
    expect((await lab(ws, ["run", "canned"])).stderr).toContain(
      `${bad}: version 2.0 is not {major}.{minor}.{patch}`,
    );
  });

  test("score never runs a variant, and skips a case it has no trial of", async () => {
    await ws.variant("canned");
    await answer(ws, { "app-1": [finding(mechanism("app-1", 1))], "app-2": [finding("x")] });
    expect(
      (await lab(ws, ["run", "canned", "--cases", "app-1"], inProcess().runner)).exitCode,
    ).toBe(0);
    await ws.scorer("again", "again");
    const scored = inProcess();
    const run = await lab(ws, ["score", "canned", "--scorer", "again"], scored.runner);
    expect(run.exitCode).toBe(0);
    expect(scored.trials()).toBe(0);
    expect(scored.calls.map((c) => c.workflow)).toEqual([EXACT]);
    const plan = await lab(ws, ["score", "canned", "--scorer", "again", "--dry-run"]);
    expect(plan.stdout).toMatch(/app-2 +skip: no trial on file/);
    expect(plan.stdout).toMatch(/app-1 +reuse trial \S+; reuse score/);
  });

  test("a budget stops before a step that would cross it, exits 3, and a second run resumes", async () => {
    await ws.variant("canned");
    await answer(ws, { "app-1": [finding("a")], "app-2": [finding("b")] });
    const priced = inProcess({ spend: 1 });
    const stopped = await lab(ws, ["run", "canned", "--budget", "1.5"], priced.runner);
    expect(stopped.exitCode).toBe(3);
    // No history: the first trial runs; the second is then estimated at $1, and $2 crosses $1.5.
    expect(priced.calls.map((c) => c.workflow)).toEqual([CANNED]);
    expect(stopped.stderr).toContain("budget: stopped before the trial of");

    const resumed = inProcess({ spend: 1 });
    expect((await lab(ws, ["run", "canned", "--budget", "10"], resumed.runner)).exitCode).toBe(0);
    expect(resumed.calls.map((c) => c.workflow)).toEqual([CANNED, EXACT, EXACT]);
    expect((await report(ws, "canned")).columns[0]!.cases).toHaveLength(2);
  });

  test("oracle and nop score 1 and 0 through the whole path, and the baseline wins nothing", async () => {
    const control = (workflow: string, argv: string) =>
      `import { defineReviewVariant, ${workflow} } from "@agentswf/lab/review";

export default defineReviewVariant({
  workflow: ${workflow},
  argv: ${argv},
  timeout: "1m",
  read: (findings) => findings as never,
});
`;
    await ws.variant(
      "oracle",
      control("ORACLE_WORKFLOW", JSON.stringify(["--set", "{dataset}", "--head", "{head}"])),
    );
    await ws.variant("nop", control("NOP_WORKFLOW", "[]"));
    const runs = inProcess();
    expect((await lab(ws, ["run", "oracle", "nop"], runs.runner)).exitCode).toBe(0);
    const both = await report(ws, "oracle", "--baseline", "nop");
    const [oracle, nop] = both.columns;
    expect(oracle!.weightedRecall).toBe(1);
    expect(oracle!.recall["must-fix"]).toBe(1);
    expect(oracle!.precision).toBe(1);
    expect(nop!.weightedRecall).toBe(0);
    expect(nop!.distinct).toBe(0);
    expect(both.baseline?.name).toBe("nop");
    expect(both.comparison!.against.map((a) => ({ ...a, won: a.won.toSorted() }))).toEqual([
      { variant: "oracle", won: ["oracle:app-1", "oracle:app-2"], lost: [], tied: [] },
    ]);
    const text = await lab(ws, ["report", "oracle", "--baseline", "nop"]);
    expect(text.stdout).toMatch(/cases won +2 +0/);
    // --where lost: the cases the baseline did better on; none for the oracle, both for nop.
    expect(
      (await report(ws, "oracle", "--baseline", "nop", "--where", "lost")).columns[0]!.cases,
    ).toEqual([]);
    const lost = await report(ws, "nop", "--baseline", "oracle", "--where", "lost");
    expect(lost.comparison!.against[0]!.lost.toSorted()).toEqual(["nop:app-1", "nop:app-2"]);
  });

  test("a report of several variants lists the cases only some have, instead of counting them", async () => {
    await ws.variant("canned");
    await ws.variant(
      "other",
      (await Bun.file(join(ws.root, "ideas/canned.variant.ts")).text()).replace(`"1m"`, `"2m"`),
    );
    await answer(ws, { "app-1": [finding(mechanism("app-1", 1))], "app-2": [finding("x")] });
    const runs = inProcess();
    expect((await lab(ws, ["run", "canned"], runs.runner)).exitCode).toBe(0);
    expect((await lab(ws, ["run", "other", "--cases", "app-1"], runs.runner)).exitCode).toBe(0);
    const both = await report(ws, "canned", "--baseline", "other");
    expect(both.comparison!.cases).toEqual(["app-1"]);
    expect(both.columns[0]!.cases.map((c) => c.id)).toEqual(["canned:app-1"]);
    expect(both.columns[0]!.missing).toEqual([
      { id: "canned:app-2", why: "another column doesn't count it" },
    ]);
    expect(both.columns[1]!.missing).toEqual([{ id: "other:app-2", why: "no trial" }]);
    expect(both.comparison!.against[0]!.tied).toEqual(["canned:app-1"]);
    // A version with no trials yet is named and left out, not a reason to count nothing.
    await ws.variant(
      "fresh",
      (await Bun.file(join(ws.root, "ideas/canned.variant.ts")).text()).replace(`"1m"`, `"3m"`),
    );
    const fresh = await report(ws, "canned", "fresh", "--baseline", "other");
    expect(fresh.columns.map((c) => c.name)).toEqual(["canned", "other"]);
    expect(fresh.leftOut).toEqual([{ variant: "fresh", scorer: "exact" }]);
    expect(fresh.comparison!.cases).toEqual(["app-1"]);
    const text = await lab(ws, ["report", "canned", "--baseline", "other"]);
    expect(text.stdout).toContain("canned vs other");
    expect(text.stdout).toContain("not counted  no trial, 1 case: other:app-2");
    expect(text.stdout).toContain(
      "not counted  another column doesn't count it, 1 case: canned:app-2",
    );
    expect(text.stdout).toContain("dataset first · 1 case ·");
    await ws.scorer("again", "again");
    const scorers = await lab(ws, ["report", "other", "--scorer", "exact", "--scorer", "again"]);
    expect(scorers.stdout).toContain("not counted  no trial, 1 case: app-2\n");
    const md = await lab(ws, ["report", "canned", "--baseline", "other", "--md"]);
    expect(md.stdout).toContain("| | canned | other |");
    expect(md.stdout).toContain("- not counted: no trial, 1 case: other:app-2");
  });

  test("run takes several variants: every trial of each, then every score, by address", async () => {
    await ws.variant("canned");
    await ws.variant(
      "other",
      (await Bun.file(join(ws.root, "ideas/canned.variant.ts")).text()).replace(`"1m"`, `"2m"`),
    );
    await answer(ws, { "app-1": [finding("a")], "app-2": [finding("b")] });
    const runs = inProcess();
    const both = await json<RunDocument>(ws, ["run", "canned", "other"], runs.runner);
    expect(runs.calls.map((c) => c.workflow)).toEqual([
      CANNED,
      CANNED,
      CANNED,
      CANNED,
      EXACT,
      EXACT,
      EXACT,
      EXACT,
    ]);
    // In the seeded order, app-2 first.
    expect(both.steps.map((s) => s.id)).toEqual([
      "canned:app-2",
      "canned:app-1",
      "other:app-2",
      "other:app-1",
    ]);
    expect(
      both.steps.every((s) => s.trial.outcome === "succeeded" && s.score.status === "scored"),
    ).toBe(true);
    expect(both.outcome).toEqual({ exitCode: 0, listPrice: 0, stopped: false });
    expect((await lab(ws, ["run", "canned", "canned"])).exitCode).toBe(2);
  });

  test("a failed trial is a result: recorded with its outcome, scored as nothing, reused", async () => {
    await ws.variant("canned");
    await answer(ws, { "app-1": "throw", "app-2": [finding(mechanism("app-2", 1))] });
    const runs = inProcess();
    expect((await lab(ws, ["run", "canned"], runs.runner)).exitCode).toBe(0);
    const numbers = (await report(ws, "canned")).columns[0]!;
    expect(numbers.failedTrials).toEqual(["app-1"]);
    expect(numbers.bySeverity["must-fix"]).toEqual({ total: 2, hit: 1 });
    const again = inProcess();
    expect((await lab(ws, ["run", "canned"], again.runner)).exitCode).toBe(0);
    expect(again.calls).toHaveLength(0);
    // --where failed: the failed trial's case.
    const failed = await json<RunDocument>(ws, [
      "score",
      "canned",
      "--where",
      "failed",
      "--dry-run",
    ]);
    expect(failed.steps.map((s) => s.id)).toEqual(["app-1"]);
  });

  test("usage errors exit 2: an unknown placeholder, an unknown variant, a bad flag", async () => {
    await ws.variant(
      "typo",
      (await ws.variant("canned").then((f) => Bun.file(f).text())).replace("{head}", "{sha}"),
    );
    const typo = await lab(ws, ["run", "typo", "--dry-run"]);
    expect(typo.exitCode).toBe(2);
    expect(typo.stderr).toContain("{sha} is not a placeholder");
    const nobody = await lab(ws, ["run", "nobody", "--dry-run"]);
    expect(nobody.exitCode).toBe(2);
    expect(nobody.stderr).toContain("no variant named nobody");
    expect(nobody.stderr).not.toContain("usage:");
    expect((await lab(ws, ["run", "canned", "--dataset", "second"])).exitCode).toBe(2);
    expect((await lab(ws, ["run", "canned", "--scorer", "nobody"])).exitCode).toBe(2);
    expect((await lab(ws, ["report", "canned", "canned"])).exitCode).toBe(2);
    expect((await lab(ws, ["run", "canned", "--cases", "0"])).exitCode).toBe(2);
    expect((await lab(ws, ["run", "canned", "--cases", "zz*"])).exitCode).toBe(2);
    expect((await lab(ws, ["report", "canned", "--frobnicate"])).exitCode).toBe(2);
    expect((await lab(ws, ["run", "canned", "--trials", "3"])).stderr).toContain(
      "more than one trial per case comes with variant-matrix-runner",
    );
    expect((await lab(ws, ["run", "canned", "--where", "sideways"])).exitCode).toBe(2);
    expect((await lab(ws, ["run", "canned", "--where", "lost"])).stderr).toContain(
      "--where lost needs a --baseline",
    );
    expect((await lab(ws, ["run", "canned", "--rest-from", "exact"])).exitCode).toBe(2);
    expect(
      (await lab(ws, ["report", "canned", "--scorer", "exact", "--scorer", "exact"])).exitCode,
    ).toBe(2);
    expect((await lab(ws, ["list", "things"])).exitCode).toBe(2);
    expect((await lab(ws, ["schema", "awf.nothing/1"])).exitCode).toBe(2);
    expect((await lab(ws, ["frobnicate"])).exitCode).toBe(2);
  });

  test("the first command line's flags, commands and config keys fail with exit 2, naming what replaced them", async () => {
    await ws.variant("canned");
    for (const [argv, replacement] of [
      [["run", "canned", "--set", "first"], "--set is now --dataset"],
      [["run", "canned", "--fixtures", "1"], "--fixtures is now --cases"],
      [["run", "canned", "--judge", "exact"], "--judge is now --scorer"],
      [["score", "canned", "--base", "exact"], "--base is now --rest-from"],
      [["run", "canned", "--repeats", "2"], "--repeats is now --trials"],
      [["run", "canned", "--judge-only"], "--judge-only is now the score command"],
      [["config"], "config is now list"],
      [["plan", "canned"], "plan is now run --dry-run, or score --dry-run"],
    ] as const) {
      const failed = await lab(ws, [...argv]);
      expect(failed.exitCode).toBe(2);
      expect(failed.stderr).toContain(replacement);
    }
    await Bun.write(
      join(ws.root, "awf-lab.json"),
      JSON.stringify({ ...CONFIG, sets: "datasets", set: "first", judge: "exact" }),
    );
    const config = await lab(ws, ["list"]);
    expect(config.exitCode).toBe(2);
    expect(config.stderr).toContain(
      `"sets" is now "datasets", "set" is now "dataset", "judge" is now "scorer"`,
    );
  });

  test("moving a variant file keeps its records, renaming it doesn't; the awf it runs is where the runner says", async () => {
    expect(existsSync(AWF)).toBe(true);
    await ws.variant("canned");
    await answer(ws, { "app-1": [finding("x")], "app-2": [] });
    expect((await lab(ws, ["run", "canned"], inProcess().runner)).exitCode).toBe(0);
    mkdirSync(join(ws.root, "elsewhere"));
    copyFileSync(
      join(ws.root, "ideas/canned.variant.ts"),
      join(ws.root, "elsewhere/canned.variant.ts"),
    );
    const twin = await lab(ws, ["run", "elsewhere/canned.variant.ts", "--dry-run"]);
    expect(twin.exitCode).toBe(2);
    expect(twin.stderr).toContain("is named canned, as");
    expect(
      (await lab(ws, ["run", join(ws.root, "ideas/canned.variant.ts"), "--dry-run"])).exitCode,
    ).toBe(0);
    mkdirSync(join(ws.root, "ideas/kept"));
    renameSync(
      join(ws.root, "ideas/canned.variant.ts"),
      join(ws.root, "ideas/kept/canned.variant.ts"),
    );
    const moved = await lab(ws, ["run", "ideas/kept/canned.variant.ts", "--dry-run"]);
    expect(moved.stdout).toContain("0 trials and 0 scores to run");
    renameSync(
      join(ws.root, "ideas/kept/canned.variant.ts"),
      join(ws.root, "ideas/kept/renamed.variant.ts"),
    );
    const renamed = await lab(ws, ["run", "ideas/kept/renamed.variant.ts", "--dry-run"]);
    expect(renamed.stdout).toContain("2 trials and 2 scores to run");
  });

  test("a failed score exits 1, is kept as a failure, and the next run scores only", async () => {
    await ws.variant("canned");
    await ws.scorer("exact", "bad");
    await answer(ws, { "app-1": [finding("x")], "app-2": [] });
    const first = await lab(ws, ["run", "canned"], inProcess().runner);
    expect(first.exitCode).toBe(1);
    expect(first.stderr).toContain(
      "score failed, the labels fail their check: /labels/0: K99 is not an issue in the key",
    );
    const numbers = (await report(ws, "canned")).columns[0]!;
    expect(numbers.missing).toContainEqual({
      id: "app-1",
      why: "its score failed, run again to retry",
    });
    const retried = inProcess();
    expect((await lab(ws, ["run", "canned"], retried.runner)).exitCode).toBe(1);
    expect(retried.calls.map((c) => c.workflow)).toEqual([EXACT]);
    const shown = await json<ShowDocument>(ws, ["show", "canned", "app-1"]);
    expect(shown.scores[0]).toMatchObject({
      status: "failed",
      reason: "the labels fail their check",
    });
  });

  test("with a history, a budget stops before a step whose estimate would cross it", async () => {
    await ws.variant("canned");
    await answer(ws, { "app-1": [finding("a")], "app-2": [finding("b")] });
    expect(
      (await lab(ws, ["run", "canned", "--cases", "1"], inProcess({ spend: 1 }).runner)).exitCode,
    ).toBe(0);
    const none = inProcess({ spend: 1 });
    expect((await lab(ws, ["run", "canned", "--budget", "0.5"], none.runner)).exitCode).toBe(3);
    expect(none.calls).toHaveLength(0);
    const one = inProcess({ spend: 1 });
    const stopped = await lab(ws, ["run", "canned", "--budget", "1.5"], one.runner);
    expect(stopped.exitCode).toBe(3);
    expect(one.calls.map((c) => c.workflow)).toEqual([CANNED]);
    expect(stopped.stderr).toContain("budget: stopped before scoring");
    const estimate = await json<RunDocument>(ws, ["run", "canned", "--dry-run"]);
    expect(estimate.estimate).toEqual({ trials: 0, scores: 1, usd: 1 });
  });

  test("--jobs runs steps at once, and keeps the labels a run one at a time keeps", async () => {
    const findings = {
      "app-1": [finding(mechanism("app-1", 1)), finding("a vague remark")],
      "app-2": [finding(mechanism("app-2", 2))],
    };
    await ws.variant("canned");
    await answer(ws, findings);
    expect((await lab(ws, ["run", "canned"], inProcess().runner)).exitCode).toBe(0);
    const alone = (await report(ws, "canned")).columns[0]!;

    const other = await workspace();
    await other.variant("canned");
    await answer(other, findings);
    const runs = inProcess();
    let now = 0;
    let most = 0;
    const counted: Runner = async (request) => {
      most = Math.max(most, ++now);
      await Bun.sleep(50);
      try {
        return await runs.runner(request);
      } finally {
        now -= 1;
      }
    };
    expect((await lab(other, ["run", "canned", "--jobs", "2"], counted)).exitCode).toBe(0);
    expect(most).toBe(2);
    expect(runs.calls.map((c) => c.workflow)).toEqual([CANNED, CANNED, EXACT, EXACT]);
    const together = (await report(other, "canned")).columns[0]!;
    expect(together.labels).toEqual(alone.labels);
    expect(together.bySeverity).toEqual(alone.bySeverity);
    expect(together.cases.map((c) => c.id).sort()).toEqual(alone.cases.map((c) => c.id).sort());
    expect((await lab(ws, ["run", "canned", "--jobs", "0"])).exitCode).toBe(2);
  });

  test("with --jobs, a step starts only if its estimate fits beside the running ones'", async () => {
    await ws.variant("canned");
    await ws.scorer("exact", "bad");
    await answer(ws, { "app-1": [finding("a")], "app-2": [finding("b")] });
    expect((await lab(ws, ["run", "canned"], inProcess({ spend: 1 }).runner)).exitCode).toBe(1);
    // Both scores failed, so both are due again, each estimated at $1 from the history.
    const parallel = inProcess({ spend: 1 });
    const stopped = await lab(
      ws,
      ["score", "canned", "--budget", "1.5", "--jobs", "2"],
      parallel.runner,
    );
    expect(parallel.calls.map((c) => c.workflow)).toEqual([EXACT]);
    expect(stopped.stderr).toContain("budget: stopped before scoring");

    // A running step that costs less than its estimate leaves room: the waiting one then starts.
    const cheaper = inProcess({ spend: 0.2 });
    const both = await lab(
      ws,
      ["score", "canned", "--budget", "1.5", "--jobs", "2"],
      cheaper.runner,
    );
    expect(cheaper.calls.map((c) => c.workflow)).toEqual([EXACT, EXACT]);
    expect(both.stderr).not.toContain("budget: stopped");
  });

  test("a declined plan exits 4 and runs nothing; a case that can't be restored exits 1", async () => {
    await ws.variant("canned");
    const declined = inProcess();
    expect((await lab(ws, ["run", "canned"], declined.runner, false)).exitCode).toBe(4);
    expect(declined.calls).toHaveLength(0);
    rmSync(join(ws.root, "datasets/first/app-1/snapshot.bundle"));
    const broken = inProcess();
    const run = await lab(ws, ["run", "canned"], broken.runner);
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("app-1: ");
    expect(broken.trials()).toBe(1);
  });

  test("a trial whose run never started is run again, not reused as a zero", async () => {
    await ws.variant("canned");
    await answer(ws, { "app-1": [finding("x")], "app-2": [] });
    const refused: Runner = async () => ({ exitCode: 2, stderr: "awf: no login", ms: 1 });
    const first = await lab(ws, ["run", "canned", "--cases", "app-1"], refused);
    expect(first.stderr).toContain("app-1: trial failed, 0 findings");
    const again = inProcess();
    expect((await lab(ws, ["run", "canned", "--cases", "app-1"], again.runner)).exitCode).toBe(0);
    expect(again.trials()).toBe(1);
  });

  test("list shows datasets, cases, variants and scorers with their versions and stored versions", async () => {
    await ws.variant("canned");
    await answer(ws, { "app-1": [finding("x")], "app-2": [] });
    expect(
      (await lab(ws, ["run", "canned", "--cases", "app-1"], inProcess().runner)).exitCode,
    ).toBe(0);
    const shown = await lab(ws, ["list"]);
    expect(shown.exitCode).toBe(0);
    expect(shown.stdout).toMatch(/dataset +first +2 cases/);
    expect(shown.stdout).toMatch(/variant +canned +1\.0\.0 +\//);
    expect(shown.stdout).toMatch(/canned@1\.0 +1 case, 1 trial \(current\)/);
    expect(shown.stdout).toMatch(/scorer +exact +1\.0\.0 +\//);
    expect(shown.stdout).toMatch(/scorer +panel +\d+\.\d+\.\d+ /);
    // An edit that keeps the version adds to that version's results; the version is the identity.
    await ws.variant("canned", `${await fileOf(ws, "ideas/canned.variant.ts")}// a change\n`);
    expect((await lab(ws, ["run", "canned"], inProcess().runner)).exitCode).toBe(0);
    const listed = await json<{ variants: { stored: Record<string, unknown>[] }[] }>(ws, [
      "list",
      "variants",
    ]);
    expect(listed.variants[0]!.stored).toHaveLength(1);
    expect(listed.variants[0]!.stored[0]).not.toHaveProperty("hashes");
    expect((await lab(ws, ["list", "variants"])).stdout).toMatch(
      /canned@1\.0 +2 cases, 2 trials \(current\)/,
    );
    expect((await lab(ws, ["report", "canned"])).stdout).not.toContain("hash");
    const cases = await json<{ cases: { id: string }[] }>(ws, ["list", "cases", "--cases", "1"]);
    expect(cases.cases).toHaveLength(1);
    await json(ws, ["list"]);
    await json(ws, ["schema"]);
  });

  test("a new version keeps the old one's records; name@version reads, reports and scores it, never runs it", async () => {
    await ws.variant("canned");
    await answer(ws, { "app-1": [finding(mechanism("app-1", 1))], "app-2": [finding("x")] });
    expect((await lab(ws, ["run", "canned"], inProcess().runner)).exitCode).toBe(0);
    expect((await report(ws, "canned")).columns[0]!.version).toBe("1.0.0");
    const edited = await fileOf(ws, "ideas/canned.variant.ts");
    await ws.variant("canned", withVersion(edited, "1.1.0"));
    await answer(ws, { "app-1": [finding("x")], "app-2": [finding("x")] });
    expect((await lab(ws, ["run", "canned"], inProcess().runner)).exitCode).toBe(0);

    const old = "canned@1.0";
    const both = await report(ws, "canned", "--baseline", old);
    expect(both.columns.map((c) => c.name)).toEqual(["canned", old]);
    expect(both.comparison!.against[0]!.lost).toEqual(["canned:app-1"]);
    // Copied from the report, the lost case's address runs the new version there: nothing to do.
    const lost = both.comparison!.against[0]!.lost;
    const rerun = await json<RunDocument>(ws, [
      "run",
      "canned",
      "--only",
      lost.join(","),
      "--dry-run",
    ]);
    expect(rerun.steps.map((s) => s.id)).toEqual(["app-1"]);

    const run = await lab(ws, ["run", old]);
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain("is a stored version; only a file can run");
    await ws.scorer("again", "again");
    const rescored = inProcess();
    const scored = await lab(ws, ["score", old, "--scorer", "again"], rescored.runner);
    expect(scored.exitCode).toBe(0);
    expect(rescored.calls.map((c) => c.workflow)).toEqual([EXACT, EXACT]);
    expect((await lab(ws, ["report", "canned@9"])).stderr).toContain(
      "no stored version of canned matches 9",
    );
    // A full version names its {major}.{minor}; a prefix the file's version covers is the file.
    expect((await report(ws, "canned@1.0.0")).columns[0]!.version).toBe("1.0.0");
    expect((await report(ws, "canned@1")).columns[0]!.version).toBe("1.1.0");
    expect((await lab(ws, ["report", "canned@v1-0000"])).stderr).toContain("is not a version");
  });

  test("two scorers: each's numbers side by side, how alike they label, and where they differ", async () => {
    await ws.variant("canned");
    await answer(ws, {
      "app-1": [finding(mechanism("app-1", 1)), finding("vague")],
      "app-2": [finding(mechanism("app-2", 2))],
    });
    expect((await lab(ws, ["run", "canned"], inProcess().runner)).exitCode).toBe(0);
    await ws.scorer("noisy", "noise");
    expect(
      (await lab(ws, ["score", "canned", "--scorer", "noisy"], inProcess().runner)).exitCode,
    ).toBe(0);
    const two = await report(ws, "canned", "--scorer", "exact", "--scorer", "noisy");
    expect(two.columns.map((c) => c.scorer)).toEqual(["exact", "noisy"]);
    expect(two.agreement![0]!.findings).toBe(3);
    expect(two.agreement![0]!.differ).toEqual([
      { id: "app-2#0", labels: ["hit:K2", "noise"] },
      { id: "app-1#0", labels: ["hit:K1", "noise"] },
    ]);
    const text = await lab(ws, ["report", "canned", "--scorer", "exact", "--scorer", "noisy"]);
    expect(text.stdout).toContain("  app-1#0  exact hit:K1, noisy noise");
    // --where differs= chooses the same findings, and show prints each scorer's label for one.
    const chosen = await json<RunDocument>(ws, [
      "score",
      "canned",
      "--scorer",
      "noisy",
      "--where",
      "differs=noisy",
      "--dry-run",
    ]);
    expect(chosen.steps.map((s) => [s.id, s.score.picked])).toEqual([
      ["app-2", [0]],
      ["app-1", [0]],
    ]);
    const shown = await json<ShowDocument>(ws, [
      "show",
      "canned",
      "app-1#0",
      "--scorer",
      "exact",
      "--scorer",
      "noisy",
    ]);
    expect(shown.findings).toHaveLength(1);
    expect(shown.findings[0]!.labels.map((l) => [l.scorer, l.category])).toEqual([
      ["exact", "hit:K1"],
      ["noisy", "noise"],
    ]);
    expect(shown.findings[0]!.labels[0]!.issue?.id).toBe("K1");
    // The address show prints goes back into --only.
    const again = await json<RunDocument>(ws, [
      "score",
      "canned",
      "--only",
      shown.findings[0]!.id,
      "--dry-run",
    ]);
    expect(again.steps.map((s) => [s.id, s.score.do, s.score.picked])).toEqual([
      ["app-1", "partial", [0]],
    ]);
  });

  test("--where split chooses the findings the scorer's voters labelled differently", async () => {
    await ws.variant("canned");
    await ws.scorer("exact", "split");
    await answer(ws, {
      "app-1": [finding(mechanism("app-1", 1)), finding("vague")],
      "app-2": [finding("vague")],
    });
    expect((await lab(ws, ["run", "canned"], inProcess().runner)).exitCode).toBe(0);
    await ws.scorer("noisy", "noise");
    const plan = await json<RunDocument>(ws, [
      "score",
      "canned",
      "--scorer",
      "noisy",
      "--where",
      "split",
      "--dry-run",
    ]);
    expect(plan.steps.map((s) => [s.id, s.score.picked])).toEqual([["app-1", [0]]]);
    const text = await lab(ws, ["show", "canned", "app-1", "--where", "split"]);
    expect(text.stdout).toContain("app-1#0");
    expect(text.stdout).not.toContain("app-1#1");
    expect(text.stdout).toContain("panel b: noise — b says noise");
    const label = await json<RunDocument>(ws, [
      "score",
      "canned",
      "--where",
      "label=noise",
      "--dry-run",
    ]);
    expect(label.steps.map((s) => [s.id, s.score.picked])).toEqual([
      ["app-2", [0]],
      ["app-1", [1]],
    ]);
    const both = await json<RunDocument>(ws, [
      "score",
      "canned",
      "--where",
      "label=noise",
      "--only",
      "app-2",
      "--dry-run",
    ]);
    expect(both.steps.map((s) => s.id)).toEqual(["app-2"]);
  });

  test("score --only scores the chosen findings over the rest-from score, keeps the rest, and is never counted", async () => {
    await ws.variant("canned");
    await answer(ws, {
      "app-1": [finding(mechanism("app-1", 1)), finding("vague"), finding(mechanism("app-1", 2))],
      "app-2": [finding("x")],
    });
    expect((await lab(ws, ["run", "canned"], inProcess().runner)).exitCode).toBe(0);
    const before = await report(ws, "canned");
    await ws.scorer("noisy", "noise");

    // #1 is named; #2 is a hit after it, which #1 could take, so it is asked again too.
    const plan = await lab(ws, [
      "score",
      "canned",
      "--scorer",
      "noisy",
      "--only",
      "app-1#1",
      "--dry-run",
    ]);
    expect(plan.stdout).toMatch(
      /app-1 +reuse trial \S+; score #1 and #2, which depend on them, the rest from exact/,
    );
    const chosen = inProcess();
    const run = await lab(
      ws,
      ["score", "canned", "--scorer", "noisy", "--only", "app-1#1"],
      chosen.runner,
    );
    expect(run.exitCode).toBe(0);
    expect(chosen.trials()).toBe(0);
    expect(chosen.calls.map((c) => c.workflow)).toEqual([EXACT]);
    expect(chosen.calls[0]!.argv).toContain("--settled");
    expect(run.stderr).toContain("app-1#1: was noise, now noise");
    expect(run.stderr).toContain("app-1#2: was hit:K2, now noise (asked again");
    expect(run.stderr).toContain(
      "1 of 1 named findings scored: 1 as before, 0 as one of its voters, 0 as neither",
    );

    const partials = recordsIn(ws, "*/app-1/*/partial.*.json");
    expect(partials).toHaveLength(1);
    const record = await Bun.file(join(ws.root, "results", "first", partials[0]!)).json();
    expect(record.format).toBe("awf.review-partial/2");
    expect(record.picked).toEqual([1]);
    expect(record.asked).toEqual([1, 2]);
    expect(record.restFrom.scorer.name).toBe("exact");
    expect(record.restFrom.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    // #0 was settled and kept though this scorer calls everything else noise.
    expect(record.result.judgement.labels.map((l: { label: string }) => l.label)).toEqual([
      "hit",
      "noise",
      "noise",
    ]);

    // show reads a scorer with only partial scores from its latest, on the findings it asked.
    const shown = await json<ShowDocument>(ws, [
      "show",
      "canned",
      "app-1",
      "--scorer",
      "exact",
      "--scorer",
      "noisy",
    ]);
    expect(shown.scores[1]).toMatchObject({
      status: "partial",
      asked: [1, 2],
      restFrom: { name: "exact" },
    });
    expect(shown.findings.map((f) => f.labels.map((l) => `${l.scorer} ${l.category}`))).toEqual([
      ["exact hit:K1"],
      ["exact noise", "noisy noise"],
      ["exact hit:K2", "noisy noise"],
    ]);

    // Never counted: the report is as it was, and a whole score by the same scorer scores in full.
    expect(await report(ws, "canned")).toEqual(before);
    const whole = await lab(ws, ["score", "canned", "--scorer", "noisy", "--dry-run"]);
    expect(whole.stdout).toMatch(/app-1 +reuse trial [^;]+; score$/m);

    // The same scorer, rest-from score and findings reuse the partial score; two --only flags add up.
    const again = inProcess();
    const rerun = await json<RunDocument>(
      ws,
      ["score", "canned", "--scorer", "noisy", "--only", "app-1#1"],
      again.runner,
    );
    expect(again.calls).toHaveLength(0);
    expect(rerun.compared?.map((c) => [c.id, c.was, c.now])).toEqual([
      ["app-1#1", "noise", "noise"],
      ["app-1#2", "hit:K2", "noise"],
    ]);
    const both = await lab(ws, [
      "score",
      "canned",
      "--scorer",
      "noisy",
      "--only",
      "app-1#1",
      "--only",
      "app-2/1#0",
      "--dry-run",
    ]);
    expect(both.stdout).toMatch(/app-2 +reuse trial \S+; score #0, the rest from exact/);
  });

  test("--only with a scorer that doesn't take --settled fails before any agent, and keeps nothing", async () => {
    await ws.variant("canned");
    await answer(ws, { "app-1": [finding(mechanism("app-1", 1)), finding("vague")], "app-2": [] });
    expect((await lab(ws, ["run", "canned"], inProcess().runner)).exitCode).toBe(0);
    const run = await lab(
      ws,
      ["score", "canned", "--scorer", "panel", "--only", "app-1#1"],
      inProcess().runner,
    );
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("may not take --settled");
    expect(recordsIn(ws, "*/app-1/*/partial.*.json")).toHaveLength(0);
  });

  test("--only fails a partial score whose scorer changed a settled label", async () => {
    await ws.variant("canned");
    await answer(ws, { "app-1": [finding(mechanism("app-1", 1)), finding("vague")], "app-2": [] });
    expect((await lab(ws, ["run", "canned"], inProcess().runner)).exitCode).toBe(0);
    await ws.scorer("tamper", "tamper");
    const run = await lab(
      ws,
      ["score", "canned", "--scorer", "tamper", "--only", "app-1#1"],
      inProcess().runner,
    );
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("the scorer changed labels it was given as settled");
    expect(run.stderr).toContain("app-1#1: was noise, now not scored");
  });

  test("--only usage errors exit 2: a finding, case, trial or rest-from score that isn't there", async () => {
    await ws.variant("canned");
    await answer(ws, { "app-1": [finding("x")], "app-2": [] });
    expect((await lab(ws, ["run", "canned"], inProcess().runner)).exitCode).toBe(0);
    const missing = await lab(ws, ["score", "canned", "--only", "app-1#3"]);
    expect(missing.exitCode).toBe(2);
    expect(missing.stderr).toMatch(/has 1 findings, so no #3/);
    expect((await lab(ws, ["score", "canned", "--only", "app-9#0"])).exitCode).toBe(2);
    expect((await lab(ws, ["score", "canned", "--only", "app-1/2"])).stderr).toContain(
      "one trial per case until variant-matrix-runner",
    );
    expect((await lab(ws, ["score", "canned", "--only", "other:app-1"])).stderr).toContain(
      "other is not one of canned",
    );
    expect((await lab(ws, ["score", "canned", "--only", "app-1##"])).exitCode).toBe(2);
    await ws.scorer("other", "other");
    const noRest = await lab(ws, ["score", "canned", "--only", "app-1#0", "--rest-from", "other"]);
    expect(noRest.exitCode).toBe(2);
    expect(noRest.stderr).toContain("no passing score by the --rest-from scorer");
    expect((await lab(ws, ["show", "canned", "app-1#5"])).exitCode).toBe(2);
    expect((await lab(ws, ["show", "canned"])).exitCode).toBe(2);
  });

  test("records in the first formats, from before versions, read as they did", async () => {
    await ws.variant("canned");
    await answer(ws, {
      "app-1": [finding(mechanism("app-1", 1)), finding("vague")],
      "app-2": [finding(mechanism("app-2", 2))],
    });
    expect((await lab(ws, ["run", "canned"], inProcess().runner)).exitCode).toBe(0);
    const before = await report(ws, "canned");
    const dir = join(ws.root, "results", "first");
    for (const file of recordsIn(ws, "*/*/*/findings.json")) {
      const {
        format: _f,
        dataset,
        case: kase,
        ...rest
      }: Trial = await Bun.file(join(dir, file)).json();
      const { version: _v, ...variant } = rest.variant;
      await Bun.write(
        join(dir, file),
        JSON.stringify({
          format: "awf.review-findings/1",
          ...rest,
          variant,
          set: dataset,
          fixture: kase,
        }),
      );
    }
    for (const file of recordsIn(ws, "*/*/*/score.*.json")) {
      const {
        format: _f,
        scorer,
        dataset,
        case: kase,
        trial,
        result,
        ...rest
      }: Score = await Bun.file(join(dir, file)).json();
      const v1 =
        result.status === "scored" ? { status: "judged", judgement: result.judgement } : result;
      const { version: _v, ...judge } = scorer;
      await Bun.write(
        join(dir, file),
        JSON.stringify({
          format: "awf.review-score/1",
          ...rest,
          judge,
          set: dataset,
          fixture: kase,
          review: trial,
          result: v1,
        }),
      );
    }
    expect(await report(ws, "canned")).toEqual(before);
    const again = inProcess();
    expect((await lab(ws, ["run", "canned"], again.runner)).exitCode).toBe(0);
    expect(again.calls).toHaveLength(0);
    // A new version's score is written beside the old one, in the second format.
    await ws.scorer("exact", "strict");
    await Bun.write(
      join(ws.root, "scorers/exact.scorer.ts"),
      withVersion(await fileOf(ws, "scorers/exact.scorer.ts"), "1.1.0"),
    );
    expect(
      (await lab(ws, ["score", "canned", "--cases", "app-2"], inProcess().runner)).exitCode,
    ).toBe(0);
    const trialDir = readdirSync(join(dir, "canned@1.0", "app-2"))[0]!;
    expect(readdirSync(join(dir, "canned@1.0", "app-2", trialDir)).sort()).toEqual([
      "findings.json",
      "score.exact@1.0.k1.1.json",
      "score.exact@1.1.k1.1.json",
    ]);
  });
});
