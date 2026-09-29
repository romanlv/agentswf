import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Fixture } from "../packages/autoresearch/src/review/format/format";
import type { FindingLabel, Judgement } from "../packages/autoresearch/src/review/format/scoring";
import {
  EXAMPLE_FINDINGS,
  EXAMPLE_KEY,
  EXAMPLE_LABELS,
} from "../packages/autoresearch/src/review/format/testing";
import judgeWorkflow, {
  panelJudge,
} from "../packages/autoresearch/src/review/judge/judge.workflow";
import { runWorkflow } from "../packages/engine/src";
import { createTempRunDirs, future, submit } from "../packages/engine/src/testing";
import type { AgentRuntimeConfig } from "../packages/harness/src/adapter";
import { createSingleSessionHostFactory } from "../packages/harness/src/single-session-host";
import {
  createFakeAdapter,
  type FakeAdapterTurnContext,
} from "../packages/harness/src/testing/fake";

const runDirs = createTempRunDirs();
const scratch = mkdtempSync(join(tmpdir(), "awf-judge-test-"));
afterAll(() => {
  runDirs.cleanup();
  rmSync(scratch, { recursive: true, force: true });
});

const SHA = "b".repeat(40);
const FIXTURE: Fixture = {
  format: "awf.review-fixture/1",
  id: "app-1",
  source: {
    forge: "gitlab",
    project: "group/app",
    number: 1,
    url: "https://gitlab.example/group/app/-/merge_requests/1",
    state: "merged",
  },
  snapshot: { version: 1, base: SHA, head: SHA, at: "2026-06-01T00:00:00Z" },
  request: { asOf: "2026-06-01T00:00:00Z", removed: [] },
};

/** A fixture folder and a findings file, as awf-lab hands them to a judge. */
async function fixtureWith(findings: unknown): Promise<{ fixture: string; findings: string }> {
  const dir = mkdtempSync(join(scratch, "fixture-"));
  mkdirSync(join(dir, "key"));
  await Bun.write(join(dir, "fixture.json"), JSON.stringify(FIXTURE));
  await Bun.write(join(dir, "request.md"), "# Add retries\n\nRetry failed uploads.\n");
  await Bun.write(join(dir, "key", "key.json"), JSON.stringify(EXAMPLE_KEY));
  await Bun.write(join(dir, "findings.json"), JSON.stringify(findings));
  return { fixture: dir, findings: join(dir, "findings.json") };
}

type Answer = { labels: FindingLabel[]; missed: string };
/** What each agent answers on its nth ask, by the start of its key: `judge1`, `judge2`, `tiebreak`. */
type Script = Record<string, (Answer | "silent")[]>;

function panel(script: Script) {
  const adapter = createFakeAdapter({
    harnesses: ["claude", "codex"],
    script: (context: FakeAdapterTurnContext) => ({
      act: async () => {
        const who = context.activation.key.split(":")[0]!;
        const answer = script[who]?.[context.turn - 1];
        if (answer && answer !== "silent") await submit(context.binding!, answer);
      },
    }),
  });
  const runtime: AgentRuntimeConfig = {
    aliases: {},
    host: createSingleSessionHostFactory(adapter),
  };
  return { adapter, runtime };
}

async function judge(script: Script, findings: unknown = EXAMPLE_FINDINGS) {
  const files = await fixtureWith(findings);
  const { adapter, runtime } = panel(script);
  const args = judgeWorkflow.prepare({
    argv: ["--fixture", files.fixture, "--findings", files.findings],
    cwd: scratch,
  });
  const run = runWorkflow(panelJudge, args, {
    runRoot: runDirs.tempRunDir(),
    runtime,
    deadline: future(),
    cwd: scratch,
  });
  return { run, adapter };
}

const agree: Answer = { labels: EXAMPLE_LABELS, missed: "K3" };
const relabel = (index: number, label: FindingLabel): Answer => ({
  labels: EXAMPLE_LABELS.map((l, i) => (i === index ? label : l)),
  missed: "K3",
});
const read = [{ path: "src/app.ts", start: 1, end: 2 }];
const wrongAt5: FindingLabel = { finding: 5, label: "wrong", refutes: "r", why: "w", read };
const noiseAt5 = EXAMPLE_LABELS[5]!;
const keys = (adapter: { turns: FakeAdapterTurnContext[] }) =>
  adapter.turns.map((turn) => turn.activation.key.split(":")[0]).sort();

describe("the panel judge", () => {
  test("agreeing judges give their labels, with both votes and no tiebreak", async () => {
    const { run, adapter } = await judge({ judge1: [agree], judge2: [agree] });
    const { value } = await run;
    expect(value.labels).toEqual(EXAMPLE_LABELS);
    expect(value.votes?.map((vote) => [vote.by, vote.role])).toEqual([
      ["judge1:codex/gpt-6-sol", "panel"],
      ["judge2:claude/claude-sonnet-5", "panel"],
    ]);
    expect(keys(adapter)).toEqual(["judge1", "judge2"]);
    expect(adapter.activations.map((a) => a.cwd)).toEqual([scratch, scratch]);
  });

  test("a disagreement calls the tiebreak for those findings only, and it settles them", async () => {
    const { run, adapter } = await judge({
      judge1: [agree],
      judge2: [relabel(5, wrongAt5)],
      tiebreak: [{ labels: [noiseAt5], missed: "" }],
    });
    const { value } = await run;
    expect(value.labels).toEqual(EXAMPLE_LABELS);
    expect(value.votes?.at(-1)).toEqual({
      by: "tiebreak:codex/gpt-6-luna",
      role: "tiebreak",
      labels: [noiseAt5],
    });
    const asked = adapter.turns.find((turn) => turn.activation.key.startsWith("tiebreak"))!;
    expect(asked.prompt).toContain("agree on all but findings 5.");
    expect(asked.prompt).toContain("K1 by finding 0");
  });

  test("a tiebreak siding with neither leaves the finding unsettled", async () => {
    const { run } = await judge({
      judge1: [agree],
      judge2: [relabel(5, wrongAt5)],
      tiebreak: [
        {
          labels: [
            {
              finding: 5,
              label: "new",
              severity: "nit",
              category: "slop",
              scope: "change",
              mechanism: "m",
              why: "w",
              read,
            },
          ],
          missed: "",
        },
      ],
    });
    const { value } = await run;
    expect(value.labels[5]).toMatchObject({ finding: 5, label: "unsettled" });
    expect(value.labels[5]).not.toHaveProperty("excluded");
    expect((value.labels[5] as { why: string }).why).toBe(
      "the judges split: judge1:codex/gpt-6-sol noise, judge2:claude/claude-sonnet-5 wrong, tiebreak:codex/gpt-6-luna new",
    );
  });

  test("a bad answer is handed back once with what is wrong", async () => {
    const bad = relabel(0, { finding: 0, label: "hit", issue: "K9", why: "w", read });
    const { run, adapter } = await judge({ judge1: [bad, agree], judge2: [agree] });
    const { value } = await run;
    expect(value.labels).toEqual(EXAMPLE_LABELS);
    const retry = adapter.turns.filter((turn) => turn.activation.key.startsWith("judge1"));
    expect(retry).toHaveLength(2);
    expect(retry[1]!.prompt).toContain("/labels/0: K9 is not an issue in the key");
  });

  test("a judge that fails again withholds its vote, which fails the judging", async () => {
    const bad = relabel(0, { finding: 0, label: "hit", issue: "K9", why: "w", read });
    const { run, adapter } = await judge({ judge1: [bad, bad], judge2: [agree] });
    await expect(run).rejects.toThrow("a judge withheld its vote: judge1:codex/gpt-6-sol:");
    expect(keys(adapter)).toEqual(["judge1", "judge1", "judge2"]);
  });

  test("a judge that doesn't answer is asked once more, then fails the judging", async () => {
    const { run, adapter } = await judge({
      judge1: ["silent", agree],
      judge2: ["silent", "silent"],
    });
    await expect(run).rejects.toThrow("judge2:claude/claude-sonnet-5: unanswered");
    expect(keys(adapter)).toEqual(["judge1", "judge1", "judge2", "judge2"]);
  });

  test("a voter's bare unsettled is sent back: only the panel's split is unsettled without a claim", async () => {
    const dodge = relabel(5, { finding: 5, label: "unsettled", why: "hard", read: [] });
    const { run, adapter } = await judge({ judge1: [dodge, agree], judge2: [agree] });
    const { value } = await run;
    expect(value.labels).toEqual(EXAMPLE_LABELS);
    const retry = adapter.turns.filter((turn) => turn.activation.key.startsWith("judge1"))[1]!;
    expect(retry.prompt).toContain(
      "/labels/5: an unsettled finding names the unconfirmed claim it repeats, in excluded",
    );
  });

  test("a tiebreak hitting an issue the agreed findings hit is sent back, then leaves it unsettled", async () => {
    const claims = {
      labels: [{ finding: 5, label: "hit", issue: "K1", why: "w", read }],
      missed: "",
    };
    const { run, adapter } = await judge({
      judge1: [agree],
      judge2: [relabel(5, wrongAt5)],
      tiebreak: [claims as Answer, claims as Answer],
    });
    const { value } = await run;
    expect(value.labels[5]).toMatchObject({ label: "unsettled" });
    expect(value.votes).toHaveLength(2);
    const retry = adapter.turns.filter((turn) => turn.activation.key.startsWith("tiebreak"))[1]!;
    expect(retry.prompt).toContain(
      "/labels/0: K1 is already hit by finding 0; this one is a duplicate",
    );
  });

  test("both judges failing fails the run", async () => {
    const { run, adapter } = await judge({
      judge1: ["silent", "silent"],
      judge2: ["silent", "silent"],
    });
    await expect(run).rejects.toThrow("a judge withheld its vote");
    expect(adapter.turns).toHaveLength(4);
  });

  test("a review with no findings is judged without asking anyone", async () => {
    const { run, adapter } = await judge({}, []);
    const { value } = await run;
    expect(value).toEqual({
      format: "awf.review-judgement/1",
      labels: [],
      missed: "The review found nothing.",
    } satisfies Judgement);
    expect(adapter.turns).toHaveLength(0);
  });

  test("its arguments: the fixture and findings are required, and the panel is two judges", () => {
    const prepare = (argv: string[]) => judgeWorkflow.prepare({ argv, cwd: "/work" });
    expect(() => prepare(["--findings", "f.json"])).toThrow("--fixture is required");
    expect(() =>
      prepare(["--fixture", "d", "--findings", "f", "--panel", "codex/gpt-6-sol"]),
    ).toThrow("--panel names two judges");
    expect(
      prepare([
        "--panel",
        "claude/a,codex/b",
        "--tiebreak",
        "codex/c",
        "--fixture",
        "d",
        "--findings",
        "f",
      ]),
    ).toMatchObject({
      cwd: "/work",
      fixture: "/work/d",
      findings: "/work/f",
      panel: [
        { harness: "claude", model: "a", placement: "headless", metered: true },
        { harness: "codex", model: "b", placement: "headless" },
      ],
      tiebreak: { harness: "codex", model: "c" },
    });
  });
});
