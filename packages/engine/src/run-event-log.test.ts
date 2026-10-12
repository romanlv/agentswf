import { afterAll, describe, expect, test } from "bun:test";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunEvent, RunLogLine, TurnRecord } from "@agentswf/contract/records";
import type { WorkflowContext } from "@agentswf/contract/workflow";
import { createSingleSessionHostFactory } from "@agentswf/harness";
import { createFakeAdapter, createFakeCallingSession } from "@agentswf/harness/testing";
import { createFakeDecisionProvider } from "./decisions/fake";
import { OPERATOR_ALIASES } from "./operator-aliases";
import { createRun, openRun, readEvents, readTurns } from "./runs";
import { createTempRunDirs, DOC, future, runAttempt, submit, workflowOf } from "./testing";
import { runWorkflow } from "./workflow-runner";

const runDirs = createTempRunDirs();
afterAll(() => runDirs.cleanup());

/** Answers every turn with a `DOC`, and forks. */
function forking() {
  return createFakeAdapter({
    harnesses: ["codex"],
    continues: true,
    forks: () => true,
    script: (context) =>
      context.kind === "compact"
        ? { summary: "kept" }
        : { act: () => submit(context.binding!, { path: "x" }).then(() => undefined) },
  });
}

async function ask(agent: Awaited<ReturnType<WorkflowContext["agents"]["open"]>>) {
  const { outcome } = await agent.run({ prompt: "Do.", schema: DOC });
  return outcome.kind;
}

function isEvent(line: RunLogLine): line is RunEvent {
  return line.kind !== "turn" && line.kind !== "compact";
}

describe("the run's event log", () => {
  test("holds the attempt's stages, operations, agents, lines and decisions, keyed", async () => {
    const runRoot = runDirs.tempRunDir();
    const workflow = workflowOf(async (context) => {
      context.log("starting", { n: 1 });
      await context.stage("plan", { result: DOC }, async () => {
        const worker = await context.agents.open({ key: "worker", runtime: "codex" });
        await worker.compact({ prompt: "Keep the plan." });
        await ask(worker);
        const tests = await worker.fork({ key: "tests" });
        await ask(tests);
        await context.decisions.decide({
          key: "bug",
          model: "jev",
          state: "Checkout charges twice",
          questions: { bug: { type: "yes-no", instructions: "Is it a bug?" } },
        });
        return { path: "plan" };
      });
      return null;
    });
    const run = await createRun(runRoot, {
      id: "r1",
      workflow: "staged",
      argv: [],
      cwd: process.cwd(),
      sandbox: null,
    });
    await runWorkflow(workflow, null, {
      runRoot,
      run: { dir: run.dir, id: "r1", attempt: 1 },
      runtime: { aliases: OPERATOR_ALIASES, host: createSingleSessionHostFactory(forking()) },
      decisions: {
        providers: { fake: createFakeDecisionProvider() },
        aliases: { jev: { provider: "fake", model: "jev" } },
      },
      deadline: future(),
    });

    const lines = await readEvents(run.dir);
    expect(lines.every((line) => line.attempt === 1)).toBe(true);
    const shape = lines.map((line) => {
      const stage = "stage" in line ? line.stage : undefined;
      const agent = "agent" in line ? line.agent : undefined;
      const of = "of" in line ? line.of : undefined;
      return [line.kind, stage, agent, of].filter((part) => part !== undefined).join(" ");
    });
    expect(shape).toEqual([
      "log",
      "stage-started plan",
      "agent-opened worker",
      "operation-started plan worker compact",
      "compact plan worker",
      "operation-started plan worker turn",
      "turn plan worker",
      "agent-forked tests",
      "agent-opened tests",
      "session-known tests",
      "operation-started plan tests turn",
      "turn plan tests",
      "decision-asked plan",
      "decision-ended plan",
      "stage-ended plan",
      "agent-stopped worker",
      "agent-stopped tests",
    ]);

    const events = lines.filter(isEvent);
    expect(events.find((event) => event.kind === "log")).toMatchObject({
      text: "starting",
      fields: { n: 1 },
    });
    // A start and its end carry the same key, and a fork names the operation it was copied after.
    const turns = lines.filter((line): line is TurnRecord => !isEvent(line));
    const started = events.flatMap((event) =>
      event.kind === "operation-started" ? [event.operationId] : [],
    );
    expect(turns.map((turn) => turn.operationId)).toEqual(started);
    expect(turns.every((turn) => turn.callPath?.length === 0)).toBe(true);
    const fork = events.find((event) => event.kind === "agent-forked");
    expect(fork).toMatchObject({ from: "worker", after: turns[1]!.operationId });
    expect(events.find((event) => event.kind === "agent-opened")).toMatchObject({
      harness: "codex",
      callPath: [],
      cwd: process.cwd(),
    });
    expect(events.filter((event) => event.kind.startsWith("decision-"))).toMatchObject([
      { decision: 1, key: "bug", alias: "jev", provider: "fake", model: "jev" },
      { decision: 1, outcome: "answered" },
    ]);
    expect(await readTurns(run.dir)).toEqual(turns);
  });

  test("a turn that throws before it is delivered is written as failed, with no start", async () => {
    const runRoot = runDirs.tempRunDir();
    const dir = join(runRoot, "staged", "r1");
    await runAttempt(
      workflowOf(async (context) => {
        const worker = await context.agents.open({ key: "worker", runtime: "codex" });
        await worker
          .run({ prompt: "Do.", schema: { type: "no-such-type" } as never })
          .catch(() => undefined);
        return null;
      }),
      { runRoot },
    );
    const operations = (await readEvents(dir)).filter((line) => line.kind.startsWith("operation"));
    expect(operations).toMatchObject([
      { kind: "operation-failed", of: "turn", agent: "worker", callPath: [] },
    ]);
    expect(operations[0]).not.toHaveProperty("deliveredAt");
  });

  test("a stage reused or provided writes only its end, and a workflow's warning is its own kind", async () => {
    const runRoot = runDirs.tempRunDir();
    const dir = join(runRoot, "staged", "r1");
    const workflow = workflowOf(async (context) => {
      await context.stage("plan", { result: DOC }, async () => ({ path: "plan" }));
      await context.stage(
        "review",
        {
          result: DOC,
          summary: () => {
            throw new Error("bad summary");
          },
        },
        async () => ({ path: "review" }),
      );
      return null;
    });
    await runAttempt(workflow, { runRoot });
    await runAttempt(workflow, { runRoot, attempt: 2, fromStage: "review" });
    const second = (await readEvents(dir)).filter((line) => line.attempt === 2);
    expect(second.map((line) => [line.kind, "stage" in line ? line.stage : undefined])).toEqual([
      ["stage-ended", "plan"],
      ["stage-started", "review"],
      ["warning", "review"],
      ["stage-ended", "review"],
    ]);
    expect(second[0]).toMatchObject({ outcome: "succeeded", source: "reused" });

    const provided = runDirs.tempRunDir();
    await runAttempt(workflow, {
      runRoot: provided,
      fromStage: "review",
      values: { plan: { path: "given" } },
    });
    expect((await readEvents(join(provided, "staged", "r1")))[0]).toMatchObject({
      kind: "stage-ended",
      stage: "plan",
      source: "provided",
    });
  });

  test("parallel agents' operations keep their own keys", async () => {
    const runRoot = runDirs.tempRunDir();
    await runAttempt(
      workflowOf(async (context) => {
        await context.parallel(["a", "b"], async (key) => {
          const agent = await context.agents.open({ key, runtime: "codex" });
          return ask(agent);
        });
        return null;
      }),
      { runRoot },
    );
    const lines = await readEvents(join(runRoot, "staged", "r1"));
    const byAgent = (kind: string, agent: string) =>
      lines.flatMap((line) =>
        line.kind === kind && "agent" in line && line.agent === agent && "operationId" in line
          ? [line.operationId]
          : [],
      );
    for (const agent of ["a", "b"]) {
      expect(byAgent("operation-started", agent)).toEqual(byAgent("turn", agent));
      expect(byAgent("turn", agent)).toHaveLength(1);
    }
    expect(byAgent("turn", "a")).not.toEqual(byAgent("turn", "b"));
  });

  test("a fork of a calling session the run never opened comes from no agent, after nothing", async () => {
    const runRoot = runDirs.tempRunDir();
    const adapter = createFakeAdapter({
      continues: true,
      script: (context) => ({
        act: () => submit(context.binding!, { path: "x" }).then(() => undefined),
      }),
    });
    const run = await createRun(runRoot, {
      id: "r1",
      workflow: "staged",
      argv: [],
      cwd: process.cwd(),
      sandbox: null,
    });
    await runWorkflow(
      workflowOf(async (context) => {
        const fixer = await context.agents.forkCaller({ key: "fixer" });
        await ask(fixer!);
        return null;
      }),
      null,
      {
        runRoot,
        run: { dir: run.dir, id: "r1", attempt: 1 },
        runtime: {
          aliases: { review: { harness: "fake", model: "fake" } },
          host: {
            ...createSingleSessionHostFactory(adapter),
            calling: createFakeCallingSession({
              harness: "fake",
              cwd: "/repo",
              model: "model-a",
              session: "s-main",
            }),
          },
        },
        deadline: future(),
      },
    );
    const lines = (await readEvents(run.dir)).filter(isEvent);
    expect(lines.find((line) => line.kind === "agent-forked")).toMatchObject({
      agent: "fixer",
      from: null,
      after: null,
    });
    expect(lines.find((line) => line.kind === "agent-opened")).not.toHaveProperty("caller");
  });

  test("the calling session opened as an agent says so, and a fork of it comes from that agent", async () => {
    const runRoot = runDirs.tempRunDir();
    const calling = createFakeCallingSession({
      harness: "fake",
      cwd: "/repo",
      model: "model-a",
      session: "s-main",
    });
    // The calling session's own fork, as a handed-over session is forked.
    const adapter = createFakeAdapter({
      continues: true,
      found: calling,
      script: (context) => ({
        act: () => submit(context.binding!, { path: "x" }).then(() => undefined),
      }),
    });
    const run = await createRun(runRoot, {
      id: "r1",
      workflow: "staged",
      argv: [],
      cwd: process.cwd(),
      sandbox: null,
    });
    await runWorkflow(
      workflowOf(async (context) => {
        await ask((await context.agents.caller({ key: "author" }))!);
        await ask((await context.agents.forkCaller({ key: "fixer" }))!);
        return null;
      }),
      null,
      {
        runRoot,
        run: { dir: run.dir, id: "r1", attempt: 1 },
        runtime: {
          aliases: { review: { harness: "fake", model: "fake" } },
          host: {
            ...createSingleSessionHostFactory(adapter),
            caller: { harness: "fake", cwd: "/repo" },
            calling,
          },
        },
        deadline: future(),
      },
    );
    const lines = (await readEvents(run.dir)).filter(isEvent);
    expect(lines.find((line) => line.kind === "agent-opened")).toMatchObject({
      agent: "author",
      caller: true,
      cwd: "/repo",
    });
    const forked = lines.find((line) => line.kind === "agent-forked");
    expect(forked).toMatchObject({ agent: "fixer", from: "author" });
    expect(forked).toHaveProperty("after", expect.any(String));
  });

  test("a session named while its turn runs is known before the turn ends", async () => {
    const runRoot = runDirs.tempRunDir();
    const adapter = createFakeAdapter({
      harnesses: ["codex"],
      script: (context) => ({
        sessionRef: "thread-9",
        act: async () => {
          // Once the answer is in, the turn has surely been delivered.
          await submit(context.binding!, { path: "x" });
          context.nameSession("thread-9");
        },
      }),
    });
    await runAttempt(
      workflowOf(async (context) => {
        await ask(await context.agents.open({ key: "worker", runtime: "codex" }));
        return null;
      }),
      { runRoot, adapter },
    );
    // On the operation's start when it is delivered by then, or on a line of its own after.
    const lines = await readEvents(join(runRoot, "staged", "r1"));
    const turn = lines.findIndex((line) => line.kind === "turn");
    const named = lines
      .slice(0, turn)
      .flatMap((line) =>
        line.kind === "operation-started"
          ? line.sessions.map(({ id }) => id)
          : line.kind === "session-known"
            ? [line.session.id]
            : [],
      );
    expect(named).toEqual(["thread-9"]);
    const started = lines.find((line) => line.kind === "operation-started");
    expect(lines.find((line) => line.kind === "session-known")).toMatchObject({
      operationId: started && "operationId" in started ? started.operationId : "none",
    });
  });

  test("a write that fails is said on stderr only, once for events and for each turn", async () => {
    const runRoot = runDirs.tempRunDir();
    const run = await createRun(runRoot, {
      id: "r1",
      workflow: "staged",
      argv: [],
      cwd: process.cwd(),
      sandbox: null,
    });
    // An append to a directory fails.
    await mkdir(join(run.dir, "turns.jsonl"));
    const said: string[] = [];
    await runWorkflow(
      workflowOf(async (context) => {
        context.log("one");
        context.log("two");
        const worker = await context.agents.open({ key: "worker", runtime: "codex" });
        await ask(worker);
        await ask(worker);
        return null;
      }),
      null,
      {
        runRoot,
        run: { dir: run.dir, id: "r1", attempt: 1 },
        runtime: { aliases: OPERATOR_ALIASES, host: createSingleSessionHostFactory(forking()) },
        deadline: future(),
        onLog: (message) => said.push(message),
      },
    );
    expect(said.filter((line) => line.startsWith("awf: the run's event log"))).toHaveLength(1);
    expect(said.filter((line) => line.startsWith("awf: a turn was not recorded"))).toHaveLength(2);
    expect(said.filter((line) => !line.startsWith("awf:"))).toEqual(["one", "two"]);
  });
});

describe("reading the log", () => {
  test("a turn line written before turns had a kind reads as a turn", async () => {
    const runRoot = runDirs.tempRunDir();
    const run = await createRun(runRoot, {
      id: "r1",
      workflow: "staged",
      argv: [],
      cwd: process.cwd(),
      sandbox: null,
    });
    const line = {
      version: 1,
      attempt: 1,
      agent: "w",
      stage: "qa",
      outcome: "answered",
      sessions: [],
    };
    await writeFile(join(run.dir, "turns.jsonl"), `${JSON.stringify(line)}\n`);
    expect(await readTurns(run.dir)).toEqual([{ kind: "turn", ...line } as never]);
  });
  test("skips a kind or version it does not know and a line that does not parse", async () => {
    const runRoot = runDirs.tempRunDir();
    await runAttempt(
      workflowOf(async (context) => {
        const worker = await context.agents.open({ key: "worker", runtime: "codex" });
        await ask(worker);
        return null;
      }),
      { runRoot },
    );
    const dir = join(runRoot, "staged", "r1");
    const before = await readEvents(dir);
    await appendFile(
      join(dir, "turns.jsonl"),
      [
        JSON.stringify({ version: 1, attempt: 1, kind: "from-a-later-awf", at: "" }),
        JSON.stringify({ version: 9, attempt: 1, kind: "stage-started", at: "", stage: "x" }),
        JSON.stringify({ version: 2, attempt: 1, kind: "turn" }),
        "not json",
        "",
      ].join("\n"),
    );
    expect(await readEvents(dir)).toEqual(before);
  });

  test("a log written before the event log reads the same through readTurns", async () => {
    const runRoot = runDirs.tempRunDir();
    const run = await createRun(runRoot, {
      id: "r1",
      workflow: "staged",
      argv: [],
      cwd: process.cwd(),
      sandbox: null,
    });
    const old = {
      version: 1,
      attempt: 1,
      kind: "turn",
      outcome: "answered",
      agent: "worker",
      operationId: "op-1",
      execution: { harness: "codex", model: "m" },
      stage: "plan",
      deliveredAt: "2026-10-01T00:00:00.000Z",
      settledAt: "2026-10-01T00:01:00.000Z",
      sessions: [{ harness: "codex", id: "s" }],
    };
    await writeFile(join(run.dir, "turns.jsonl"), `${JSON.stringify(old)}\n`);
    expect(await readTurns((await openRun(runRoot, "staged", "r1")).dir)).toEqual([old as never]);
  });

  test("an attempt's first line after a torn one starts a line of its own", async () => {
    const runRoot = runDirs.tempRunDir();
    const workflow = workflowOf(async (context) => {
      await context.stage("plan", { result: DOC }, async () => ({ path: "plan" }));
      return null;
    });
    await runAttempt(workflow, { runRoot });
    const file = join(runRoot, "staged", "r1", "turns.jsonl");
    await appendFile(file, '{"version":1,"attempt":1,"ki');
    await runAttempt(workflow, { runRoot, attempt: 2, fromStage: "plan" });
    const text = await readFile(file, "utf8");
    expect(text.split("\n").filter((line) => line.includes('"attempt":2'))).toHaveLength(2);
    expect(
      (await readEvents(join(runRoot, "staged", "r1"))).filter((line) => line.attempt === 2),
    ).toHaveLength(2);
  });
});
