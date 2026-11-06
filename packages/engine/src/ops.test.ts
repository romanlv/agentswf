import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DecisionArtifact, OpRecord } from "@agentswf/contract/records";
import { yesNo } from "@agentswf/contract/workflow";
import { createFakeAdapter } from "@agentswf/harness/testing";
import { createFakeDecisionProvider } from "./decisions/fake";
import type { DecisionInstallation } from "./decisions/seam";
import { listOps, OpIds } from "./ops";
import { readEvents } from "./runs";
import { createTempRunDirs, DOC, runAttempt, workflowOf } from "./testing";

const runDirs = createTempRunDirs();
afterAll(() => runDirs.cleanup());

const DECISIONS: DecisionInstallation = {
  providers: { fake: createFakeDecisionProvider() },
  aliases: { jev: { provider: "fake", model: "jev-1" } },
};

async function opOf(runDir: string, op: string): Promise<OpRecord> {
  return JSON.parse(await readFile(join(runDir, "ops", op, "op.json"), "utf8"));
}

describe("operation ids", () => {
  test("two attempts number each key's operations on from the last, and a decision keeps both files", async () => {
    const runRoot = runDirs.tempRunDir();
    const workflow = workflowOf(async (wf) => {
      const worker = await wf.agents.open({ key: "worker", runtime: "codex" });
      await wf.stage("work", async () => {
        await worker.run({ prompt: "First.", schema: DOC });
        await worker.compact({ prompt: "Keep the path." });
        await worker.run({ prompt: "Second.", schema: DOC });
      });
      const { record } = await wf.decisions.decide({
        key: "triage",
        model: "jev",
        state: "s",
        questions: { bug: yesNo("A bug?") },
      });
      return record.artifact;
    });
    const first = await runAttempt(workflow, { runRoot, decisions: DECISIONS });
    const second = await runAttempt(workflow, {
      runRoot,
      attempt: 2,
      fromStage: "work",
      decisions: DECISIONS,
    });
    expect([first.value, second.value]).toEqual([
      "ops/triage.1/decision.json",
      "ops/triage.2/decision.json",
    ]);
    const runDir = join(runRoot, "staged", "r1");
    expect((await readdir(join(runDir, "ops"))).sort()).toEqual([
      "triage.1",
      "triage.2",
      "worker.1",
      "worker.2",
      "worker.3",
      "worker.4",
      "worker.5",
      "worker.6",
    ]);
    expect(await opOf(runDir, "worker.2")).toEqual({
      id: "worker.2",
      kind: "compact",
      attempt: 1,
      at: expect.any(String),
      stage: "work",
      agent: "worker",
      // What its spend is read with, by the next attempt when this one never settles it.
      execution: expect.objectContaining({ harness: "codex" }),
      cwd: expect.any(String),
    });
    expect(await opOf(runDir, "worker.4")).toMatchObject({
      id: "worker.4",
      kind: "turn",
      attempt: 2,
      stage: "work",
      agent: "worker",
      question: "First.",
    });
    expect(await opOf(runDir, "triage.2")).toEqual({
      id: "triage.2",
      kind: "decision",
      attempt: 2,
      at: expect.any(String),
    });
    for (const [n, attempt] of [
      [1, 1],
      [2, 2],
    ] as const) {
      const artifact: DecisionArtifact = JSON.parse(
        await readFile(join(runDir, "ops", `triage.${n}`, "decision.json"), "utf8"),
      );
      expect(artifact.record.artifact).toBe(`ops/triage.${n}/decision.json`);
      expect(artifact.answers).toBeDefined();
      expect((await opOf(runDir, `triage.${n}`)).attempt).toBe(attempt);
    }
    // The log names each operation by the same id.
    const lines = await readEvents(runDir);
    expect(
      lines.flatMap((line) => (line.kind === "operation-started" ? [line.operationId] : [])),
    ).toEqual(["worker.1", "worker.2", "worker.3", "worker.4", "worker.5", "worker.6"]);
    expect(
      lines.flatMap((line) => (line.kind === "decision-asked" ? [line.operation] : [])),
    ).toEqual(["triage.1", "triage.2"]);
  });

  test("a turn that fails and a decision that fails each keep their op.json, and the next attempt numbers past them", async () => {
    const runRoot = runDirs.tempRunDir();
    const failing: DecisionInstallation = {
      providers: { fake: createFakeDecisionProvider([new Error("provider down")]) },
      aliases: { jev: { provider: "fake", model: "jev-1" } },
    };
    const workflow = workflowOf(async (wf) => {
      const worker = await wf.agents.open({ key: "worker", runtime: "codex" });
      const { outcome } = await worker.run({ prompt: "Fail.", schema: DOC, nudge: false });
      const decided = await wf.decisions
        .decide({ key: "triage", model: "jev", state: "s", questions: { bug: yesNo("A bug?") } })
        .then(
          () => "answered",
          () => "failed",
        );
      return `${outcome.kind} ${decided}`;
    });
    const first = await runAttempt(workflow, {
      runRoot,
      adapter: createFakeAdapter({
        harnesses: ["codex"],
        script: () => ({ state: "failed", detail: "harness crashed" }),
      }),
      decisions: failing,
    });
    expect(first.value).toBe("failed failed");
    const runDir = join(runRoot, "staged", "r1");
    expect(await opOf(runDir, "worker.1")).toMatchObject({
      id: "worker.1",
      attempt: 1,
      kind: "turn",
      agent: "worker",
      question: "Fail.",
      schema: expect.any(Object),
    });
    expect(await opOf(runDir, "triage.1")).toMatchObject({
      id: "triage.1",
      attempt: 1,
      kind: "decision",
    });
    await runAttempt(workflow, { runRoot, attempt: 2, decisions: DECISIONS });
    expect((await readdir(join(runDir, "ops"))).sort()).toEqual([
      "triage.1",
      "triage.2",
      "worker.1",
      "worker.2",
    ]);
  });

  test("a turn or a compaction whose op.json can't be written fails, naming why", async () => {
    const runRoot = runDirs.tempRunDir();
    const ops = join(runRoot, "staged", "r1", "ops");
    const result = await runAttempt(
      workflowOf(async (wf) => {
        // A file where each one's folder would go.
        await mkdir(ops, { recursive: true });
        await writeFile(join(ops, "worker.1"), "");
        await writeFile(join(ops, "keeper.1"), "");
        const worker = await wf.agents.open({ key: "worker", runtime: "codex" });
        const { outcome } = await worker.run({ prompt: "Go.", schema: DOC, nudge: false });
        const keeper = await wf.agents.open({ key: "keeper", runtime: "codex" });
        const compacted = await keeper.compact({ prompt: "Keep." }).then(
          () => "compacted",
          (error: unknown) => String(error),
        );
        return [outcome.kind, "reason" in outcome ? outcome.reason : "", compacted];
      }),
      { runRoot },
    );
    const [kind, reason, compacted] = result.value as string[];
    expect(kind).toBe("failed");
    expect(reason).toContain("op.json not written");
    expect(compacted).toContain("op.json not written");
  });

  test("an agent key that isn't a name is refused at open, naming the rule", async () => {
    for (const key of ["Reviewer", "fix tests", "a/b"]) {
      const runRoot = runDirs.tempRunDir();
      const refused = await runAttempt(
        workflowOf(async (wf) => {
          await wf.agents.open({ key, runtime: "codex" });
          return null;
        }),
        { runRoot },
      ).catch((error: unknown) => error);
      expect(String(refused)).toContain(
        `agent key ${key} is not a name: lowercase letters, digits, \`.\`, \`_\`, \`@\` and \`-\`, starting with a letter or digit`,
      );
    }
  });

  test("a decision key that isn't a name is refused when it is asked", async () => {
    const refused = await runAttempt(
      workflowOf(async (wf) => {
        await wf.decisions.decide({
          key: "Triage",
          model: "jev",
          state: "s",
          questions: { bug: yesNo("A bug?") },
        });
        return null;
      }),
      { runRoot: runDirs.tempRunDir(), decisions: DECISIONS },
    ).catch((error: unknown) => error);
    expect(String(refused)).toContain("decision key Triage is not a name: lowercase letters");
  });

  test("an agent keyed as an earlier attempt's decision is refused, and a decision keyed as an open agent", async () => {
    const runRoot = runDirs.tempRunDir();
    const decide = (wf: Parameters<Parameters<typeof workflowOf>[0]>[0]) =>
      wf.decisions.decide({
        key: "triage",
        model: "jev",
        state: "s",
        questions: { bug: yesNo("A bug?") },
      });
    await runAttempt(
      workflowOf(async (wf) => {
        await decide(wf);
        return null;
      }),
      { runRoot, decisions: DECISIONS },
    );
    const agent = await runAttempt(
      workflowOf(async (wf) => {
        await wf.agents.open({ key: "triage", runtime: "codex" });
        return null;
      }),
      { runRoot, attempt: 2, decisions: DECISIONS },
    ).catch((error: unknown) => error);
    expect(String(agent)).toContain(
      "triage is a decision's key: agents and decisions share one set of names, as each operation's folder is ops/{key}.{n}; an agent takes another key",
    );
    const decision = await runAttempt(
      workflowOf(async (wf) => {
        await wf.agents.open({ key: "reviewer", runtime: "codex" });
        await wf.decisions.decide({
          key: "reviewer",
          model: "jev",
          state: "s",
          questions: { bug: yesNo("A bug?") },
        });
        return null;
      }),
      { runRoot: runDirs.tempRunDir(), decisions: DECISIONS },
    ).catch((error: unknown) => error);
    expect(String(decision)).toContain("reviewer is an agent's key: agents and decisions share");
  });

  test("a key with a colon is refused, for a decision and an agent, naming the key to take", async () => {
    const refused = (work: Parameters<typeof workflowOf>[0]) =>
      runAttempt(workflowOf(work), {
        runRoot: runDirs.tempRunDir(),
        decisions: DECISIONS,
      }).catch((error: unknown) => String(error));
    expect(
      await refused(async (wf) => {
        await wf.decisions.decide({
          key: "triage:42",
          model: "jev",
          state: "s",
          questions: { bug: yesNo("A bug?") },
        });
        return null;
      }),
    ).toContain("take another key, such as triage-42");
    expect(
      await refused(async (wf) => {
        await wf.agents.open({ key: "triage:43", runtime: "codex" });
        return null;
      }),
    ).toContain("an agent takes another key, such as triage-43");
  });
});

describe("listOps", () => {
  test("takes each key's last n from the digits after its folder's last dot, and whose it is from op.json", async () => {
    const runDir = runDirs.tempRunDir();
    expect(await listOps(runDir)).toEqual(new Map());
    const op = async (id: string, kind?: OpRecord["kind"]) => {
      await mkdir(join(runDir, "ops", id), { recursive: true });
      if (kind) await writeFile(join(runDir, "ops", id, "op.json"), JSON.stringify({ id, kind }));
    };
    await op("worker.1", "turn");
    await op("worker.10", "compact");
    await op("worker.9", "turn");
    await op("v1.2.3", "decision");
    await op("crashed.4");
    await op("judge.1", "decision");
    await op("judge.2");
    await op("not-an-op");
    expect(await listOps(runDir)).toEqual(
      new Map<string, { last: number; of?: "agent" | "decision" }>([
        ["worker", { last: 10, of: "agent" }],
        ["v1.2", { last: 3, of: "decision" }],
        ["crashed", { last: 4 }],
        // Its last folder has no op.json: the one below it says whose it is.
        ["judge", { last: 2, of: "decision" }],
      ]),
    );
    const ids = new OpIds(runDir, 2, await listOps(runDir));
    const where = { agent: "worker", execution: { harness: "codex", model: "m" }, cwd: "/w" };
    expect(ids.draw("worker", { kind: "compact", ...where })).toEqual({ id: "worker.11" });
    expect(await opOf(runDir, "worker.11")).toEqual({
      id: "worker.11",
      attempt: 2,
      at: expect.any(String),
      kind: "compact",
      ...where,
    });
    expect(ids.draw("fresh", { kind: "decision" }).id).toBe("fresh.1");
    // Whose a key is is unknown without its op.json: either may take it.
    expect(() => ids.claim("crashed", "decision")).not.toThrow();
    expect(() => ids.claim("v1.2", "agent")).toThrow("v1.2 is a decision's key");
  });

  test("a draw whose op.json can't be written says why, and still numbers on", async () => {
    const runDir = runDirs.tempRunDir();
    await writeFile(join(runDir, "ops"), "not a folder");
    const ids = new OpIds(runDir, 1, new Map());
    const drawn = ids.draw("a", { kind: "decision" });
    expect(drawn).toMatchObject({
      id: "a.1",
      lost: expect.stringContaining("op.json not written"),
    });
    expect(ids.draw("a", { kind: "decision" }).id).toBe("a.2");
  });
});
