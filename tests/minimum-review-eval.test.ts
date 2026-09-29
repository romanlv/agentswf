import { describe, expect, test } from "bun:test";
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessTurn } from "../packages/harness/src/adapter";
import type { ProcessInput } from "../packages/harness/src/command";
import { assertLiveOptIn } from "./live";
import type { NativeOutcomeEvidence } from "./minimum-review.eval";
import {
  agentVersionEvidence,
  assertCompletedReviews,
  assertNativeEvidence,
  herdrBehaviourCheck,
  herdrVersionCheck,
  LIVE_EVALUATION_BOUNDS,
  liveRuntime,
  observeTurn,
  retainEvaluationEvidence,
  runLiveEvaluation,
} from "./minimum-review.eval";

const nativeOutcome = (
  reviewer: "correctness" | "maintainability",
  overrides: Partial<NativeOutcomeEvidence> = {},
): NativeOutcomeEvidence => ({
  agent: `reviewer:${reviewer}`,
  harness: reviewer === "correctness" ? "claude" : "codex",
  operation: "turn",
  settlement: "native",
  state: "completed",
  usageSamples: 0,
  ...overrides,
});

describe("minimum review live evaluation plan", () => {
  test("is bounded to two subscription reviewers with one run-owned host", async () => {
    const commands: string[][] = [];
    const runtime = liveRuntime([], async (input: ProcessInput) => {
      commands.push([...input.argv]);
      return {
        stdout: JSON.stringify({
          result: input.argv.includes("create")
            ? {
                workspace: { workspace_id: "w1" },
                tab: { tab_id: "w1:t1" },
                root_pane: { pane_id: "w1:p1" },
              }
            : {},
        }),
        stderr: "",
        exitCode: 0,
        timedOut: false,
      };
    });

    // The only spending guard `bun test` runs: a metered model or a longer bound fails here.
    expect(LIVE_EVALUATION_BOUNDS).toMatchObject({
      workflowMilliseconds: 600_000,
      initialTurnMilliseconds: 300_000,
      maximumNudgesPerReviewer: 1,
      meteredFallback: false,
      agentVersionPolicy: "record-only",
      workspaceTrust: "evaluator-created-disposable",
    });
    expect(runtime.aliases).toEqual({
      correctness: { harness: "claude", model: "claude-haiku-4-5" },
      maintainability: { harness: "codex", model: "gpt-6-luna" },
    });
    const host = await runtime.host.openRun({
      runId: "test",
      cwd: "/repo",
      deadline: { unixMilliseconds: Date.now() + 60_000 },
    });
    expect(host.inspect()).toEqual({ state: "running", agents: [] });
    await host.close();
    // The run's workspace opens at its first tab: a host no agent used leaves nothing to close.
    expect(commands).toEqual([]);
  });

  test("requires an exact opt-in value at the spending boundary", () => {
    expect(() => assertLiveOptIn({})).toThrow("AWF_LIVE_EVAL=1");
    expect(() => assertLiveOptIn({ AWF_LIVE_EVAL: "true" })).toThrow("AWF_LIVE_EVAL=1");
    expect(() => assertLiveOptIn({ AWF_LIVE_EVAL: "1" })).not.toThrow();
  });

  test("records agent upgrades without blocking and keeps Herdr pinned", () => {
    expect(
      agentVersionEvidence("claude", {
        stdout: "",
        stderr: "unknown option --version",
        exitCode: 2,
      }),
    ).toMatchObject({ ok: true, detail: "unknown option --version" });
    expect(herdrVersionCheck({ stdout: "herdr 0.9.0", stderr: "", exitCode: 0 })).toMatchObject({
      ok: false,
      detail: expect.stringContaining("herdr 0.9.1"),
    });
    expect(herdrVersionCheck({ stdout: "herdr 0.9.10", stderr: "", exitCode: 0 })).toMatchObject({
      ok: false,
    });
  });

  test("catches Herdr dropping the behaviour the pane host is built on", () => {
    const help = (text: string) => ({ stdout: text, stderr: "", exitCode: 0 });
    const prompt = help(
      "returns agent_prompt_stalled. It does not track turns: if the agent is already working,",
    );
    const tab = help("      --env <KEY=VALUE>\n          Set an environment variable");

    expect(herdrBehaviourCheck(prompt, tab).ok).toBe(true);
    expect(herdrBehaviourCheck(help("returns agent_prompt_stalled."), tab).detail).toContain(
      "turn tracking",
    );
    expect(herdrBehaviourCheck(help("it does not track turns"), tab).detail).toContain(
      "agent_prompt_stalled",
    );
    expect(herdrBehaviourCheck(prompt, help("      --cwd <PATH>")).detail).toContain("--env");
  });

  test("the exported spending function refuses to begin without opt-in", async () => {
    const previous = process.env.AWF_LIVE_EVAL;
    delete process.env.AWF_LIVE_EVAL;
    try {
      await expect(runLiveEvaluation()).rejects.toThrow("AWF_LIVE_EVAL=1");
    } finally {
      if (previous === undefined) delete process.env.AWF_LIVE_EVAL;
      else process.env.AWF_LIVE_EVAL = previous;
    }
  });

  test("retained evidence replaces permissive files and symlinks with a private regular file", async () => {
    const root = await mkdtemp(join(tmpdir(), "wf-evidence-test-"));
    const evidence = join(root, "evaluation.json");
    const target = join(root, "symlink-target");
    try {
      await writeFile(evidence, "old");
      await chmod(evidence, 0o666);
      await retainEvaluationEvidence(root, Date.now(), [], undefined);
      let metadata = await lstat(evidence);
      expect(metadata.isFile()).toBe(true);
      expect(metadata.mode & 0o777).toBe(0o600);
      expect(Object.keys(JSON.parse(await readFile(evidence, "utf8")))).toEqual([
        "bounds",
        "elapsedMilliseconds",
        "nativeOutcomes",
      ]);

      await rm(evidence);
      await writeFile(target, "untouched");
      await symlink(target, evidence);
      await retainEvaluationEvidence(root, Date.now(), [], undefined);
      metadata = await lstat(evidence);
      expect(metadata.isFile()).toBe(true);
      expect(metadata.isSymbolicLink()).toBe(false);
      expect(metadata.mode & 0o777).toBe(0o600);
      expect(await readFile(target, "utf8")).toBe("untouched");

      const circular: { self?: unknown } = {};
      circular.self = circular;
      await expect(
        retainEvaluationEvidence(root, Date.now(), [], circular),
      ).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("requires exactly two completed reviews in lens order", () => {
    const completed = (lens: "correctness" | "maintainability") => ({
      kind: "completed" as const,
      lens,
      summary: `${lens} complete`,
      findings: [],
    });

    expect(() =>
      assertCompletedReviews([completed("correctness"), completed("maintainability")]),
    ).not.toThrow();
    expect(() =>
      assertCompletedReviews([completed("maintainability"), completed("correctness")]),
    ).toThrow("completed reviews in lens order");
    expect(() =>
      assertCompletedReviews([
        {
          kind: "incomplete",
          lens: "correctness",
          outcome: "blocked",
          reason: "workspace trust required",
        },
        completed("maintainability"),
      ]),
    ).toThrow("correctness:incomplete:blocked:workspace trust required");
  });

  test("requires terminal native evidence from both configured harnesses", () => {
    expect(() =>
      assertNativeEvidence([nativeOutcome("correctness"), nativeOutcome("maintainability")]),
    ).not.toThrow();
    expect(() =>
      assertNativeEvidence([
        nativeOutcome("correctness", { settlement: "released", state: "cancelled" }),
        nativeOutcome("maintainability", { settlement: "released", state: "cancelled" }),
      ]),
    ).not.toThrow();
    expect(() =>
      assertNativeEvidence([nativeOutcome("correctness", { state: "timed-out" })]),
    ).toThrow("native completion or confirmed release");
  });

  test("rejects a failed nudge even after that reviewer's initial native completion", () => {
    expect(() =>
      assertNativeEvidence([
        nativeOutcome("correctness"),
        nativeOutcome("correctness", { operation: "nudge", state: "timed-out" }),
        nativeOutcome("maintainability"),
      ]),
    ).toThrow("native completion or confirmed release");
  });

  test("release evidence requires its final disposition", async () => {
    for (const releaseFailure of ["quarantined", "rejected"] as const) {
      let settle!: (outcome: Awaited<HarnessTurn["settled"]>) => void;
      const settled = new Promise<Awaited<HarnessTurn["settled"]>>((resolve) => {
        settle = resolve;
      });
      const turn: HarnessTurn = {
        settled,
        async deliver() {},
        async nudge() {
          return turn;
        },
        async release() {
          settle({
            state: "cancelled",
            resultEvidence: { kind: "unavailable" },
            chargesUsd: [],
          });
          await Promise.resolve();
          if (releaseFailure === "rejected") throw new Error("release failed");
          return { kind: "quarantined", reason: "release unresolved" };
        },
      };
      const evidence: Parameters<typeof observeTurn>[4] = [];
      const observed = observeTurn(turn, "turn", "reviewer:correctness", "claude", evidence);

      if (releaseFailure === "rejected") {
        await expect(
          observed.release("result accepted", { unixMilliseconds: Date.now() + 1_000 }),
        ).rejects.toThrow("release failed");
      } else {
        await observed.release("result accepted", {
          unixMilliseconds: Date.now() + 1_000,
        });
      }

      expect(evidence).toEqual([
        expect.objectContaining({
          settlement: "quarantined",
          state: "quarantined",
        }),
      ]);
      expect(() => assertNativeEvidence(evidence)).toThrow(
        "native completion or confirmed release",
      );
    }
  });
});
