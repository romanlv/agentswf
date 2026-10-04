import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { RUNTIMES } from "../examples/quick-check/workflow";
import { OUTPUT_RECORD_VERSION } from "../packages/contract/src/records";
import { DeadlineExceededError } from "../packages/contract/src/workflow/timing";
import { PUBLISHED_PRICES } from "../packages/engine/src/accounting/prices";
import { summarizeRun } from "../packages/engine/src/accounting/summary";
import { attemptEnd, runOutcome } from "../packages/engine/src/attempt-ending";
import { WorkflowCancelledError } from "../packages/engine/src/deadlines";
import { createFakeDecisionProvider } from "../packages/engine/src/decisions/fake";
import { runOperatorCli } from "../packages/engine/src/operator-cli";
import { WorkflowStopped } from "../packages/engine/src/stopped";
import { createTempRunDirs, submit } from "../packages/engine/src/testing";
import { WorkflowRunError } from "../packages/engine/src/workflow-runner";
import type { AgentRuntimeConfig, AgentSessionAdapter } from "../packages/harness/src/adapter";
import type { RunProcess } from "../packages/harness/src/command";
import { createSingleSessionHostFactory } from "../packages/harness/src/single-session-host";
import { createFakeAdapter } from "../packages/harness/src/testing/fake";
import type { SessionAccounting } from "../packages/harness/src/usage/accounting";
import { createFakeSandboxProvider } from "../packages/sandbox/src/testing/fake";

const ROOT = join(import.meta.dir, "..");
const CLI = join(ROOT, "packages/engine/src/operator-cli.ts");
const runDirs = createTempRunDirs();
afterAll(() => runDirs.cleanup());
/** awf keeps sandboxes and caller marks under `~/.awf`: never the operator's, from a test. */
const HOME = runDirs.tempRunDir();
const cli = (...[argv, environment]: Parameters<typeof runOperatorCli>) =>
  runOperatorCli(argv, { home: HOME, ...environment });

describe("awf", () => {
  test("--version prints the engine's version and, from a clone, its commit", async () => {
    const output: string[] = [];
    const { version } = JSON.parse(
      readFileSync(join(ROOT, "packages/engine/package.json"), "utf8"),
    );
    const commit = Bun.spawnSync(["git", "-C", ROOT, "rev-parse", "--short", "HEAD"]);

    const exitCode = await cli(["--version"], { stdout: (text) => output.push(text) });

    expect(exitCode).toBe(0);
    expect(output).toEqual([`awf ${version} (${commit.stdout.toString().trim()})`]);
  });

  test("refuses a Bun older than engines.bun, naming both versions", async () => {
    const errors: string[] = [];

    const exitCode = await cli(["--version"], {
      bunVersion: "1.1.0",
      stderr: (text) => errors.push(text),
    });

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("awf needs Bun >=1.4.0, and this is Bun 1.1.0");
  });
});

describe("awf run", () => {
  test("loads review-loop and runs both ordered reviews through the engine", async () => {
    const adapter = createFakeAdapter({
      harnesses: ["claude", "codex"],
      script: (context) => ({
        sessionRef: `s-${context.activation.key}`,
        act: async () => {
          const lens = context.activation.key.endsWith("correctness")
            ? "correctness"
            : "maintainability";
          await submit(context.binding!, {
            lens,
            summary: `${lens} complete`,
            findings:
              lens === "correctness"
                ? [{ severity: "blocking", summary: "broken", evidence: "line 1" }]
                : [],
          });
        },
      }),
    });
    const output: string[] = [];
    const errors: string[] = [];
    let cleaned = 0;
    const runRoot = runDirs.tempRunDir();
    const startedAt = Date.now();

    const exitCode = await cli(
      [
        "run",
        "--timeout",
        "12m",
        "--run-root",
        runRoot,
        "examples/minimum-review/review-loop.ts",
        "--",
        "packages/engine/src",
      ],
      {
        cwd: ROOT,
        now: () => startedAt,
        stdout: (text) => output.push(text),
        stderr: (text) => errors.push(text),
        installRuntime: async (timeoutMilliseconds) => {
          expect(timeoutMilliseconds).toBe(12 * 60_000);
          return {
            config: runtime(adapter, spentFromFiles()),
            cleanup: async () => {
              cleaned += 1;
            },
          };
        },
      },
    );

    expect(exitCode).toBe(0);
    // Sonnet 5 at $2/$0.20/$10 and gpt-5.6-sol at $4/$0.40/$20 per million: $0.0088 + $0.0176.
    expect(errors).toEqual([
      "[0:00] ▶ Minimum review (2)",
      "[0:00] ✓ reviewer:correctness · 0s",
      "[0:00] ✓ reviewer:maintainability · 0s",
      "[0:00] ■ Minimum review done 2/2 in 0s",
      "",
      expect.stringMatching(
        /^2 agents · \d+s · 21k tokens · ~\$0\.03 at list prices · subscription$/,
      ),
      expect.stringMatching(/^Records: .+\/review-loop\/\d{8}-\d{4}-[0-9a-f]{4}$/),
    ]);
    expect(cleaned).toBe(1);
    expect(adapter.turns).toHaveLength(2);
    expect(adapter.turns.every((turn) => turn.prompt.includes("packages/engine/src"))).toBe(true);
    expect(adapter.activations.map((activation) => activation.execution.model).sort()).toEqual([
      "gpt-5.6-sol",
      "sonnet",
    ]);
    expect(
      adapter.activations.every(
        (activation) => activation.deadline.unixMilliseconds === startedAt + 12 * 60_000,
      ),
    ).toBe(true);
    const result = JSON.parse(output.join("\n")) as {
      version: number;
      workflow: { name: string; file: string };
      value: { reviews: Array<{ lens: string }>; blockingFindingCount: number };
      artifacts: string;
    };
    expect(result.version).toBe(OUTPUT_RECORD_VERSION);
    expect(result).toMatchObject({ outcome: "completed" });
    expect(result.workflow).toEqual({
      name: "review-loop",
      file: join(ROOT, "examples/minimum-review/review-loop.ts"),
    });
    expect(result.value.reviews.map((review) => review.lens)).toEqual([
      "correctness",
      "maintainability",
    ]);
    expect(result.value.blockingFindingCount).toBe(1);
    expect(result.artifacts.startsWith(runRoot)).toBe(true);
    expect(existsSync(join(result.artifacts, "calls"))).toBe(true);
    const saved = JSON.parse(readFileSync(join(result.artifacts, "output.json"), "utf8"));
    expect(saved.accounting).toMatchObject({
      basis: "list prices 2026-09-26",
      billing: "subscription",
      totals: { agents: 2, known: 2, priced: 2 },
      byModel: [{ model: "claude-sonnet-5" }, { model: "gpt-5.6-sol" }],
    });
    expect(saved.accounting.totals.estimate).toBeCloseTo(0.0264, 10);
    expect(saved.usage.map((usage: { spend: unknown[] }) => usage.spend.length)).toEqual([1, 1]);
  });

  test("quick-check asks each runtime named, and headless ones a follow-up in the same session", async () => {
    const adapter = createFakeAdapter({
      harnesses: ["codex", "pi"],
      script: (context) => ({
        sessionRef: `s-${context.activation.key}`,
        act: async () => {
          const followUp = context.prompt.includes("Add 9");
          const pi = context.activation.execution.harness === "pi";
          await submit(context.binding!, { answer: followUp ? 400 : pi ? 391 : 390 });
        },
      }),
    });
    const output: string[] = [];
    const errors: string[] = [];

    const exitCode = await cli(
      [
        "run",
        "--run-root",
        runDirs.tempRunDir(),
        "examples/quick-check/workflow.ts",
        "--",
        "codex",
        "pi",
      ],
      {
        cwd: ROOT,
        stdout: (text) => output.push(text),
        stderr: (text) => errors.push(text),
        installRuntime: async () => ({
          config: runtime(adapter, spentFromFiles()),
          cleanup: async () => undefined,
        }),
      },
    );

    expect(exitCode).toBe(0);
    expect(adapter.activations.map((activation) => activation.execution)).toEqual([
      RUNTIMES.codex,
      RUNTIMES.pi,
    ]);
    expect(output.join("\n").split("\n").slice(0, 2)).toEqual([
      "codex: wrong (390), then right (400)",
      "pi: right (391), then right (400)",
    ]);
    const accounting = errors.filter((line) => line !== "" && !line.startsWith("["));
    expect(accounting[0]).toMatch(/^2 agents · .* · subscription/);
    expect(accounting[1]).toStartWith("Records: ");
  });

  test("quick-check refuses a runtime it does not know", async () => {
    const errors: string[] = [];
    const exitCode = await cli(["run", "examples/quick-check/workflow.ts", "--", "aider"], {
      cwd: ROOT,
      stderr: (text) => errors.push(text),
      installRuntime: emptyRuntime,
    });
    expect(exitCode).toBe(2);
    expect(errors.join("\n")).toContain(
      "unknown runtime aider; expected codex, pi, pi-pane, claude, cursor, cursor-pane",
    );
  });

  test("a sandbox's own Herdr is watched unless --no-watch", async () => {
    const root = runDirs.tempRunDir();
    const workflow = join(root, "nothing.js");
    await Bun.write(workflow, executableModule("return null;", "return null;"));
    const asked: boolean[] = [];
    for (const flags of [[], ["--no-watch"]]) {
      const exitCode = await cli(["run", "--run-root", runDirs.tempRunDir(), ...flags, workflow], {
        cwd: root,
        stdout: () => undefined,
        stderr: () => undefined,
        installRuntime: async (_timeout, options) => {
          asked.push(options.watchSandboxes);
          return emptyRuntime();
        },
      });
      expect(exitCode).toBe(0);
    }
    expect(asked).toEqual([true, false]);
  });

  test("the sandboxes example refuses an argument it does not know", async () => {
    const errors: string[] = [];
    const exitCode = await cli(["run", "examples/sandboxes/workflow.ts", "--", "firejail"], {
      cwd: ROOT,
      stderr: (text) => errors.push(text),
      installRuntime: emptyRuntime,
    });
    expect(exitCode).toBe(2);
    expect(errors.join("\n")).toContain("unexpected argument firejail; this example takes none");
  });

  test("fails when an operator alias drifts from the workflow's required model", async () => {
    const adapter = createFakeAdapter({
      harnesses: ["claude", "codex"],
      script: () => ({}),
    });
    const configured = runtime(adapter);
    configured.aliases.claude!.model = "opus";
    const output: string[] = [];
    const errors: string[] = [];

    const exitCode = await cli(
      ["run", "--run-root", runDirs.tempRunDir(), "examples/minimum-review/review-loop.ts"],
      {
        cwd: ROOT,
        stdout: (text) => output.push(text),
        stderr: (text) => errors.push(text),
        installRuntime: async () => ({ config: configured, cleanup: async () => undefined }),
      },
    );

    expect(exitCode).toBe(1);
    expect(output).toEqual([]);
    expect(errors.join("\n")).toContain("runtime alias claude does not satisfy required model");
  });

  test("reports every unusable invocation without installing a runtime", async () => {
    const root = runDirs.tempRunDir();
    const malformed = join(root, "malformed.ts");
    await Bun.write(malformed, "export default { meta: { name: 'not enough' } };\n");
    const nonJsonArguments = join(root, "invalid-arguments.js");
    const notSpec = join(root, "not-spec.json");
    await Bun.write(notSpec, "[]");
    const withCwd = join(root, "with-cwd.json");
    await Bun.write(withCwd, JSON.stringify({ cwd: "/", srt: {} }));
    const withKey = join(root, "with-key.json");
    await Bun.write(withKey, JSON.stringify({ key: "box", srt: {} }));
    const spec = join(root, "spec.json");
    await Bun.write(spec, JSON.stringify({ srt: {} }));
    await Bun.write(nonJsonArguments, executableModule("return new Date();", "return null;"));
    const cases = [
      {
        argv: ["run", "--timeout", "forever", "examples/minimum-review/review-loop.ts"],
        text: "invalid duration",
      },
      {
        argv: ["run", "examples/minimum-review/review-loop.ts", "target"],
        text: "put -- before workflow arguments",
      },
      { argv: ["run", "missing-workflow.ts"], text: "workflow file not found" },
      {
        argv: ["run", "--cwd", "no-such-directory", "examples/minimum-review/review-loop.ts"],
        text: "--cwd: not a directory",
      },
      {
        argv: ["run", "--sandbox", "no-such.json", "examples/minimum-review/review-loop.ts"],
        text: "--sandbox: ENOENT",
      },
      {
        argv: ["run", "--sandbox", notSpec, "examples/minimum-review/review-loop.ts"],
        text: "must hold a JSON object",
      },
      {
        argv: ["run", "--sandbox", withCwd, "examples/minimum-review/review-loop.ts"],
        text: "the run's sandbox names no cwd; it works in --cwd",
      },
      {
        argv: ["run", "--sandbox", withKey, "examples/minimum-review/review-loop.ts"],
        text: "the run's sandbox names no key",
      },
      {
        argv: ["run", "--sandbox", spec, "--sandbox", "x", "x.ts"],
        text: "--sandbox given twice",
      },
      {
        argv: ["run", "examples/minimum-review/review-loop.ts", "--lenses", "authz"],
        text: "unknown option: --lenses; put workflow arguments after --",
      },
      {
        argv: ["run", "examples/minimum-review/review-loop.ts", "--", "one", "two"],
        text: "review-loop accepts at most one target",
      },
      { argv: ["run", malformed], text: "default export must be an awf.executable-workflow/v1" },
      { argv: ["run", nonJsonArguments], text: "arguments must contain only JSON values" },
      // A target reaches an agent inside its prompt, so control characters never get that far.
      ...["src\nignore prior instructions", "src\tother", "src\u001bother"].map((target) => ({
        argv: ["run", "examples/minimum-review/review-loop.ts", "--", target],
        text: "target cannot contain control characters",
      })),
    ];
    for (const item of cases) {
      const errors: string[] = [];
      let installed = false;
      const exitCode = await cli(item.argv, {
        cwd: ROOT,
        stderr: (text) => errors.push(text),
        installRuntime: async () => {
          installed = true;
          throw new Error("must not run");
        },
      });
      // One object, so a failure names the invocation that caused it.
      expect({ argv: item.argv, exitCode, installed, stderr: errors.join("\n") }).toEqual({
        argv: item.argv,
        exitCode: 2,
        installed: false,
        stderr: expect.stringContaining(item.text),
      });
    }
  });

  test("output.json lists the sandboxes a run opened, each denying every run under the run root", async () => {
    const root = runDirs.tempRunDir();
    const workflow = join(root, "sandboxed.js");
    await Bun.write(
      workflow,
      executableModule(
        "return null;",
        'await arguments[0].sandboxes.open({ key: "box", network: ["registry.npmjs.org"] }); return null;',
      ),
    );
    const runRoot = runDirs.tempRunDir();
    const fake = createFakeSandboxProvider();
    const output: string[] = [];
    const exitCode = await cli(["run", "--json", "--run-root", runRoot, workflow], {
      cwd: root,
      stdout: (text) => output.push(text),
      stderr: () => undefined,
      installRuntime: async () => ({
        ...(await emptyRuntime()),
        sandboxes: { installed: { srt: fake.provider }, default: "srt" },
      }),
    });
    expect(exitCode).toBe(0);
    const record = JSON.parse(output.join("\n"));
    expect(record.sandboxes).toEqual([
      {
        callPath: [],
        key: "box",
        provider: "srt",
        spec: {
          cwd: realpathSync(root),
          read: [],
          write: [],
          network: ["registry.npmjs.org"],
          srt: {},
        },
        // Under ~/.awf, outside the run root its provider denies.
        directory: expect.stringContaining(realpathSync(join(HOME, ".awf", "sandboxes"))),
        gitdirs: [],
        domains: ["registry.npmjs.org"],
        agents: [],
      },
    ]);
    expect(
      JSON.parse(readFileSync(join(record.artifacts, "output.json"), "utf8")).sandboxes,
    ).toEqual(record.sandboxes);
    expect(fake.events[0]).toMatchObject({ kind: "open", runRoot: realpathSync(runRoot) });
  });

  test("output.json lists the decisions a run asked, and the accounting prints them", async () => {
    const root = runDirs.tempRunDir();
    const workflow = join(root, "decides.js");
    await Bun.write(
      workflow,
      executableModule(
        "return null;",
        'const { answers } = await arguments[0].decisions.decide({ key: "triage:1", model: "jev", state: "a ticket", questions: { bug: { type: "yes-no", instructions: "Broken?" } } }); return answers.bug.yes;',
      ),
    );
    const provider = createFakeDecisionProvider();
    const output: string[] = [];
    const errors: string[] = [];
    const exitCode = await cli(["run", "--json", "--run-root", runDirs.tempRunDir(), workflow], {
      cwd: root,
      stdout: (text) => output.push(text),
      stderr: (text) => errors.push(text),
      installRuntime: async () => ({
        ...(await emptyRuntime()),
        decisions: {
          providers: { fake: provider },
          aliases: { jev: { provider: "fake", model: "fake/jev-1" } },
        },
      }),
    });
    expect(exitCode).toBe(0);
    const record = JSON.parse(output.join("\n"));
    expect(record.value).toBe(0.9);
    expect(record.decisions).toEqual([
      expect.objectContaining({
        key: "triage:1",
        provider: "fake",
        snapshot: "fake/jev-1-20260926",
        outcome: "answered",
        charged: { amount: 0.000042, currency: "USD" },
        artifact: "decisions/1.json",
      }),
    ]);
    expect(existsSync(join(record.artifacts, "decisions/1.json"))).toBe(true);
    expect(
      JSON.parse(readFileSync(join(record.artifacts, "output.json"), "utf8")).decisions,
    ).toEqual(record.decisions);
    expect(record.accounting.unpriced).toEqual(["fake/jev-1-20260926"]);
    expect(errors.some((line) => line.startsWith("  1 decision · 1k tokens"))).toBe(true);
  });

  test("rejects a non-JSON workflow result after retaining its run", async () => {
    const root = runDirs.tempRunDir();
    const workflow = join(root, "invalid-result.js");
    await Bun.write(workflow, executableModule("return null;", "return new Date();"));
    const runRoot = runDirs.tempRunDir();
    const errors: string[] = [];
    const output: string[] = [];

    const exitCode = await cli(["run", "--run-root", runRoot, workflow], {
      cwd: ROOT,
      stdout: (text) => output.push(text),
      stderr: (text) => errors.push(text),
      installRuntime: emptyRuntime,
    });

    expect(exitCode).toBe(1);
    expect(output).toEqual([]);
    expect(errors.join("\n")).toContain("workflow result must contain only JSON values");
    expect(attemptOf(recordsIn(errors.join("\n")))).toMatchObject({
      outcome: "failed",
      reason: "workflow result must contain only JSON values",
    });
  });

  test("distinguishes runtime installation and workflow-body failures", async () => {
    const runtimeErrors: string[] = [];
    const runtimeExit = await cli(
      ["run", "--run-root", runDirs.tempRunDir(), "examples/minimum-review/review-loop.ts"],
      {
        cwd: ROOT,
        stderr: (text) => runtimeErrors.push(text),
        installRuntime: async () => {
          throw new Error("Herdr unavailable");
        },
      },
    );
    expect(runtimeExit).toBe(1);
    expect(runtimeErrors.join("\n")).toContain("runtime: Herdr unavailable");

    const root = runDirs.tempRunDir();
    const workflow = join(root, "throws.js");
    await Bun.write(workflow, executableModule("return null;", "throw new Error('body broke');"));
    const bodyErrors: string[] = [];
    const bodyExit = await cli(["run", "--run-root", runDirs.tempRunDir(), workflow], {
      cwd: ROOT,
      stderr: (text) => bodyErrors.push(text),
      installRuntime: emptyRuntime,
    });
    expect(bodyExit).toBe(1);
    expect(bodyErrors.join("\n")).toContain("body broke");
    expect(attemptOf(recordsIn(bodyErrors.join("\n")))).toMatchObject({
      outcome: "failed",
      reason: "body broke",
    });
  });

  test("without flags, a run gets 30 minutes and is kept in the project's .awf, ignored by git", async () => {
    const home = runDirs.tempRunDir();
    const cwd = runDirs.tempRunDir();
    const workflow = join(cwd, "ok.js");
    await Bun.write(workflow, executableModule("return null;", "return 1;"));
    const startedAt = Date.now();
    let timeout: number | undefined;
    const output: string[] = [];

    const exitCode = await cli(["run", workflow], {
      cwd,
      home,
      now: () => startedAt,
      stdout: (text) => output.push(text),
      installRuntime: async (timeoutMilliseconds) => {
        timeout = timeoutMilliseconds;
        return emptyRuntime();
      },
    });

    expect(exitCode).toBe(0);
    expect(timeout).toBe(30 * 60_000);
    expect(existsSync(join(home, ".awf/runs"))).toBe(false);
    expect(readFileSync(join(cwd, ".awf/runs/.gitignore"), "utf8")).toBe("*\n");
    expect([...new Bun.Glob("*/*/run.json").scanSync({ cwd: join(cwd, ".awf/runs") })]).toEqual([
      expect.stringMatching(/^fixture\/\d{8}-\d{4}-[0-9a-f]{4}\/run\.json$/),
    ]);
  });

  test("--cwd, before or after the workflow file, moves where the workflow works; command-line paths stay relative to the shell", async () => {
    const shell = runDirs.tempRunDir();
    const target = runDirs.tempRunDir();
    await Bun.write(
      join(shell, "where.js"),
      executableModule("return invocation.cwd;", "return args;")
        .replace("run()", "run(_workflow, args)")
        .replace("prepare()", "prepare(invocation)"),
    );
    const output: string[] = [];

    const exitCode = await cli(
      ["run", "--run-root", "runs", "where.js", "--cwd", target, "--json"],
      { cwd: shell, stdout: (text) => output.push(text), installRuntime: emptyRuntime },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(output.join("")).value).toBe(target);
    expect(existsSync(join(shell, "runs"))).toBe(true);
  });

  test("--sandbox that can't open fails the run before the workflow starts, leaving no record", async () => {
    const shell = runDirs.tempRunDir();
    await Bun.write(join(shell, "box.json"), JSON.stringify({ srt: {} }));
    await Bun.write(
      join(shell, "opens.js"),
      executableModule("return null;", 'await Bun.write("ran", ""); return 1;'),
    );
    const errors: string[] = [];

    // No provider is installed, so the run's srt sandbox can't open.
    const exitCode = await cli(["run", "--run-root", "runs", "--sandbox", "box.json", "opens.js"], {
      cwd: shell,
      stderr: (text) => errors.push(text),
      installRuntime: emptyRuntime,
    });

    expect(exitCode).not.toBe(0);
    expect(errors.join("")).toContain("the run's sandbox did not open");
    expect(existsSync(join(shell, "ran"))).toBe(false);
    expect([...new Bun.Glob("runs/**/output.json").scanSync({ cwd: shell })]).toEqual([]);
  });

  test("on a terminal, progress is one block redrawn under the log, and the terminal is restored", async () => {
    const root = runDirs.tempRunDir();
    const workflow = join(root, "logs.js");
    await Bun.write(
      workflow,
      executableModule("return null;", 'workflow.log("halfway"); return 1;').replace(
        "run()",
        "run(workflow)",
      ),
    );
    const drawn: string[] = [];
    const errors: string[] = [];

    const exitCode = await cli(["run", "--run-root", runDirs.tempRunDir(), workflow], {
      cwd: ROOT,
      stderr: (text) => errors.push(text),
      terminal: { write: (text) => drawn.push(text), color: false },
      installRuntime: emptyRuntime,
    });

    expect(exitCode).toBe(0);
    expect(errors[0]).toBe("halfway");
    expect(errors.some((line) => line.startsWith("["))).toBe(false);
    expect(drawn[0]).toBe("\x1b[?25l\x1b[?7l");
    expect(drawn.at(-1)).toBe("\x1b[?7h\x1b[?25h");
    expect(drawn.some((frame) => /^fixture \S+ · \d+s\n$/.test(frame))).toBe(true);
    // Once the run is over, its name and clock are the command's and the accounting's.
    expect(drawn.at(-2)).not.toContain("fixture");
  });

  test("prints what the workflow presents, or the JSON with --json, and keeps the JSON and report either way", async () => {
    const root = runDirs.tempRunDir();
    const workflow = join(root, "presented.js");
    await Bun.write(
      workflow,
      executableModule(
        "return null;",
        "return { total: 2 };",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: workflow source text
        "present(result) { return `total ${result.total}`; }, report(result) { return `# ${result.total} found`; },",
      ),
    );
    let errors: string[] = [];
    const invoke = async (...flags: string[]) => {
      const output: string[] = [];
      errors = [];
      const exitCode = await cli(["run", "--run-root", runDirs.tempRunDir(), ...flags, workflow], {
        cwd: ROOT,
        stdout: (text) => output.push(text),
        stderr: (text) => errors.push(text),
        installRuntime: emptyRuntime,
      });
      expect(exitCode).toBe(0);
      return output.join("\n");
    };

    expect(await invoke()).toBe("total 2");
    const [reportLine, artifactsLine] = errors.slice(-2);
    const artifacts = artifactsLine!.replace("Records: ", "").replace(/^~/, homedir());
    expect(reportLine).toBe(`Report: ${join(artifacts, "report.md")}`);
    expect(readFileSync(join(artifacts, "report.md"), "utf8")).toBe("# 2 found\n");
    expect(JSON.parse(readFileSync(join(artifacts, "output.json"), "utf8")).value).toEqual({
      total: 2,
    });

    const json = JSON.parse(await invoke("--json"));
    expect(json.value).toEqual({ total: 2 });
    expect(readFileSync(json.report, "utf8")).toBe("# 2 found\n");
  });

  test("retains and reports the invocation root when execution fails", async () => {
    const runRoot = runDirs.tempRunDir();
    const errors: string[] = [];
    let cleaned = 0;
    const exitCode = await cli(
      ["run", "--run-root", runRoot, "examples/minimum-review/review-loop.ts"],
      {
        cwd: ROOT,
        stderr: (text) => errors.push(text),
        installRuntime: async () => ({
          config: (await emptyRuntime()).config,
          cleanup: async () => {
            cleaned += 1;
          },
        }),
      },
    );

    expect(exitCode).toBe(1);
    expect(cleaned).toBe(1);
    expect(errors.join("\n")).toContain(`its records are in ${runRoot}/review-loop/`);
    expect(errors.join("\n")).toContain("unknown runtime alias: claude");
  });

  test("does not print success when runtime cleanup fails", async () => {
    const adapter = createFakeAdapter({
      harnesses: ["claude", "codex"],
      script: (context) => ({
        act: async () => {
          const lens = context.activation.key.endsWith("correctness")
            ? "correctness"
            : "maintainability";
          await submit(context.binding!, { lens, summary: "done", findings: [] });
        },
      }),
    });
    const output: string[] = [];
    const errors: string[] = [];

    const exitCode = await cli(
      ["run", "--run-root", runDirs.tempRunDir(), "examples/minimum-review/review-loop.ts"],
      {
        cwd: ROOT,
        stdout: (text) => output.push(text),
        stderr: (text) => errors.push(text),
        installRuntime: async () => ({
          config: runtime(adapter),
          cleanup: async () => {
            throw new Error("cleanup broke");
          },
        }),
      },
    );

    expect(exitCode).toBe(1);
    expect(output).toEqual([]);
    const reported = errors.join("\n");
    expect(reported).toContain("runtime cleanup failed");
    expect(reported).toContain("cleanup broke");
    // Stdout is withheld, so the failure has to say where the run's work ended up.
    expect(reported).toContain("its records are in");
    // Every record follows the attempt's final ending, not the success before the cleanup.
    const dir = recordsIn(reported);
    const reason = "runtime cleanup failed: cleanup broke";
    expect(attemptOf(dir)).toMatchObject({ outcome: "failed", reason });
    const saved = JSON.parse(readFileSync(join(dir, "output.json"), "utf8"));
    expect(saved).toMatchObject({ outcome: "failed", reason });
    expect(saved).not.toHaveProperty("value");
    expect(reported).toMatch(/^awf: to go on: awf run .*review-loop\.ts --continue \S+$/m);
  });

  test("fails an incomplete review instead of reporting successful review output", async () => {
    const adapter = createFakeAdapter({ harnesses: ["claude", "codex"], script: () => ({}) });
    const output: string[] = [];
    const errors: string[] = [];
    const exitCode = await cli(
      ["run", "--run-root", runDirs.tempRunDir(), "examples/minimum-review/review-loop.ts"],
      {
        cwd: ROOT,
        stdout: (text) => output.push(text),
        stderr: (text) => errors.push(text),
        installRuntime: async () => ({ config: runtime(adapter), cleanup: async () => undefined }),
      },
    );

    expect(exitCode).toBe(1);
    expect(output).toEqual([]);
    expect(errors.join("\n")).toContain("review incomplete:");
  });

  test("a failed run keeps what it spent in output.json, and prints it with --json", async () => {
    const adapter = createFakeAdapter({
      harnesses: ["claude", "codex"],
      script: (context) => ({ sessionRef: `s-${context.activation.key}` }),
    });
    for (const json of [false, true]) {
      const output: string[] = [];
      const errors: string[] = [];
      const exitCode = await cli(
        [
          "run",
          "--run-root",
          runDirs.tempRunDir(),
          ...(json ? ["--json"] : []),
          "examples/minimum-review/review-loop.ts",
        ],
        {
          cwd: ROOT,
          stdout: (text) => output.push(text),
          stderr: (text) => errors.push(text),
          installRuntime: async () => ({
            config: runtime(adapter, spentFromFiles()),
            cleanup: async () => undefined,
          }),
        },
      );

      expect(exitCode).toBe(1);
      const reported = errors.join("\n");
      expect(reported).toMatch(/^2 agents · .* · subscription$/m);
      expect(reported.indexOf("2 agents")).toBeLessThan(reported.indexOf("run failed"));
      const saved = JSON.parse(readFileSync(join(recordsIn(reported), "output.json"), "utf8"));
      expect(saved).toMatchObject({
        version: OUTPUT_RECORD_VERSION,
        outcome: "failed",
        workflow: { name: "review-loop" },
        accounting: { totals: { agents: 2, known: 2 } },
      });
      expect(saved.reason).toContain("review incomplete:");
      expect(saved).not.toHaveProperty("value");
      expect(output).toEqual(json ? [JSON.stringify(saved, null, 2)] : []);
    }
  });

  describe("a run its own deadline ended is timed-out; a deadline the workflow set is its failure", () => {
    const never = "await new Promise(() => {});";
    const endedBy = async (runBody: string, timeout: string, adapter?: AgentSessionAdapter) => {
      const root = runDirs.tempRunDir();
      const workflow = join(root, "waits.js");
      await Bun.write(workflow, executableModule("return null;", runBody));
      const errors: string[] = [];
      const exitCode = await cli(
        ["run", "--timeout", timeout, "--run-root", runDirs.tempRunDir(), workflow],
        {
          cwd: ROOT,
          stderr: (text) => errors.push(text),
          installRuntime: adapter
            ? async () => ({ config: runtime(adapter), cleanup: async () => undefined })
            : emptyRuntime,
        },
      );
      const saved = JSON.parse(
        readFileSync(join(recordsIn(errors.join("\n")), "output.json"), "utf8"),
      );
      return { exitCode, saved, stderr: errors.join("\n") };
    };

    test("the body waits past the run's deadline", async () => {
      const ended = await endedBy(never, "500ms");
      expect(ended.exitCode).toBe(1);
      expect(ended.saved).toMatchObject({
        version: OUTPUT_RECORD_VERSION,
        outcome: "timed-out",
        accounting: { totals: { agents: 0 } },
      });
      expect(ended.stderr).toContain("awf: run timed out (fixture ");
      expect(ended.stderr).toMatch(/awf: to go on: awf run --run-root \S+ \S+ --continue \S+/);
    });

    test("a stage with no deadline of its own outlives the run", async () => {
      const ended = await endedBy(
        `await workflow.parallel([1, 2], async () => { ${never} });`,
        "500ms",
      );
      expect(ended.exitCode).toBe(1);
      expect(ended.saved.outcome).toBe("timed-out");
      expect(ended.stderr).toContain("awf: run timed out (fixture ");
    });

    test("a stage deadline the workflow set and let escape is failed", async () => {
      const ended = await endedBy(
        `await workflow.parallel([1], async () => { ${never} }, { deadline: { unixMilliseconds: Date.now() + 50 } });`,
        "10s",
      );
      expect(ended.exitCode).toBe(1);
      expect(ended.saved.outcome).toBe("failed");
      expect(ended.stderr).toContain("awf: run failed (fixture ");
    });

    test("a turn that timed out, turned into the workflow's own error, is failed", async () => {
      const adapter = createFakeAdapter({
        harnesses: ["claude", "codex"],
        script: () => ({
          act: (context) =>
            new Promise<void>((resolve) => {
              if (context.signal.aborted) return resolve();
              context.signal.addEventListener("abort", () => resolve(), { once: true });
            }),
        }),
      });
      const ended = await endedBy(
        `const agent = await workflow.agents.open({ key: "a", runtime: "claude" });
         const { outcome } = await agent.run({ prompt: "p", timeoutMs: 50, nudge: false });
         throw new Error("the turn " + outcome.kind);`,
        "10s",
        adapter,
      );
      expect(ended.saved.outcome).toBe("failed");
      expect(ended.saved.reason).toContain("the turn timed-out");
    });

    // Whichever fires first ends the body: a signal once the deadline has also passed still leaves
    // the cancellation as the body's failure. The aggregate case guards the precedence alone.
    test("cancellation wins when the signal and the deadline both fired", () => {
      const deadline = { unixMilliseconds: 1_000 };
      const times = { startedAt: "2026-09-27T00:00:00Z", finishedAt: "2026-09-27T00:00:01Z" };
      const run = {
        runId: "r",
        usage: [],
        ...times,
        accounting: summarizeRun([], PUBLISHED_PRICES, times, []),
      };
      const timedOut = new WorkflowRunError(new DeadlineExceededError(deadline), run);
      expect(runOutcome(timedOut, deadline)).toBe("timed-out");
      expect(runOutcome(timedOut, { unixMilliseconds: 2_000 })).toBe("failed");
      const cancelled = new WorkflowRunError(new WorkflowCancelledError("SIGINT"), run);
      expect(runOutcome(cancelled, deadline)).toBe("cancelled");
      const both = new WorkflowRunError(
        new AggregateError([
          new DeadlineExceededError(deadline),
          new WorkflowCancelledError("SIGINT"),
        ]),
        run,
      );
      expect(runOutcome(both, deadline)).toBe("cancelled");
      const cleanupFailed = new WorkflowRunError(
        new AggregateError([new DeadlineExceededError(deadline), new Error("cleanup")]),
        run,
      );
      expect(runOutcome(cleanupFailed, deadline)).toBe("timed-out");
    });

    test("a stop keeps its own reason, and what failed beside it is said apart", () => {
      const times = { startedAt: "2026-09-27T00:00:00Z", finishedAt: "2026-09-27T00:00:01Z" };
      const run = {
        runId: "r",
        endedIn: "qa",
        usage: [],
        ...times,
        accounting: summarizeRun([], PUBLISHED_PRICES, times, []),
      };
      const stopped = new WorkflowRunError(
        new AggregateError([new WorkflowStopped("no preview", "qa"), new Error("cleanup broke")]),
        run,
      );
      const end = attemptEnd({ error: stopped }, { unixMilliseconds: 1_000 }, () => "awf run …");
      expect(end.ending).toMatchObject({ kind: "stopped", stage: "qa", reason: "no preview" });
      expect(end.alsoFailed).toBe("cleanup broke");
      expect(end.exitCode).toBe(3);
    });
  });

  test("cancels active agents, cleans the runtime, and exits 130 on interruption", async () => {
    const adapter = createFakeAdapter({
      harnesses: ["claude", "codex"],
      script: (context) => ({
        sessionRef: `s-${context.activation.key}`,
        act: (context) =>
          new Promise<void>((resolve) => {
            if (context.signal.aborted) {
              resolve();
              return;
            }
            context.signal.addEventListener("abort", () => resolve(), { once: true });
          }),
      }),
    });
    const controller = new AbortController();
    let cleaned = 0;
    const errors: string[] = [];
    const running = cli(
      [
        "run",
        "--timeout",
        "1s",
        "--run-root",
        runDirs.tempRunDir(),
        "examples/minimum-review/review-loop.ts",
      ],
      {
        cwd: ROOT,
        signal: controller.signal,
        stderr: (text) => errors.push(text),
        installRuntime: async () => ({
          config: runtime(adapter, spentFromFiles()),
          cleanup: async () => {
            cleaned += 1;
          },
        }),
      },
    );
    while (adapter.turns.length === 0) await Bun.sleep(1);
    controller.abort("SIGINT");

    expect(await running).toBe(130);
    expect(cleaned).toBe(1);
    expect(adapter.closed.length).toBeGreaterThan(0);
    expect(errors.join("\n")).toContain("run cancelled");
    const saved = JSON.parse(
      readFileSync(join(recordsIn(errors.join("\n")), "output.json"), "utf8"),
    );
    expect(saved).toMatchObject({ outcome: "cancelled", reason: "workflow cancelled by operator" });
    expect(saved.accounting.totals.known).toBeGreaterThan(0);
  });

  test("preserves cancellation exit status when agent cleanup also fails", async () => {
    const base = createFakeAdapter({
      harnesses: ["claude", "codex"],
      script: () => ({
        act: (context) =>
          new Promise<void>((resolve) => {
            if (context.signal.aborted) return resolve();
            context.signal.addEventListener("abort", () => resolve(), { once: true });
          }),
      }),
    });
    const failingClose: AgentSessionAdapter = {
      ...base,
      async activate(request) {
        const session = await base.activate(request);
        return {
          ...session,
          async close(reason) {
            await session.close(reason);
            throw new Error("session close broke");
          },
        };
      },
    };
    const controller = new AbortController();
    const errors: string[] = [];
    let cleaned = 0;
    const running = cli(
      [
        "run",
        "--timeout",
        "1s",
        "--run-root",
        runDirs.tempRunDir(),
        "examples/minimum-review/review-loop.ts",
      ],
      {
        cwd: ROOT,
        signal: controller.signal,
        stderr: (text) => errors.push(text),
        installRuntime: async () => ({
          config: runtime(failingClose),
          cleanup: async () => {
            cleaned += 1;
          },
        }),
      },
    );
    while (base.turns.length === 0) await Bun.sleep(1);
    controller.abort("SIGINT");

    expect(await running).toBe(130);
    expect(cleaned).toBe(1);
    expect(errors.join("\n")).toContain("run cancelled");
    expect(errors.join("\n")).toContain("session close broke");
    const saved = JSON.parse(
      readFileSync(join(recordsIn(errors.join("\n")), "output.json"), "utf8"),
    );
    expect(saved.outcome).toBe("cancelled");
    expect(saved.reason).toContain("session close broke");
  });

  test("a run root that can't be made refuses the run, naming it", async () => {
    const root = runDirs.tempRunDir();
    const notDirectory = join(root, "not-a-directory");
    await Bun.write(notDirectory, "file");
    const errors: string[] = [];
    const exitCode = await cli(
      ["run", "--run-root", notDirectory, "examples/minimum-review/review-loop.ts"],
      { cwd: ROOT, stderr: (text) => errors.push(text), installRuntime: emptyRuntime },
    );

    expect(exitCode).toBe(2);
    expect(errors.join("\n")).toContain(`awf: ${notDirectory}: `);
    expect(errors.join("\n")).not.toContain("its records are in");
  });
});

describe("awf run's runs and attempts", () => {
  /** Fails while `fail` is in its working directory; returns its run, attempt and args. */
  const flaky = executableModule(
    "return invocation.argv;",
    `const { existsSync } = await import("node:fs");
     if (existsSync(workflow.cwd + "/fail")) throw new Error("not yet");
     return { runId: workflow.runId, attempt: workflow.attempt, args };`,
  ).replace("prepare()", "prepare(invocation)");

  const project = async () => {
    const cwd = runDirs.tempRunDir();
    await Bun.write(join(cwd, "flow.js"), flaky);
    return cwd;
  };
  const awf = async (cwd: string, argv: string[]) => {
    const output: string[] = [];
    const errors: string[] = [];
    let installed = false;
    const exitCode = await cli(["run", "--json", ...argv], {
      cwd,
      stdout: (text) => output.push(text),
      stderr: (text) => errors.push(text),
      installRuntime: async () => {
        installed = true;
        return emptyRuntime();
      },
    });
    const text = output.join("\n");
    return {
      exitCode,
      installed,
      stderr: errors.join("\n"),
      ...(text ? { record: JSON.parse(text) } : {}),
    };
  };
  const runs = (cwd: string) => join(cwd, ".awf", "runs", "fixture");

  test("--id names the run, and a taken id is refused before anything starts", async () => {
    const cwd = await project();
    const first = await awf(cwd, ["--id", "AIRS-1515", "flow.js", "--", "AIRS-1515"]);
    expect(first.exitCode).toBe(0);
    expect(first.record).toMatchObject({
      runId: "AIRS-1515",
      attempt: 1,
      artifacts: join(runs(cwd), "AIRS-1515"),
      value: { runId: "AIRS-1515", attempt: 1, args: ["AIRS-1515"] },
    });
    expect(attemptOf(join(runs(cwd), "AIRS-1515"))).toMatchObject({
      n: 1,
      outcome: "completed",
      flags: { timeout: "30m" },
    });

    const before = readdirSync(runs(cwd));
    const again = await awf(cwd, ["--id", "AIRS-1515", "flow.js", "--", "AIRS-1515"]);
    expect(again).toMatchObject({ exitCode: 2, installed: false });
    expect(readdirSync(runs(cwd))).toEqual(before);
    expect(again.stderr).toBe(
      "awf: AIRS-1515 exists; --continue it, or --id another to start over",
    );
  });

  test("--continue adds an attempt with the run's own argv, and refuses one that changes it", async () => {
    const cwd = await project();
    await Bun.write(join(cwd, "fail"), "");
    const failed = await awf(cwd, ["--id", "r1", "flow.js", "--", "a", "b"]);
    expect(failed.exitCode).toBe(1);
    expect(failed.stderr).toContain(
      `awf: run failed (fixture r1); its records are in ${join(runs(cwd), "r1")}: not yet`,
    );

    const withArgv = await awf(cwd, ["flow.js", "--continue", "r1", "--", "c"]);
    expect(withArgv).toMatchObject({ exitCode: 2, installed: false });
    expect(withArgv.stderr).toContain("r1 keeps the arguments it was started with");
    const both = await awf(cwd, ["--id", "r2", "--continue", "r1", "flow.js"]);
    expect(both.exitCode).toBe(2);
    expect(both.stderr).toContain("--id names a new run and --continue an existing one");
    const missing = await awf(cwd, ["flow.js", "--continue", "r9"]);
    expect(missing).toMatchObject({ exitCode: 2, installed: false });
    expect(missing.stderr).toContain(`no run r9 of fixture in ${join(cwd, ".awf", "runs")}`);

    rmSync(join(cwd, "fail"));
    const continued = await awf(cwd, ["flow.js", "--continue", "r1"]);
    expect(continued.exitCode).toBe(0);
    expect(continued.record).toMatchObject({
      runId: "r1",
      attempt: 2,
      value: { runId: "r1", attempt: 2, args: ["a", "b"] },
    });
    expect(attemptOf(join(runs(cwd), "r1"), 1)).toMatchObject({
      outcome: "failed",
      reason: "not yet",
    });
    expect(attemptOf(join(runs(cwd), "r1"), 2)).toMatchObject({ outcome: "completed" });

    const done = await awf(cwd, ["flow.js", "--continue", "r1"]);
    expect(done).toMatchObject({ exitCode: 2, installed: false });
    expect(done.stderr).toBe("awf: r1 completed; there is nothing to continue");
  });

  test("a continue names an earlier attempt that was interrupted", async () => {
    const cwd = await project();
    await Bun.write(join(cwd, "fail"), "");
    await awf(cwd, ["--id", "r1", "flow.js"]);
    // As a crash leaves it: no ending, and its process gone. This test's own process ran it.
    const file = join(runs(cwd), "r1", "attempts", "1.json");
    const {
      ended: _ended,
      outcome: _outcome,
      reason: _reason,
      ...open
    } = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...open, pid: 999_999_999 }));
    // Its last turn, in qa.
    writeFileSync(
      join(runs(cwd), "r1", "turns.jsonl"),
      `${JSON.stringify({ version: 1, attempt: 1, agent: "w", stage: "qa", outcome: "answered", sessions: [] })}\n`,
    );
    rmSync(join(cwd, "fail"));
    const continued = await awf(cwd, ["flow.js", "--continue", "r1"]);
    expect(continued.exitCode).toBe(0);
    expect(continued.stderr).toContain(
      'awf: attempt 1 of r1 was interrupted in qa; its panes may still be open in Herdr workspace "awf fixture r1 #1"',
    );
  });

  test("a live attempt refuses a continue", async () => {
    const cwd = await project();
    await Bun.write(join(cwd, "fail"), "");
    await awf(cwd, ["--id", "r1", "flow.js"]);
    // This test's own process, with no ending: live.
    const file = join(runs(cwd), "r1", "attempts", "1.json");
    const {
      ended: _ended,
      outcome: _outcome,
      reason: _reason,
      ...open
    } = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify(open));
    const refused = await awf(cwd, ["flow.js", "--continue", "r1"]);
    expect(refused).toMatchObject({ exitCode: 2, installed: false });
    expect(refused.stderr).toBe(`awf: attempt 1 of r1 is still running, as process ${process.pid}`);
    expect(readdirSync(join(runs(cwd), "r1", "attempts"))).toEqual(["1.json"]);
  });

  test("a continue whose recorded argv no longer parses, or whose directory is gone, is refused", async () => {
    const cwd = await project();
    await Bun.write(join(cwd, "fail"), "");
    await awf(cwd, ["--id", "r1", "flow.js", "--", "old"]);
    // The fix that follows renames the argument the run was started with.
    await Bun.write(
      join(cwd, "strict.js"),
      flaky.replace(
        "return invocation.argv;",
        'if (invocation.argv[0] === "old") throw new Error("old is gone"); return invocation.argv;',
      ),
    );
    const parsed = await awf(cwd, ["strict.js", "--continue", "r1"]);
    expect(parsed).toMatchObject({ exitCode: 2, installed: false });
    expect(parsed.stderr).toBe(
      `awf: the recorded argv of r1 no longer parses with ${join(cwd, "strict.js")}: old is gone; start a new run`,
    );

    const record = join(runs(cwd), "r1", "run.json");
    const gone = join(cwd, "gone");
    writeFileSync(
      record,
      JSON.stringify({ ...JSON.parse(readFileSync(record, "utf8")), cwd: gone }),
    );
    const moved = await awf(cwd, ["flow.js", "--continue", "r1"]);
    expect(moved).toMatchObject({ exitCode: 2, installed: false });
    expect(moved.stderr).toBe(`awf: r1 works in ${gone}, which is no longer a directory`);
  });

  test("a continue refuses a sandbox other than its run's", async () => {
    const cwd = await project();
    await Bun.write(join(cwd, "fail"), "");
    await awf(cwd, ["--id", "r1", "flow.js"]);
    await Bun.write(join(cwd, "box.json"), JSON.stringify({ srt: {} }));
    const boxed = await awf(cwd, ["--sandbox", "box.json", "flow.js", "--continue", "r1"]);
    expect(boxed).toMatchObject({ exitCode: 2, installed: false });
    expect(boxed.stderr).toBe(
      "awf: r1 runs in the sandbox it was started with; leave --sandbox out",
    );
  });

  test("a run root holding ~/.awf's sandboxes is refused", async () => {
    const cwd = await project();
    const refused = await awf(cwd, ["--run-root", HOME, "flow.js"]);
    expect(refused).toMatchObject({ exitCode: 2, installed: false });
    expect(refused.stderr).toContain(
      `awf: --run-root ${HOME} holds ${join(HOME, ".awf", "sandboxes")}`,
    );
  });

  test("a continue keeps the run's working directory, and refuses another", async () => {
    const cwd = await project();
    await Bun.write(join(cwd, "fail"), "");
    await awf(cwd, ["--id", "r1", "flow.js"]);
    const elsewhere = runDirs.tempRunDir();
    const moved = await awf(cwd, [
      "--run-root",
      join(cwd, ".awf", "runs"),
      "--cwd",
      elsewhere,
      "flow.js",
      "--continue",
      "r1",
    ]);
    expect(moved.exitCode).toBe(2);
    expect(moved.stderr).toContain(`r1 works in ${cwd}, not ${elsewhere}`);
  });
});

describe("awf run's stages", () => {
  /** Two stages; qa fails while `fail` is in its working directory. */
  const staged = executableModule(
    "return null;",
    `const { existsSync } = await import("node:fs");
     await workflow.stage("implement", { result: { type: "string" }, summary: (b) => b }, async () => "feat/a");
     await workflow.stage("qa", async () => {
       if (existsSync(workflow.cwd + "/fail")) throw new Error("qa broke");
     });
     return workflow.attempt;`,
  );
  const awf = async (cwd: string, argv: string[]) => {
    const output: string[] = [];
    const errors: string[] = [];
    const exitCode = await cli(["run", "--json", ...argv], {
      cwd,
      stdout: (text) => output.push(text),
      stderr: (text) => errors.push(text),
      installRuntime: emptyRuntime,
    });
    const text = output.join("\n");
    return { exitCode, stderr: errors.join("\n"), ...(text ? { record: JSON.parse(text) } : {}) };
  };
  const project = async () => {
    const cwd = runDirs.tempRunDir();
    await Bun.write(join(cwd, "flow.js"), staged);
    return cwd;
  };
  const runDir = (cwd: string) => join(cwd, ".awf", "runs", "fixture", "r1");

  test("--from-stage needs --continue", async () => {
    const cwd = await project();
    const refused = await awf(cwd, ["--from-stage", "qa", "flow.js"]);
    expect(refused.exitCode).toBe(2);
    expect(refused.stderr).toContain(
      "--from-stage goes with --continue: a new run has nothing to reuse",
    );
  });

  test("a continue lists what is recorded, and a completed run is redone only from a stage", async () => {
    const cwd = await project();
    await Bun.write(join(cwd, "fail"), "");
    expect((await awf(cwd, ["--id", "r1", "flow.js"])).exitCode).toBe(1);
    rmSync(join(cwd, "fail"));
    const continued = await awf(cwd, ["flow.js", "--continue", "r1"]);
    expect(continued.exitCode).toBe(0);
    expect(continued.record.value).toBe(2);
    expect(continued.stderr).toMatch(
      /awf: r1 has these stages recorded:\n {2}implement · attempt 1 · 0m ago · feat\/a\n {2}qa · attempt 1 · 0m ago · failed/,
    );

    const done = await awf(cwd, ["flow.js", "--continue", "r1"]);
    expect(done.exitCode).toBe(2);
    expect(done.stderr).toBe(
      "awf: r1 completed; to redo from a stage, --from-stage one of: implement, qa",
    );
    const redone = await awf(cwd, ["flow.js", "--continue", "r1", "--from-stage", "qa"]);
    expect(redone.exitCode).toBe(0);
    expect(attemptOf(runDir(cwd), 3)).toMatchObject({
      outcome: "completed",
      flags: { fromStage: "qa" },
    });
    expect(readdirSync(join(runDir(cwd), "replaced")).toSorted()).toEqual([
      "qa.1.json",
      "qa.2.json",
    ]);
  });

  test("a stop exits 3, recording the stage it stopped at", async () => {
    const cwd = await project();
    await awf(cwd, ["--id", "r1", "flow.js"]);
    const stopped = await awf(cwd, ["flow.js", "--continue", "r1", "--from-stage", "qaa"]);
    expect(stopped.exitCode).toBe(3);
    expect(stopped.stderr).toContain(
      "awf: nothing is recorded for qaa; the attempt stops if it never reaches it",
    );
    expect(stopped.stderr).toContain("awf: run stopped (fixture r1 · attempt 2)");
    expect(stopped.record).toMatchObject({ outcome: "stopped", reason: "never reached qaa" });
    expect(attemptOf(runDir(cwd), 2)).toMatchObject({
      outcome: "stopped",
      reason: "never reached qaa",
    });
    expect(attemptOf(runDir(cwd), 2)).not.toHaveProperty("stage");

    // A record that no longer fits stops at its stage.
    const record = join(runDir(cwd), "stages", "implement.json");
    writeFileSync(
      record,
      JSON.stringify({ ...JSON.parse(readFileSync(record, "utf8")), value: 7 }),
    );
    const misfit = await awf(cwd, ["flow.js", "--continue", "r1", "--from-stage", "qa"]);
    expect(misfit.exitCode).toBe(3);
    expect(misfit.record).toMatchObject({ outcome: "stopped", stage: "implement" });
    expect(misfit.record.reason).toStartWith("implement's record no longer fits:");
    expect(attemptOf(runDir(cwd), 3)).toMatchObject({ outcome: "stopped", stage: "implement" });
  });

  test("the workflow's id(args) names a new run, and --id overrides it", async () => {
    const cwd = runDirs.tempRunDir();
    await Bun.write(
      join(cwd, "ticket.js"),
      executableModule(
        "return invocation.argv;",
        "return workflow.runId;",
        "id(args) { return args[0]; },",
      ).replace("prepare()", "prepare(invocation)"),
    );
    const derived = await awf(cwd, ["ticket.js", "--", "AIRS-1515"]);
    expect(derived.record).toMatchObject({ runId: "AIRS-1515", value: "AIRS-1515" });
    const taken = await awf(cwd, ["ticket.js", "--", "AIRS-1515"]);
    expect(taken.exitCode).toBe(2);
    expect(taken.stderr).toBe(
      "awf: AIRS-1515 exists; --continue it, or --id another to start over",
    );
    const given = await awf(cwd, ["--id", "retry-2", "ticket.js", "--", "AIRS-1515"]);
    expect(given.record).toMatchObject({ runId: "retry-2" });
    const bad = await awf(cwd, ["ticket.js", "--", "has space"]);
    expect(bad.exitCode).toBe(2);
    expect(bad.stderr).toContain('the workflow\'s id(args): "has space" is not a valid id');
  });

  test("the same stop between stages twice says to move the check into the stage", async () => {
    const cwd = runDirs.tempRunDir();
    await Bun.write(
      join(cwd, "flow.js"),
      executableModule(
        "return null;",
        `const doc = await workflow.stage("doc-review", { result: { type: "string" } }, async () => "no-doc");
         if (doc === "no-doc") workflow.stop("the ticket has no doc");
         return doc;`,
      ),
    );
    const first = await awf(cwd, ["--id", "r1", "flow.js"]);
    expect(first.exitCode).toBe(3);
    expect(first.stderr).not.toContain("the same stop");
    const second = await awf(cwd, ["flow.js", "--continue", "r1"]);
    expect(second.exitCode).toBe(3);
    expect(second.stderr).toContain(
      "awf: the same stop as attempt 1; if a stage's value caused it, --from-stage doc-review, and move the check into that stage",
    );
  });

  test("no hint for a stop no reused stage could have caused, nor for another reason", async () => {
    const cwd = runDirs.tempRunDir();
    await Bun.write(
      join(cwd, "early.js"),
      executableModule("return null;", 'return workflow.stop("not ready");'),
    );
    await awf(cwd, ["--id", "r1", "early.js"]);
    const again = await awf(cwd, ["early.js", "--continue", "r1"]);
    expect(again.exitCode).toBe(3);
    expect(again.stderr).not.toContain("the same stop");

    await Bun.write(
      join(cwd, "counted.js"),
      executableModule(
        "return null;",
        `await workflow.stage("doc-review", async () => {});
         return workflow.stop("stop " + workflow.attempt);`,
      ),
    );
    await awf(cwd, ["--id", "r2", "counted.js"]);
    const other = await awf(cwd, ["counted.js", "--continue", "r2"]);
    expect(other.exitCode).toBe(3);
    expect(other.stderr).not.toContain("the same stop");
  });

  test("an id(args) that throws or returns no string is refused", async () => {
    const cwd = runDirs.tempRunDir();
    for (const [file, body, said] of [
      [
        "throws.js",
        'id() { throw new Error("no ticket"); },',
        "the workflow's id(args) failed: no ticket",
      ],
      [
        "number.js",
        "id() { return 7; },",
        "the workflow's id(args): it returned a number, not a string",
      ],
    ] as const) {
      await Bun.write(join(cwd, file), executableModule("return null;", "return 1;", body));
      const refused = await awf(cwd, [file]);
      expect(refused.exitCode).toBe(2);
      expect(refused.stderr).toContain(said);
    }
  });

  test("a failure names its stage and the command that goes on; the attempt keeps its stages", async () => {
    const cwd = await project();
    await Bun.write(join(cwd, "fail"), "");
    const failed = await awf(cwd, ["--id", "r1", "flow.js"]);
    expect(failed.exitCode).toBe(1);
    expect(failed.stderr).toContain("awf: run failed in qa (fixture r1); its records are in");
    expect(failed.stderr).toContain("awf: to go on: awf run flow.js --continue r1");
    expect(failed.record).toMatchObject({
      outcome: "failed",
      stage: "qa",
      stages: [
        { stage: "implement", source: "ran", outcome: "succeeded", attempt: 1, summary: "feat/a" },
        { stage: "qa", source: "ran", outcome: "failed", attempt: 1 },
      ],
    });
    expect(failed.record.stages[0]).not.toHaveProperty("value");
    const attempt = attemptOf(runDir(cwd), 1);
    expect(attempt).toMatchObject({ outcome: "failed", stage: "qa", stages: failed.record.stages });
    expect(attempt.accounting).toMatchObject({
      byStage: [{ stage: "implement" }, { stage: "qa" }],
    });

    rmSync(join(cwd, "fail"));
    const continued = await awf(cwd, ["flow.js", "--continue", "r1"]);
    expect(continued.record.stages).toEqual([
      {
        stage: "implement",
        source: "reused",
        outcome: "succeeded",
        attempt: 1,
        spanMs: 0,
        summary: "feat/a",
      },
      { stage: "qa", source: "ran", outcome: "succeeded", attempt: 2, spanMs: expect.any(Number) },
    ]);
    expect(continued.stderr).toMatch(/^run r1, 2 attempts: 0 agents · \d+s$/m);
  });

  test("a stop at a record that no longer fits goes on from that stage", async () => {
    const cwd = await project();
    await awf(cwd, ["--run-root", "runs", "--id", "r1", "flow.js"]);
    const record = join(cwd, "runs", "fixture", "r1", "stages", "implement.json");
    writeFileSync(
      record,
      JSON.stringify({ ...JSON.parse(readFileSync(record, "utf8")), value: 7 }),
    );
    const stopped = await awf(cwd, [
      "--run-root",
      "runs",
      "flow.js",
      "--continue",
      "r1",
      "--from-stage",
      "qa",
    ]);
    expect(stopped.exitCode).toBe(3);
    expect(stopped.stderr).toContain(
      `awf: to go on: awf run --run-root ${join(cwd, "runs")} flow.js --continue r1 --from-stage implement`,
    );
  });

  test("a stop is awf's to print, and the report hands off what its stages found", async () => {
    const cwd = runDirs.tempRunDir();
    await Bun.write(
      join(cwd, "flow.js"),
      executableModule(
        "return null;",
        `await workflow.stage("doc-review", { result: { type: "string" }, summary: (d) => d }, async () => "docs/a.md");
         return workflow.stop("the doc has open questions");`,
        `present() { throw new Error("present is for a completed run"); },
         report(value, ending) {
           return "# " + ending.kind + " " + value + "\\n\\n" + ending.stages.map((s) => s.stage + ": " + s.value).join("\\n") + "\\n\\n" + ending.reason;
         },`,
      ),
    );
    const output: string[] = [];
    const errors: string[] = [];
    const exitCode = await cli(["run", "--id", "r1", "flow.js"], {
      cwd,
      stdout: (text) => output.push(text),
      stderr: (text) => errors.push(text),
      installRuntime: emptyRuntime,
    });
    expect(exitCode).toBe(3);
    expect(output).toEqual([]);
    expect(errors).toContain("awf: to go on: awf run flow.js --continue r1");
    expect(errors.join("\n")).not.toContain("present");
    expect(readFileSync(join(cwd, ".awf/runs/fixture/r1/report.md"), "utf8")).toBe(
      "# stopped undefined\n\ndoc-review: docs/a.md\n\nthe doc has open questions\n",
    );
  });

  test("a failure that escapes between stages names none", async () => {
    const cwd = runDirs.tempRunDir();
    await Bun.write(
      join(cwd, "flow.js"),
      executableModule(
        "return null;",
        `await workflow.stage("qa", async () => { throw new Error("qa broke"); }).catch(() => undefined);
         throw new Error("after qa");`,
      ),
    );
    const failed = await awf(cwd, ["--id", "r1", "flow.js"]);
    expect(failed.exitCode).toBe(1);
    expect(failed.stderr).toContain("awf: run failed (fixture r1)");
    expect(failed.record).not.toHaveProperty("stage");
  });

  test("a later attempt totals the run, naming an attempt with no accounting, and drops a stale report", async () => {
    const cwd = runDirs.tempRunDir();
    const flow = (withReport: boolean) =>
      executableModule(
        "return null;",
        `await workflow.stage("qa", async () => {
           if (workflow.attempt < 3) throw new Error("not yet");
         });
         return null;`,
        withReport ? 'report() { return "# a report"; },' : "",
      );
    await Bun.write(join(cwd, "flow.js"), flow(true));
    await awf(cwd, ["--id", "r1", "flow.js"]);
    const dir = join(cwd, ".awf", "runs", "fixture", "r1");
    expect(existsSync(join(dir, "report.md"))).toBe(true);
    await awf(cwd, ["flow.js", "--continue", "r1"]);
    // Attempt 2 as an interruption leaves it: no ending, no accounting.
    const second = join(dir, "attempts", "2.json");
    const {
      ended: _e,
      outcome: _o,
      reason: _r,
      accounting: _a,
      stages: _s,
      stage: _t,
      ...open
    } = JSON.parse(readFileSync(second, "utf8"));
    writeFileSync(second, JSON.stringify({ ...open, pid: 999_999_999 }));
    // Another file, as a fix is often tried: this one writes no report.
    await Bun.write(join(cwd, "fixed.js"), flow(false));
    const third = await awf(cwd, ["fixed.js", "--continue", "r1"]);
    expect(third.exitCode).toBe(0);
    expect(third.stderr).toMatch(/^run r1, 3 attempts \(1 with no accounting\): 0 agents · /m);
    expect(existsSync(join(dir, "report.md"))).toBe(false);
  });

  test("--from-stage refuses a name that can't be a stage's", async () => {
    const cwd = await project();
    const refused = await awf(cwd, ["flow.js", "--continue", "r1", "--from-stage", "QA"]);
    expect(refused.exitCode).toBe(2);
    expect(refused.stderr).toContain('--from-stage: "QA" is not a stage\'s name');
  });
});

describe("awf run --here", () => {
  const WORKFLOW = "examples/calling-session/workflow.ts";
  const inHerdr = { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w1", AWF_HERDR_SESSION: "default" };

  /** A Herdr whose panes show what `screens` says, recording every call. */
  function fakeHerdr(screens: Record<string, { agent?: string; screen: string }> = {}) {
    const calls: string[][] = [];
    const run: RunProcess = async (input) => {
      const args = input.argv.slice(3);
      calls.push(args);
      const ok = (result: unknown, stdout?: string) => ({
        stdout: stdout ?? JSON.stringify({ result }),
        stderr: "",
        exitCode: 0,
        timedOut: false,
      });
      const [noun, verb, target] = args;
      if (noun === "pane" && verb === "list") {
        return ok({
          panes: Object.entries(screens).map(([pane_id, { agent }]) => ({
            pane_id,
            ...(agent ? { agent } : {}),
            cwd: ROOT,
          })),
        });
      }
      if (noun === "pane" && verb === "read") return ok({}, screens[target!]?.screen ?? "$ ");
      if (noun === "tab" && verb === "create") {
        return ok({ tab: { tab_id: "w1:t9" }, root_pane: { pane_id: "w1:p9" } });
      }
      if (noun === "agent" && (verb === "wait" || verb === "prompt")) {
        return ok({ agent: { agent_status: "idle" } });
      }
      return ok({});
    };
    return { run, calls };
  }

  test("refuses outside a Herdr pane, before asking Herdr anything", async () => {
    const herdr = fakeHerdr();
    const errors: string[] = [];
    const exitCode = await cli(["run", "--here", WORKFLOW], {
      cwd: ROOT,
      environment: {},
      herdr: herdr.run,
      stderr: (text) => errors.push(text),
    });
    expect(exitCode).toBe(1);
    expect(errors).toEqual([
      "awf: --here: this session is not in a Herdr pane, so a run cannot drive it. Start the agent in a Herdr pane, or run the workflow from a shell with awf run and no --here.",
    ]);
    expect(herdr.calls).toEqual([]);
  });

  test("under codex's sandbox, names the setting that lets it reach Herdr", async () => {
    const errors: string[] = [];
    const exitCode = await cli(["run", "--here", WORKFLOW], {
      cwd: ROOT,
      environment: { ...inHerdr, CODEX_SESSION_ID: "t-1" },
      herdr: async () => ({
        stdout: "",
        stderr: "Error: PermissionDenied",
        exitCode: 1,
        timedOut: false,
      }),
      stderr: (text) => errors.push(text),
    });
    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("this session cannot reach Herdr: Error: PermissionDenied");
    expect(errors.join("\n")).toContain("-c sandbox_workspace_write.network_access=true");
  });

  test("refuses a workflow file that is not there", async () => {
    const errors: string[] = [];
    const exitCode = await cli(["run", "--here", "nowhere.ts"], {
      cwd: ROOT,
      environment: inHerdr,
      herdr: fakeHerdr().run,
      stderr: (text) => errors.push(text),
    });
    expect(exitCode).toBe(1);
    expect(errors).toEqual([
      `awf: --here: no workflow file at ${join(ROOT, "nowhere.ts")}. Name it by a path from this directory.`,
    ]);
  });

  test("refuses a workflow that will not start, before any tab opens", async () => {
    const herdr = fakeHerdr();
    const errors: string[] = [];
    const exitCode = await cli(["run", "--here", WORKFLOW, "--", "bogus"], {
      cwd: ROOT,
      environment: inHerdr,
      herdr: herdr.run,
      stderr: (text) => errors.push(text),
    });
    expect(exitCode).toBe(1);
    expect(errors).toEqual([
      "awf: --here: the workflow cannot start: the only argument is --no-helper. Fix it, then run this again.",
    ]);
    expect(herdr.calls.some((call) => call[0] === "tab")).toBe(false);
  });

  test("starts the run in a new tab with a code, and prints the line to end the turn with", async () => {
    const herdr = fakeHerdr();
    const output: string[] = [];
    const exitCode = await cli(
      ["run", "--here", "--timeout", "20m", WORKFLOW, "--", "--no-helper"],
      {
        cwd: ROOT,
        environment: inHerdr,
        herdr: herdr.run,
        self: ["awf"],
        stdout: (text) => output.push(text),
      },
    );
    expect(exitCode).toBe(0);
    const code = output.join("\n").split("\n").at(-1)!;
    expect(code).toMatch(/^awf-here-[0-9a-f]{8}$/);
    expect(herdr.calls).toContainEqual([
      "tab",
      "create",
      "--workspace",
      "w1",
      "--cwd",
      ROOT,
      "--label",
      "awf workflow.ts",
      "--no-focus",
    ]);
    // Only awf's own --here is dropped; its other options and the workflow's arguments pass.
    expect(herdr.calls.find((call) => call[1] === "run")).toEqual([
      "pane",
      "run",
      "w1:p9",
      ["awf", "run", "--session", code, "--timeout", "20m", WORKFLOW, "--", "--no-helper"]
        .map((arg) => `'${arg}'`)
        .join(" "),
    ]);
  });

  test("a run whose code no pane shows refuses before it starts", async () => {
    const herdr = fakeHerdr({ "w1:p1": { agent: "claude", screen: "something else" } });
    const errors: string[] = [];
    const runRoot = runDirs.tempRunDir();
    let installed = false;
    const exitCode = await cli(
      ["run", "--session", "awf-here-0123abcd", "--run-root", runRoot, WORKFLOW],
      {
        cwd: ROOT,
        environment: inHerdr,
        herdr: herdr.run,
        callerSearchMs: 50,
        stderr: (text) => errors.push(text),
        installRuntime: async () => {
          installed = true;
          return emptyRuntime();
        },
      },
    );
    expect(exitCode).toBe(1);
    expect(errors).toEqual([
      "awf: --session: no agent pane showed awf-here-0123abcd in its last 200 lines; the calling session puts it there by replying with it",
    ]);
    expect(installed).toBe(false);
    expect(existsSync(runRoot) && readdirSync(runRoot)).toEqual([]);
  });

  test("a session another live run drives is refused; a mark its process left behind is not", async () => {
    const herdr = fakeHerdr({ "w1:p1": { agent: "pi", screen: "awf-here-0123abcd" } });
    const runRoot = runDirs.tempRunDir();
    mkdirSync(join(HOME, ".awf", "callers"), { recursive: true });
    writeFileSync(join(HOME, ".awf", "callers", "w1_p1.pid"), String(process.pid));
    const errors: string[] = [];
    const exitCode = await cli(
      ["run", "--session", "awf-here-0123abcd", "--run-root", runRoot, WORKFLOW],
      {
        cwd: ROOT,
        environment: { ...inHerdr, HERDR_TAB_ID: "w1:t2" },
        herdr: herdr.run,
        stderr: (text) => errors.push(text),
        installRuntime: emptyRuntime,
      },
    );
    expect(exitCode).toBe(1);
    expect(errors).toEqual([
      `awf: --session: another run (process ${process.pid}) is already driving the session in w1:p1; one run drives a session at a time`,
    ]);
    expect(herdr.calls).toContainEqual(["tab", "focus", "w1:t2"]);
    expect(readdirSync(join(HOME, ".awf", "callers"))).toEqual(["w1_p1.pid"]);

    writeFileSync(join(HOME, ".awf", "callers", "w1_p1.pid"), "999999999");
    const second = await cli(
      ["run", "--session", "awf-here-0123abcd", "--run-root", runRoot, WORKFLOW],
      {
        cwd: ROOT,
        environment: inHerdr,
        herdr: herdr.run,
        stderr: () => undefined,
        installRuntime: emptyRuntime,
      },
    );
    // Past the mark, it fails only because the empty runtime has no calling session.
    expect(second).toBe(1);
    expect(existsSync(join(HOME, ".awf", "callers", "w1_p1.pid"))).toBe(false);
  });

  test("takes the pane showing its code over, and hands it back with how the run ended", async () => {
    const herdr = fakeHerdr({
      "w1:p1": { agent: "pi", screen: "awf-here-0123abcd" },
      "w1:p2": { agent: "claude", screen: "elsewhere" },
    });
    const output: string[] = [];
    const runRoot = runDirs.tempRunDir();
    let asked: unknown;
    const adapter = createFakeAdapter({
      harnesses: ["pi"],
      script: (context) => ({
        act: async () => {
          const picking = context.prompt.includes("Pick");
          await submit(
            context.binding!,
            picking ? { number: 4827 } : { number: 4827, agrees: true },
          );
        },
      }),
    });
    const exitCode = await cli(
      [
        "run",
        "--session",
        "awf-here-0123abcd",
        "--run-root",
        runRoot,
        WORKFLOW,
        "--",
        "--no-helper",
      ],
      {
        cwd: ROOT,
        environment: inHerdr,
        herdr: herdr.run,
        stdout: (text) => output.push(text),
        stderr: () => undefined,
        installRuntime: async (_timeout, options) => {
          asked = options.caller;
          return {
            config: {
              aliases: {},
              host: {
                caller: { harness: "pi", cwd: ROOT },
                openRun: (spec) => createSingleSessionHostFactory(adapter).openRun(spec),
              },
            },
            cleanup: async () => undefined,
          };
        },
      },
    );
    expect(exitCode).toBe(0);
    expect(asked).toEqual({
      pane: { paneId: "w1:p1", harness: "pi", cwd: ROOT },
      session: "default",
    });
    expect(output.join("\n")).toContain("pi: picked 4827, recalled 4827 (right)");
    const handedBack = herdr.calls.find((call) => call[0] === "agent" && call[1] === "prompt");
    expect(handedBack?.[2]).toBe("w1:p1");
    expect(handedBack?.[3]).toMatch(
      /^\[awf\] The workflow calling-session, run \S+, succeeded; its record is .*output\.json\. The run is over and this session is yours; nothing here needs an answer\.$/,
    );
  });
});

async function emptyRuntime() {
  const adapter = createFakeAdapter({ script: () => ({}) });
  return {
    config: { aliases: {}, host: createSingleSessionHostFactory(adapter) },
    cleanup: async () => undefined,
  };
}

function executableModule(prepareBody: string, runBody: string, members = ""): string {
  return `
    export default {
      kind: "awf.executable-workflow/v1",
      definition: {
        meta: { name: "fixture", description: "fixture workflow" },
        async run(workflow, args) { ${runBody} },
      },
      prepare() { ${prepareBody} },
      ${members}
    };
  `;
}

/** An attempt's record in a run's folder: the first, unless `n` says another. */
function attemptOf(runDir: string, n = 1): Record<string, unknown> {
  return JSON.parse(readFileSync(join(runDir, "attempts", `${n}.json`), "utf8"));
}

/** The run's folder, as a run that did not complete names it. */
function recordsIn(stderr: string): string {
  const matched = /its records are in ([^:]+):/.exec(stderr);
  if (!matched?.[1]) throw new Error(`missing the run's folder in: ${stderr}`);
  return matched[1];
}

function runtime(adapter: AgentSessionAdapter, accounting?: SessionAccounting): AgentRuntimeConfig {
  return {
    aliases: {
      claude: { harness: "claude", model: "sonnet" },
      codex: { harness: "codex", model: "gpt-5.6-sol" },
    },
    host: createSingleSessionHostFactory(adapter, accounting),
  };
}

/** Each agent's session file holds one request, under the model id the harness logs. */
function spentFromFiles(): SessionAccounting {
  return {
    pollMs: 5,
    stalledMs: 50,
    statusMs: 50,
    async read(execution, sessions) {
      return {
        open: false,
        records: sessions.map((session) => ({
          key: session,
          at: new Date().toISOString(),
          model: execution.model === "sonnet" ? "claude-sonnet-5" : execution.model,
          delegated: false,
          tokens: { input: 1_000, cacheRead: 9_000, cacheWrite: 0, output: 500 },
        })),
      };
    },
    async billing() {
      return "subscription";
    },
  };
}

describe("awf test", () => {
  // A workflow and its tests in a folder outside the repository, with nothing installed there.
  const folder = async () => {
    const dir = runDirs.tempRunDir();
    await Bun.write(
      join(dir, "summarize.ts"),
      `import { defineExecutableWorkflow, isAnswered } from "agentswf/workflow";
import Type from "typebox";

export const SUMMARY = Type.Object({ summary: Type.String() }, { additionalProperties: false });

export default defineExecutableWorkflow<{ file: string }, string>({
  definition: {
    meta: { name: "summarize", description: "Summarize a file.", whenToUse: "In tests." },
    async run(workflow, { file }) {
      const agent = await workflow.agents.open({ key: "writer", runtime: "claude" });
      const { outcome } = await agent.run({ prompt: \`Summarize \${file}.\`, schema: SUMMARY });
      if (!isAnswered(outcome)) throw new Error(outcome.kind);
      return outcome.value.summary;
    },
  },
  prepare: ({ argv }) => ({ file: argv[0] ?? "README.md" }),
});
`,
    );
    await Bun.write(
      join(dir, "summarize.test.ts"),
      `import { expect, test } from "bun:test";
import { answer, testWorkflow } from "agentswf/testing";
import summarize, { SUMMARY } from "./summarize";

test("returns the writer's summary", async () => {
  const run = await testWorkflow(summarize, { file: "a.md" }, {
    agents: { writer: answer(SUMMARY, { summary: "short" }) },
  });
  expect(run.value).toBe("short");
});

test("a summary that is not the writer's fails", async () => {
  const run = await testWorkflow(summarize, { file: "a.md" }, {
    agents: { writer: answer(SUMMARY, { summary: "long" }) },
  });
  expect(run.value).toBe("short");
});
`,
    );
    return dir;
  };
  const awfTest = async (cwd: string, ...argv: string[]) => {
    const output: string[] = [];
    const exitCode = await cli(["test", ...argv], {
      cwd,
      stdout: (text) => output.push(text),
      stderr: (text) => output.push(text),
    });
    return { exitCode, output: output.join("\n") };
  };

  test("runs a workflow's tests in any folder, failing as bun test fails, installing nothing", async () => {
    const dir = await folder();
    const all = await awfTest(dir);
    expect(all.exitCode).toBe(1);
    expect(all.output).toContain("1 pass");
    expect(all.output).toContain("1 fail");
    expect(all.output).toContain("(fail) a summary that is not the writer's fails");

    const passing = await awfTest(dir, "-t", "returns", "--timeout", "10s");
    expect(passing.exitCode).toBe(0);
    expect(passing.output).toContain("1 pass");
    expect(readdirSync(dir).toSorted()).toEqual(["summarize.test.ts", "summarize.ts"]);
    expect(existsSync(join(dir, "node_modules"))).toBe(false);
  });

  test("a path is a file or directory, never a filter; one that doesn't exist is refused", async () => {
    const dir = runDirs.tempRunDir();
    for (const sub of ["a", "ab"]) {
      await Bun.write(
        join(dir, sub, "one.test.ts"),
        `import { test } from "bun:test";\ntest("${sub}", () => {});\n`,
      );
    }
    const onlyA = await awfTest(dir, "a");
    expect(onlyA.exitCode).toBe(0);
    expect(onlyA.output).toContain("Ran 1 test across 1 file");
    const missing = await awfTest(dir, "b");
    expect(missing.exitCode).toBe(2);
    expect(missing.output).toContain("no such file or directory: b");
  });

  test("--help prints the usage", async () => {
    const help = await awfTest(runDirs.tempRunDir(), "--help");
    expect(help.exitCode).toBe(0);
    expect(help.output).toStartWith("usage: awf test");
  });

  test("as a command, it exits with the tests' code and leaves their output to the terminal", async () => {
    const dir = await folder();
    const child = Bun.spawn([CLI, "test"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(code).toBe(1);
    expect(err).toContain("1 fail");
  });

  test("a signal to awf alone stops the tests, and leaves no test process behind", async () => {
    const dir = runDirs.tempRunDir();
    await Bun.write(
      join(dir, "slow.test.ts"),
      `import { test } from "bun:test";\ntest("slow", async () => { await Bun.sleep(20_000); }, 30_000);\n`,
    );
    const awf = Bun.spawn([CLI, "test"], { cwd: dir, stdout: "ignore", stderr: "ignore" });
    let tests: number | undefined;
    for (let tries = 0; tests === undefined && tries < 100; tries += 1) {
      await Bun.sleep(50);
      const listed = Bun.spawnSync(["pgrep", "-P", String(awf.pid)])
        .stdout.toString()
        .trim();
      if (listed) tests = Number(listed.split("\n")[0]);
    }
    expect(tests).toBeDefined();
    awf.kill("SIGINT");
    expect(await awf.exited).toBe(130);
    expect(() => process.kill(tests!, 0)).toThrow();
  });

  test("passes on only its own flags", async () => {
    const refused = await awfTest(runDirs.tempRunDir(), "--coverage");
    expect(refused.exitCode).toBe(2);
    expect(refused.output).toContain("unknown option: --coverage");
    expect(refused.output).toContain("usage: awf test");
    expect((await awfTest(runDirs.tempRunDir(), "-t")).output).toContain("-t needs a pattern");
  });
});
