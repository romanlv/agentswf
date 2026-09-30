import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { OutputRecord } from "../packages/contract/src/records";
import { runOperatorCli } from "../packages/engine/src/operator-cli";
import { createSingleSessionHostFactory } from "../packages/harness/src/single-session-host";
import { createFakeAdapter } from "../packages/harness/src/testing/fake";
import type {
  CheckDocument,
  ReportDocument,
  RunDocument,
  ShowDocument,
} from "../packages/lab/src/review/format/output";
import type { Score, Trial } from "../packages/lab/src/review/format/records";
import { checkSchema } from "../packages/lab/src/review/format/validate";
import { runLab } from "../packages/lab/src/review/lab/cli";
import { AWF, awfArgv, type Runner, type RunRequest } from "../packages/lab/src/review/lab/runner";
import { createFakeSandboxProvider } from "../packages/sandbox/src/testing/fake";
import {
  CANNED,
  CONFIG,
  git,
  mechanism,
  workspace as newWorkspace,
  type Workspace,
} from "./lab-workspace";

const TRIAL = "trial";
const SCORE = "score";
/** What a run was: `awf run` runs the variant or scorer file itself. */
const stepOf = (request: RunRequest) => (request.workflow.endsWith(".scorer.ts") ? SCORE : TRIAL);

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

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
        // What a trial's `--sandbox` opens; the variants here open no agents to put in it.
        sandboxes: {
          installed: {
            srt: createFakeSandboxProvider().provider,
            docker: createFakeSandboxProvider().provider,
          },
          default: "srt",
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
  return { runner, calls, trials: () => calls.filter((c) => stepOf(c) === TRIAL).length };
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
  if (!stdout) throw new Error(`no output: ${stderr}`);
  const document = JSON.parse(stdout);
  const printed = await lab(ws, ["schema", document.format]);
  expect(printed.exitCode).toBe(0);
  const checked = checkSchema(JSON.parse(printed.stdout), document);
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
    ws = await newWorkspace();
    roots.push(ws.root);
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
    expect(runs.calls.map(stepOf)).toEqual([TRIAL, TRIAL, SCORE, SCORE]);
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
    expect(rescore.calls.map(stepOf)).toEqual([SCORE]);

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
    expect(scored.calls.map(stepOf)).toEqual([SCORE]);
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
    expect(priced.calls.map(stepOf)).toEqual([TRIAL]);
    expect(stopped.stderr).toContain("budget: stopped before the trial of");

    const resumed = inProcess({ spend: 1 });
    expect((await lab(ws, ["run", "canned", "--budget", "10"], resumed.runner)).exitCode).toBe(0);
    expect(resumed.calls.map(stepOf)).toEqual([TRIAL, SCORE, SCORE]);
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
    expect(
      both.comparison!.against.map(({ verdict: _, ...a }) => ({ ...a, won: a.won.toSorted() })),
    ).toEqual([{ variant: "oracle", won: ["oracle:app-1", "oracle:app-2"], lost: [], tied: [] }]);
    // The dataset's two cases are too few for an interval, and all it has: undecided, and done.
    expect(both.comparison!.rule).toEqual({ name: "default", version: "1.0.0" });
    expect(both.comparison!.against[0]!.verdict).toMatchObject({
      verdict: "undecided",
      stop: true,
      reason: "2 cases with recall.weighted: too few for an interval; won 2, tied 0, lost 0",
    });
    const text = await lab(ws, ["report", "oracle", "--baseline", "nop"]);
    expect(text.stdout).toMatch(/verdict +undecided/);
    expect(text.stdout).not.toContain("cases won");
    expect(text.stdout).toMatch(/undecided +oracle by default 1.0.0: 2 cases/);

    // --where lost: the cases the baseline did better on; none for the oracle, both for nop.
    expect(
      (await report(ws, "oracle", "--baseline", "nop", "--where", "lost")).columns[0]!.cases,
    ).toEqual([]);
    const lost = await report(ws, "nop", "--baseline", "oracle", "--where", "lost");
    expect(lost.comparison!.against[0]!.lost.toSorted()).toEqual(["nop:app-1", "nop:app-2"]);
  });

  test("a comparison of the project's own replaces the package's, and is checked", async () => {
    const control = (workflow: string) =>
      `import { defineReviewVariant, ${workflow} } from "@agentswf/lab/review";

export default defineReviewVariant({ workflow: ${workflow}, argv: ${workflow === "NOP_WORKFLOW" ? "[]" : `["--set", "{dataset}", "--head", "{head}"]`}, timeout: "1m", read: (findings) => findings as never });
`;
    await ws.variant("oracle", control("ORACLE_WORKFLOW"));
    await ws.variant("nop", control("NOP_WORKFLOW"));
    expect((await lab(ws, ["run", "oracle", "nop"], inProcess().runner)).exitCode).toBe(0);
    const comparison = (name: string, body: string) =>
      Bun.write(
        join(ws.root, `comparisons/${name}.compare.ts`),
        `import { defineComparison, perCase } from "@agentswf/lab/compare";

export default ${body};
`,
      );
    await comparison(
      "any-gain",
      `defineComparison({
  version: "0.1.0",
  compare({ baseline, challenger, metrics, planned }) {
    const recall = metrics.find((m) => m.name === "recall.weighted")!;
    const theirs = perCase(baseline, recall);
    const gain = [...perCase(challenger, recall)].every(([id, v]) => v > (theirs.get(id) ?? 1));
    return { verdict: gain ? "better" : "undecided", stop: gain, reason: \`every one of \${planned} gained\`, metrics: [] };
  },
})`,
    );
    await comparison(
      "loose",
      `defineComparison({ version: "1", compare: () => ({ verdict: "better", stop: true, reason: "x", metrics: [] }) })`,
    );
    await comparison(
      "sloppy",
      `defineComparison({ version: "1.0.0", compare: () => ({ verdict: "maybe", reason: "" }) as never })`,
    );
    await comparison(
      "throws",
      `defineComparison({ version: "1.0.0", compare: () => { throw new Error("no rule yet"); } })`,
    );

    // By path, before the workspace lists it; then by name, from the config's globs and default.
    const byPath = await report(
      ws,
      "oracle",
      "--baseline",
      "nop",
      "--comparison",
      "comparisons/any-gain.compare.ts",
    );
    expect(byPath.comparison!.rule).toEqual({ name: "any-gain", version: "0.1.0" });
    expect(byPath.comparison!.against[0]!.verdict).toMatchObject({
      verdict: "better",
      reason: "every one of 2 gained",
    });
    const config = join(ws.root, "awf-lab.json");
    await Bun.write(
      config,
      JSON.stringify({
        ...CONFIG,
        comparisons: ["comparisons/*.compare.ts"],
        comparison: "any-gain",
      }),
    );
    expect((await report(ws, "oracle", "--baseline", "nop")).comparison!.rule!.name).toBe(
      "any-gain",
    );
    const listed = await json<{ comparisons: { name: string; version: string | null }[] }>(ws, [
      "list",
      "comparisons",
    ]);
    expect(listed.comparisons.map((c) => [c.name, c.version])).toEqual([
      ["any-gain", "0.1.0"],
      ["loose", null],
      ["sloppy", "1.0.0"],
      ["throws", "1.0.0"],
      ["default", "1.0.0"],
    ]);

    // A version that isn't semver, a verdict out of shape, and a throw each name the comparison.
    const failing = async (name: string) =>
      (await lab(ws, ["report", "oracle", "--baseline", "nop", "--comparison", name])).stderr;
    expect(await failing("loose")).toContain("version 1 is not {major}.{minor}.{patch}");
    expect(await failing("sloppy")).toContain("comparison sloppy 1.0.0: its verdict is not valid");
    expect(await failing("throws")).toContain("comparison throws 1.0.0: no rule yet");

    // What can't be compared is a usage error; a selection by hand gives no verdict, and says why.
    const usage = (argv: string[]) => lab(ws, ["report", "oracle", ...argv]);
    expect((await usage(["--baseline", "nop", "--comparison", "x"])).exitCode).toBe(2);
    expect((await usage(["--comparison", "default"])).exitCode).toBe(2);
    expect(
      (await usage(["--baseline", "nop", "--only", "app-1", "--comparison", "default"])).exitCode,
    ).toBe(2);
    const byHand = await report(ws, "oracle", "--baseline", "nop", "--only", "app-1");
    expect(byHand.comparison!.rule).toBeUndefined();
    expect(byHand.comparison!.noVerdict).toBe("--only picks cases by hand");
    expect(
      (await lab(ws, ["report", "oracle", "--baseline", "nop", "--only", "app-1"])).stdout,
    ).toMatch(/no verdict +--only picks cases by hand/);

    // A config naming a comparison that isn't there shows in list, which says why.
    await Bun.write(
      config,
      JSON.stringify({ ...CONFIG, comparisons: ["comparisons/*.compare.ts"], comparison: "tpyo" }),
    );
    const typo = await lab(ws, ["list"]);
    expect(typo.exitCode).toBe(1);
    expect(typo.stdout).toContain("compare   tpyo: no comparison named tpyo; known: any-gain");

    // The package's own name is taken.
    await comparison(
      "default",
      `defineComparison({ version: "1.0.0", compare: () => ({ verdict: "tie", stop: true, reason: "x", metrics: [] }) })`,
    );
    expect((await lab(ws, ["list"])).stderr).toContain(
      "a comparison named default shadows the package's own",
    );
  });

  test("several trials a case: run adds the missing ones, report counts a case once all are scored", async () => {
    await ws.variant("canned");
    await answer(ws, { "app-1": [finding(mechanism("app-1", 1))], "app-2": [] });
    expect((await lab(ws, ["run", "canned"], inProcess().runner)).exitCode).toBe(0);
    // Trial 1 found app-1's must-fix; trial 2 finds nothing.
    await answer(ws, { "app-1": [], "app-2": [] });

    const plan = await lab(ws, ["run", "canned", "--trials", "2", "--dry-run"]);
    expect(plan.stdout).toMatch(/app-1\/1 +reuse trial \S+; reuse score/);
    expect(plan.stdout).toMatch(/app-1\/2 +trial; score/);
    expect(plan.stdout).toContain("2 trials and 2 scores to run");

    // Only app-1's second trial: app-2 has one of two, so it isn't counted yet.
    const runs = inProcess();
    expect(
      (await lab(ws, ["run", "canned", "--trials", "2", "--only", "app-1"], runs.runner)).exitCode,
    ).toBe(0);
    expect(runs.trials()).toBe(1);
    const partial = await report(ws, "canned", "--trials", "2");
    expect(partial.trials).toBe(2);
    expect(partial.columns[0]!.cases.map((c) => c.id)).toEqual(["app-1/1", "app-1/2"]);
    expect(partial.columns[0]!.missing).toEqual([
      { id: "app-2", why: "1 of 2 trials on file; awf-lab run runs the rest" },
    ]);
    // Pooled over both trials: the must-fix found once in two.
    expect(partial.columns[0]!.bySeverity["must-fix"]).toEqual({ total: 2, hit: 1 });
    expect((await lab(ws, ["report", "canned", "--trials", "2"])).stdout).toContain(
      "2 trials a case",
    );

    // --trials 1 still reads trial 1 alone; the second trial is shown by its address.
    expect((await report(ws, "canned")).columns[0]!.cases.map((c) => c.id)).toEqual([
      "app-2",
      "app-1",
    ]);
    const second = await json<ShowDocument>(ws, ["show", "canned", "app-1/2"]);
    expect(second.id).toBe("app-1/2");
    expect(second.findings).toEqual([]);
    expect((await json<ShowDocument>(ws, ["show", "canned", "app-1/1"])).findings).toHaveLength(1);
    expect(second.trial!.id).toBe("app-1/2");
    expect((await lab(ws, ["show", "canned", "app-1/3"])).stderr).toContain("2 trials on file");

    // The config's trials is the default; a run fills in app-2's second trial.
    await Bun.write(join(ws.root, "awf-lab.json"), JSON.stringify({ ...CONFIG, trials: 2 }));
    const rest = inProcess();
    expect((await lab(ws, ["run", "canned"], rest.runner)).exitCode).toBe(0);
    expect(rest.trials()).toBe(1);
    const whole = await report(ws, "canned");
    expect(whole.columns[0]!.missing).toEqual([]);
    expect((await lab(ws, ["report", "canned"])).stdout).toMatch(/app-1 K1 +in 1 of 2 trials: /);
    expect(whole.columns[0]!.cases.map((c) => c.id).toSorted()).toEqual([
      "app-1/1",
      "app-1/2",
      "app-2/1",
      "app-2/2",
    ]);
  });

  test("trial n is run only after the trials before it, and never beside another of its case", async () => {
    await ws.variant("canned");
    await ws.variant("other");
    await answer(ws, { "app-1": [finding("x")], "app-2": [] });
    // Asking for trial 2 of a case with none runs trial 1 too, so the numbers hold.
    const plan = await lab(ws, [
      "run",
      "canned",
      "--trials",
      "2",
      "--only",
      "app-1/2",
      "--dry-run",
    ]);
    expect(plan.stdout).toMatch(/app-1\/1 +trial; score/);
    expect(plan.stdout).toMatch(/app-1\/2 +trial; score/);

    // With --jobs, one case's trials run one after another, while other cases' run beside them.
    const running = new Map<string, number>();
    let most = 0;
    let overlap = 0;
    let scoring = 0;
    let mostScoring = 0;
    const base = inProcess();
    // Each call waits, up to 2s, until as many run as could: steps start staggered by their restores.
    const until = async (done: () => boolean) => {
      for (let waited = 0; !done() && waited < 2000; waited += 10) await Bun.sleep(10);
    };
    const runner: Runner = async (request) => {
      const caseId = request.argv.includes(ws.heads["app-1"]!) ? "app-1" : "app-2";
      if (stepOf(request) === TRIAL) {
        running.set(caseId, (running.get(caseId) ?? 0) + 1);
        overlap = Math.max(overlap, running.get(caseId)!);
        most = Math.max(
          most,
          [...running.values()].reduce((a, b) => a + b, 0),
        );
      }
      if (stepOf(request) === SCORE) scoring += 1;
      mostScoring = Math.max(mostScoring, scoring);
      await until(() =>
        stepOf(request) === TRIAL
          ? [...running.values()].reduce((a, b) => a + b, 0) >= 2
          : scoring >= 3,
      );
      const result = await base.runner(request);
      if (stepOf(request) === TRIAL) running.set(caseId, running.get(caseId)! - 1);
      if (stepOf(request) === SCORE) scoring -= 1;
      return result;
    };
    expect(
      (await lab(ws, ["run", "canned", "--trials", "3", "--jobs", "4"], runner)).exitCode,
    ).toBe(0);
    expect(overlap).toBe(1);
    expect(most).toBe(2);
    // Scores of one case still run beside each other: app-1's three.
    expect(mostScoring).toBe(3);

    // A case another column doesn't count is named once for this one, not once per trial.
    expect(
      (await lab(ws, ["run", "other", "--trials", "3", "--only", "app-1"], inProcess().runner))
        .exitCode,
    ).toBe(0);
    const both = await report(ws, "canned", "--baseline", "other", "--trials", "3");
    expect(both.columns[0]!.missing).toEqual([
      { id: "canned:app-2", why: "another column doesn't count it" },
    ]);
  });

  test("with several trials, a comparison gets every trial of the cases both have whole", async () => {
    const control = (workflow: string) =>
      `import { defineReviewVariant, ${workflow} } from "@agentswf/lab/review";

export default defineReviewVariant({ workflow: ${workflow}, argv: ${workflow === "NOP_WORKFLOW" ? "[]" : `["--set", "{dataset}", "--head", "{head}"]`}, timeout: "1m", read: (findings) => findings as never });
`;
    await ws.variant("oracle", control("ORACLE_WORKFLOW"));
    await ws.variant("nop", control("NOP_WORKFLOW"));
    expect(
      (await lab(ws, ["run", "oracle", "nop", "--trials", "2"], inProcess().runner)).exitCode,
    ).toBe(0);
    // The oracle's app-1 gets a third trial that --trials 2 must not read.
    expect(
      (await lab(ws, ["run", "oracle", "--trials", "3", "--only", "app-1/3"], inProcess().runner))
        .exitCode,
    ).toBe(0);
    await Bun.write(
      join(ws.root, "comparisons/echo.compare.ts"),
      `import { defineComparison } from "@agentswf/lab/compare";

export default defineComparison({
  version: "1.0.0",
  compare: ({ baseline, challenger }) => ({
    verdict: "undecided",
    stop: false,
    reason: [...baseline, ...challenger].map((s) => \`\${s.case}/\${s.trial}\`).sort().join(" "),
    metrics: [],
  }),
});
`,
    );
    const both = await report(
      ws,
      "oracle",
      "--baseline",
      "nop",
      "--trials",
      "2",
      "--comparison",
      "comparisons/echo.compare.ts",
    );
    expect(both.comparison!.against[0]!.verdict!.reason).toBe(
      "app-1/1 app-1/1 app-1/2 app-1/2 app-2/1 app-2/1 app-2/2 app-2/2",
    );
    expect(both.comparison!.against[0]!.won.toSorted()).toEqual(["oracle:app-1", "oracle:app-2"]);
    // With three trials a case only app-1 is whole for the oracle, and nop has none with three.
    const three = await report(ws, "oracle", "--baseline", "nop", "--trials", "3");
    expect(three.columns.map((c) => c.name)).toEqual(["oracle"]);
    expect(three.leftOut).toEqual([{ variant: "nop", scorer: "exact" }]);
  });

  test("run --baseline runs both case by case and stops when the comparison says so", async () => {
    await ws.variant("canned");
    await ws.variant("other");
    await answer(ws, { "app-1": [finding(mechanism("app-1", 1))], "app-2": [] });
    // Stops at the first case both have whole: the seeded order's first, app-2.
    await Bun.write(
      join(ws.root, "comparisons/first.compare.ts"),
      `import { defineComparison } from "@agentswf/lab/compare";

export default defineComparison({
  version: "1.0.0",
  compare: ({ baseline, challenger, planned }) => {
    const cases = new Set(challenger.map((s) => s.case));
    const whole = cases.size >= 1 && baseline.length === challenger.length;
    return { verdict: whole ? "worse" : "undecided", stop: whole, reason: \`\${cases.size} of \${planned}\`, metrics: [] };
  },
});
`,
    );
    const against = [
      "run",
      "canned",
      "--baseline",
      "other",
      "--comparison",
      "comparisons/first.compare.ts",
    ];

    const plan = await lab(ws, [...against, "--dry-run"]);
    expect(plan.exitCode).toBe(0);
    expect(plan.stdout).toContain("canned 1.0.0 against other 1.0.0");
    expect(plan.stdout).toContain("4 trials and 4 scores to run");
    expect(plan.stdout).toContain("stopping when first 1.0.0 decides");

    const runs = inProcess();
    const first = await lab(ws, against, runs.runner);
    expect(first.exitCode).toBe(0);
    expect(runs.calls.map(stepOf)).toEqual([TRIAL, TRIAL]);
    expect(first.stderr).toContain("app-2: worse, 1 of 2");
    expect(first.stdout).toBe(
      "worse: canned against other by first 1.0.0: 1 of 2; stopped with 1 of 2 selected cases not needed",
    );
    expect(recordsIn(ws, "*/app-1/*/findings.json")).toHaveLength(0);

    // The records decide already: nothing runs, nor is planned.
    const decided = await lab(ws, [...against, "--dry-run"]);
    expect(decided.stdout).toContain(
      "already decided by the records: worse, 1 of 2; nothing to run",
    );
    expect(decided.stdout).not.toContain("trials and");
    const again = inProcess();
    const second = await lab(ws, [...against, "--json"], again.runner);
    expect(again.calls).toHaveLength(0);
    expect(second.stderr).toContain("already decided by the records: worse, 1 of 2");
    expect((JSON.parse(second.stdout) as RunDocument).steps).toEqual([]);

    // The package's own comparison over both cases: the baseline's stored trials are reused.
    const rest = inProcess();
    const whole = await lab(
      ws,
      ["run", "canned", "--baseline", "other", "--trials", "2"],
      rest.runner,
    );
    expect(whole.exitCode).toBe(0);
    // A second trial of each variant on app-2, and both of each on app-1.
    expect(rest.trials()).toBe(6);
    expect(whole.stdout).toMatch(/^undecided: canned against other by default 1\.0\.0: 2 cases/);
    const doc = await report(ws, "canned", "--baseline", "other", "--trials", "2");
    expect(doc.comparison!.against[0]!.verdict!.stop).toBe(true);
  });

  test("run --baseline agrees with report on stored records, and its budget spans the cases", async () => {
    await ws.variant("canned");
    await ws.variant("other");
    await answer(ws, { "app-1": [finding("x")], "app-2": [finding("y")] });
    expect((await lab(ws, ["run", "canned", "other"], inProcess().runner)).exitCode).toBe(0);
    // A rule that would stop at one case: with two stored, report's verdict is over two, and so is run's.
    await Bun.write(
      join(ws.root, "comparisons/look1.compare.ts"),
      `import { defineComparison } from "@agentswf/lab/compare";

export default defineComparison({
  version: "1.0.0",
  compare: ({ challenger }) => {
    const n = new Set(challenger.map((s) => s.case)).size;
    return { verdict: n === 1 ? "better" : "undecided", stop: n === 1, reason: \`\${n} cases\`, metrics: [] };
  },
});
`,
    );
    const rule = ["--comparison", "comparisons/look1.compare.ts"];
    const runs = inProcess();
    const again = await lab(ws, ["run", "canned", "--baseline", "other", ...rule], runs.runner);
    expect(runs.calls).toHaveLength(0);
    expect(again.stdout).toBe("undecided, so far: canned against other by look1 1.0.0: 2 cases");
    const reported = await report(ws, "canned", "--baseline", "other", ...rule);
    expect(reported.comparison!.against[0]!.verdict).toMatchObject({ verdict: "undecided" });

    // $1 a run: the first case's two trials and two scores come to $4; a trial is estimated at the
    // mean of those on file, $0.33 with the earlier free ones, which doesn't fit under $4.20.
    const priced = inProcess({ spend: 1 });
    const budget = await lab(
      ws,
      ["run", "canned", "--baseline", "other", "--trials", "2", "--budget", "4.2"],
      priced.runner,
    );
    expect(budget.exitCode).toBe(3);
    expect(budget.stderr).toContain("$4.00 of $4.2 at list prices so far");
    expect(
      (await lab(ws, ["run", "canned", "--baseline", "other", "--rest-from", "exact"])).stderr,
    ).toContain("--rest-from goes with score");
  });

  test("run --baseline fills a gap in the stored cases, counting the ones after it", async () => {
    await ws.variant("canned");
    await ws.variant("other");
    await answer(ws, { "app-1": [finding("x")], "app-2": [finding("y")] });
    // The seeded order is app-2, app-1: only the second is stored.
    expect(
      (await lab(ws, ["run", "canned", "other", "--cases", "app-1"], inProcess().runner)).exitCode,
    ).toBe(0);
    const runs = inProcess();
    const filled = await lab(ws, ["run", "canned", "--baseline", "other"], runs.runner);
    expect(filled.exitCode).toBe(0);
    expect(runs.trials()).toBe(2);
    expect(filled.stdout).toMatch(/^undecided: canned against other by default 1\.0\.0: 2 cases/);
  });

  test("run --baseline refuses what it can't decide on, and stops at a case it can't make whole", async () => {
    await ws.variant("canned");
    await ws.variant("other");
    await answer(ws, { "app-1": [finding("x")], "app-2": [finding("y")] });
    const usage = async (...argv: string[]) => {
      const result = await lab(ws, ["run", ...argv, "--dry-run"]);
      expect(result.exitCode).toBe(2);
      return result.stderr;
    };
    expect(await usage("canned", "other", "--baseline", "other")).toContain(
      "run --baseline takes one challenger",
    );
    expect(await usage("canned", "--baseline", "canned")).toContain("are the same version");
    expect(await usage("canned", "--baseline", "other", "--only", "app-1")).toContain(
      "--only picks cases by hand",
    );
    expect(await usage("canned", "--baseline", "other", "--cases", "app-1")).toContain(
      "a verdict takes the first n of the seeded order",
    );
    // --where lost still only reads the baseline.
    const lost = await lab(ws, [
      "run",
      "canned",
      "--baseline",
      "other",
      "--where",
      "lost",
      "--dry-run",
    ]);
    expect(lost.exitCode).toBe(0);
    expect(lost.stdout).not.toContain("against");

    // A score that fails leaves app-2 not whole: later cases would count towards no look.
    await ws.scorer("exact", "bad");
    const runs = inProcess();
    const failed = await lab(ws, ["run", "canned", "--baseline", "other"], runs.runner);
    expect(failed.exitCode).toBe(1);
    expect(failed.stderr).toContain("app-2 isn't whole, so no later case would count");
    expect(recordsIn(ws, "*/app-1/*/findings.json")).toHaveLength(0);
  });

  test("check: headroom, variance, resolution, failures by kind and suspect cases, from records", async () => {
    await ws.variant("canned");
    await ws.variant("other");
    // app-1's must-fix found on trial 1, missed on trial 2; app-2's issue never found by anyone.
    await answer(ws, { "app-1": [finding(mechanism("app-1", 1))], "app-2": [finding("vague")] });
    expect((await lab(ws, ["run", "canned", "other"], inProcess().runner)).exitCode).toBe(0);
    const one = await lab(ws, ["check", "canned"]);
    expect(one.exitCode).toBe(0);
    expect(one.stdout).toContain("headroom    recall.weighted");
    expect(one.stdout).toContain("resolution  unknown: no case has two scored trials");

    await answer(ws, { "app-1": [], "app-2": [finding("vague")] });
    expect((await lab(ws, ["run", "canned", "--trials", "2"], inProcess().runner)).exitCode).toBe(
      0,
    );
    const checked = await json<CheckDocument>(ws, ["check", "canned", "--trials", "2"]);
    expect(checked.variance.cases).toBe(2);
    expect(checked.variance.trials).toBe(2);
    expect(checked.variance.within).toBeGreaterThan(0);
    expect(checked.resolution.range).not.toBeNull();
    expect(checked.resolution.dataset.cases).toBe(2);
    expect(checked.suspect).toEqual(["app-2"]);
    expect(checked.failures).toEqual({
      variant: [],
      neverStarted: [],
      otherSandbox: [],
      scoreFailed: [],
      notScored: [],
    });
    const text = await lab(ws, ["check", "canned", "--trials", "2"]);
    expect(text.stdout).toMatch(
      /variance {4}sd \S+ between cases, \S+ between trials of one, over 2 cases/,
    );
    expect(text.stdout).toContain(
      "suspect     1 case score 0 on every trial of every variant: app-2",
    );

    // The scorer again on stored trials: the exact scorer agrees with itself, and nothing is kept.
    const rescored = inProcess();
    const again = await json<CheckDocument>(
      ws,
      ["check", "canned", "--rescore", "2"],
      rescored.runner,
    );
    expect(rescored.calls.map(stepOf)).toEqual([SCORE, SCORE]);
    expect(again.rescore).toMatchObject({ trials: 2, findings: 2, same: 2, differ: [] });
    expect(recordsIn(ws, "canned@1.0/*/*/score.*.k1.2.json")).toHaveLength(0);

    // run --baseline shows the baseline's headroom and resolution before it spends.
    const plan = await lab(ws, ["run", "canned", "--baseline", "other", "--dry-run"]);
    expect(plan.stdout).toContain("other: headroom recall.weighted");
    expect((await lab(ws, ["check", "canned", "other"])).exitCode).toBe(2);
    expect((await lab(ws, ["check", "canned", "--only", "app-1"])).exitCode).toBe(2);
  }, 20_000);

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
    expect(runs.calls.map(stepOf)).toEqual([
      TRIAL,
      TRIAL,
      TRIAL,
      TRIAL,
      SCORE,
      SCORE,
      SCORE,
      SCORE,
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

  test("every trial's agents run in the workspace's sandbox, holding the request; a scorer's don't", async () => {
    await ws.variant("canned");
    await answer(ws, { "app-1": [finding(mechanism("app-1", 1))], "app-2": [] });
    const runs = inProcess();
    const given: { step: string; request?: string; spec?: unknown }[] = [];
    const recording: Runner = async (request) => {
      given.push({
        step: stepOf(request),
        ...(request.sandbox
          ? {
              request: join(dirname(request.cwd), "request.md"),
              spec: await Bun.file(request.sandbox).json(),
            }
          : {}),
      });
      return runs.runner(request);
    };
    expect((await lab(ws, ["run", "canned", "--cases", "app-1"], recording)).exitCode).toBe(0);
    const [trial, score] = given;
    expect(trial!.spec).toEqual({ read: [trial!.request], srt: {} });
    expect(score).toEqual({ step: SCORE });

    const config = join(ws.root, "awf-lab.json");
    const docker = {
      ...(await Bun.file(config).json()),
      sandbox: { docker: { image: "awf-review" } },
    };
    await Bun.write(config, JSON.stringify(docker));
    given.length = 0;
    expect((await lab(ws, ["run", "canned", "--cases", "app-2"], recording)).exitCode).toBe(0);
    expect(given[0]!.spec).toEqual({ read: [given[0]!.request], docker: { image: "awf-review" } });
  });

  test("a trial counts only in the workspace's sandbox: another provider's is run again", async () => {
    await ws.variant("canned");
    await answer(ws, { "app-1": [finding(mechanism("app-1", 1))], "app-2": [] });
    expect(
      (await lab(ws, ["run", "canned", "--cases", "app-1"], inProcess().runner)).exitCode,
    ).toBe(0);
    const config = join(ws.root, "awf-lab.json");
    const srt = await Bun.file(config).json();
    await Bun.write(config, JSON.stringify({ ...srt, sandbox: { docker: {} } }));
    const missing = (await report(ws, "canned", "--cases", "app-1")).columns[0]!.missing;
    expect(missing).toEqual([
      { id: "app-1", why: "no trial in this workspace's sandbox; awf-lab run runs it again" },
    ]);
    expect((await lab(ws, ["show", "canned", "app-1"])).stdout).toContain("trial     none counted");
    const scored = await lab(ws, ["score", "canned", "--cases", "app-1", "--dry-run"]);
    expect(scored.stdout).toMatch(/app-1 +skip: no trial in this workspace's sandbox/);
    const underDocker = inProcess();
    expect((await lab(ws, ["run", "canned"], underDocker.runner)).exitCode).toBe(0);
    // app-2's trial found nothing, so there is nothing to score.
    expect(underDocker.calls.map(stepOf)).toEqual([TRIAL, TRIAL, SCORE]);
    // Back to srt, app-1's first trial counts again, scored; app-2 has only docker's.
    await Bun.write(config, JSON.stringify(srt));
    const backToSrt = inProcess();
    expect((await lab(ws, ["run", "canned"], backToSrt.runner)).exitCode).toBe(0);
    expect(backToSrt.calls.map(stepOf)).toEqual([TRIAL]);
  });

  test("a clone that names no default branch fails before anything runs", async () => {
    await ws.variant("canned");
    await answer(ws, { "app-1": [], "app-2": [] });
    git(join(ws.root, "project"), "symbolic-ref", "--delete", "refs/remotes/origin/HEAD");
    const runs = inProcess();
    const result = await lab(ws, ["run", "canned", "--dry-run"], runs.runner);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("has no origin/HEAD");
    expect(runs.calls).toHaveLength(0);
  });

  test("a file whose default export is a workflow but not a variant is refused before anything runs", async () => {
    await ws.variant("bare", `export { default } from ${JSON.stringify(CANNED)};\n`);
    const runs = inProcess();
    const bare = await lab(ws, ["run", "bare"], runs.runner);
    expect(bare.exitCode).not.toBe(0);
    expect(bare.stderr).toContain("the default export is not a variant or scorer");
    expect(runs.calls).toHaveLength(0);
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
    expect((await lab(ws, ["run", "canned", "--scorer", "panel"])).stderr).toContain(
      "panel is retired: match-first is the package's scorer",
    );
    expect((await lab(ws, ["report", "canned", "canned"])).exitCode).toBe(2);
    expect((await lab(ws, ["run", "canned", "--cases", "0"])).exitCode).toBe(2);
    expect((await lab(ws, ["run", "canned", "--cases", "zz*"])).exitCode).toBe(2);
    expect((await lab(ws, ["report", "canned", "--frobnicate"])).exitCode).toBe(2);
    expect((await lab(ws, ["run", "canned", "--trials", "0"])).stderr).toContain(
      "--trials is a whole number from 1",
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
    expect(retried.calls.map(stepOf)).toEqual([SCORE]);
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
    expect(one.calls.map(stepOf)).toEqual([TRIAL]);
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

    const other = await newWorkspace();
    roots.push(other.root);
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
    expect(runs.calls.map(stepOf)).toEqual([TRIAL, TRIAL, SCORE, SCORE]);
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
    expect(parallel.calls.map(stepOf)).toEqual([SCORE]);
    expect(stopped.stderr).toContain("budget: stopped before scoring");

    // A running step that costs less than its estimate leaves room: the waiting one then starts.
    const cheaper = inProcess({ spend: 0.2 });
    const both = await lab(
      ws,
      ["score", "canned", "--budget", "1.5", "--jobs", "2"],
      cheaper.runner,
    );
    expect(cheaper.calls.map(stepOf)).toEqual([SCORE, SCORE]);
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
    expect(shown.stdout).toMatch(/scorer +match-first +\d+\.\d+\.\d+ /);
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
    expect(rescored.calls.map(stepOf)).toEqual([SCORE, SCORE]);
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
    expect(chosen.calls.map(stepOf)).toEqual([SCORE]);
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
    // The retired panel's workflow takes no --settled.
    await Bun.write(
      join(ws.root, "scorers/panel.scorer.ts"),
      `import { defineReviewScorer, PANEL_JUDGE } from "@agentswf/lab/review";

export default defineReviewScorer({ workflow: PANEL_JUDGE, argv: [], timeout: "1m" });
`,
    );
    const run = await lab(
      ws,
      ["score", "canned", "--scorer", "panel", "--only", "app-1#1"],
      inProcess().runner,
    );
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("may not take --settled");
    expect(recordsIn(ws, "*/app-1/*/partial.*.json")).toHaveLength(0);
  });

  test("a retired scorer's stored scores still read by name and version, with its file gone", async () => {
    await ws.variant("canned");
    await answer(ws, { "app-1": [finding(mechanism("app-1", 1))], "app-2": [] });
    const file = join(ws.root, "scorers/panel.scorer.ts");
    await Bun.write(
      file,
      `import { defineReviewScorer } from "@agentswf/lab/review";
import exact from ${JSON.stringify(join(import.meta.dir, "fixtures/lab/exact-judge.workflow.ts"))};

export default defineReviewScorer({ workflow: exact, argv: ["--mode", "plain"], timeout: "1m" });
`,
    );
    expect(
      (await lab(ws, ["run", "canned", "--scorer", "panel"], inProcess().runner)).exitCode,
    ).toBe(0);
    rmSync(file);
    const stored = await report(ws, "canned", "--scorer", "panel@1");
    expect(stored.scorers).toEqual([{ name: "panel@1", version: "1.0.0" }]);
    expect(stored.columns[0]!.weightedRecall).toBeGreaterThan(0);
    expect((await lab(ws, ["show", "canned", "app-1", "--scorer", "panel@1"])).exitCode).toBe(0);
    expect((await lab(ws, ["report", "canned", "--scorer", "panel"])).stderr).toContain(
      "panel is retired",
    );
    // A config still naming it blocks nothing that names another scorer.
    await Bun.write(join(ws.root, "awf-lab.json"), JSON.stringify({ ...CONFIG, scorer: "panel" }));
    expect((await lab(ws, ["score", "canned", "--scorer", "exact", "--dry-run"])).exitCode).toBe(0);
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
      "app-1/2: 1 trial a case, so no trial 2; --trials asks for more",
    );
    expect(
      (await lab(ws, ["score", "canned", "--only", "app-1#0", "--trials", "2"])).stderr,
    ).toContain("a finding names its trial: {case}/{trial}#{finding}");
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

  test("records in the first formats, from before versions, still read, and are run again", async () => {
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
        sandbox: _sandbox,
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
    // Read, and never counted: they ran before trials had a sandbox.
    const missing = (await report(ws, "canned")).columns[0]!.missing;
    expect(missing.toSorted((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: "app-1", why: "no trial in this workspace's sandbox; awf-lab run runs it again" },
      { id: "app-2", why: "no trial in this workspace's sandbox; awf-lab run runs it again" },
    ]);
    const again = inProcess();
    expect((await lab(ws, ["run", "canned"], again.runner)).exitCode).toBe(0);
    expect(again.calls.map(stepOf)).toEqual([TRIAL, TRIAL, SCORE, SCORE]);
    const numbers = (document: typeof before) =>
      document.columns[0]!.cases.map(({ id, precision, weightedRecall }) => ({
        id,
        precision,
        weightedRecall,
      }));
    expect(numbers(await report(ws, "canned"))).toEqual(numbers(before));
  });
});
