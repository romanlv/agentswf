import { afterAll, expect, test } from "bun:test";
import { MAILBOX_RECORD_VERSION } from "@agentswf/contract/records";
import {
  defineExecutableWorkflow,
  defineWorkflow,
  isAnswered,
  type JsonValue,
} from "@agentswf/contract/workflow";
import { createSingleSessionHostFactory } from "@agentswf/harness";
import { DEPRECATIONS, type Deprecated, deprecationLine } from "./deprecations";
import { appendMailbox } from "./mailbox";
import { OPERATOR_ALIASES } from "./operator-aliases";
import { createRun } from "./runs";
import { answering, caseRun, createTempRunDirs, future, startCase } from "./testing";
import { runWorkflow } from "./workflow-runner";
import { answer, noAnswer, reply, type TestRun, testWorkflow } from "./workflow-testing";

const runDirs = createTempRunDirs();
afterAll(() => runDirs.cleanup());

/** How often the run logged each deprecated name's line. */
function said(run: TestRun<JsonValue>): Partial<Record<Deprecated, number>> {
  const counts: Partial<Record<Deprecated, number>> = {};
  for (const name of Object.keys(DEPRECATIONS) as Deprecated[]) {
    const { old } = DEPRECATIONS[name];
    const n = run.logs.filter(
      (log) => log.message === deprecationLine(name) || log.message.startsWith(`awf: ${old}, `),
    ).length;
    if (n > 0) counts[name] = n;
  }
  return counts;
}

test("a plain run logs each deprecated name it uses once, naming its replacement", async () => {
  const run = await testWorkflow(
    defineWorkflow({
      meta: { name: "old-forms", description: "Every old form.", whenToUse: "Never." },
      async run(wf) {
        const agent = await wf.agents.open({ key: "a", runtime: "claude", labels: { x: 1 } });
        await wf.agents.open({ key: "a", runtime: "claude", labels: { x: 1 } });
        const first = await agent.run({ id: "t1", prompt: "One." });
        await agent.fork({ key: "b", labels: { y: 2 } });
        await agent.run({ id: "t2", prompt: "Two." });
        await agent.compact({ id: "c1", prompt: "Keep it." });
        await agent.set({ id: "s1", effort: "high" });
        return [isAnswered(first.outcome), isAnswered(first.outcome)];
      },
    }),
    null,
    { agents: { a: answer("yes") } },
  );
  expect(run.value).toEqual([true, true]);
  expect(said(run)).toEqual({ whenToUse: 1, labels: 1, "call-id": 1, isAnswered: 1 });
  expect(run.logs.map((log) => log.message)).toContain(
    "awf: isAnswered(outcome) is deprecated; check outcome.answered",
  );
});

test("defineExecutableWorkflow's workflow runs, and its run says so once", async () => {
  const run = await testWorkflow(
    defineExecutableWorkflow({
      definition: {
        meta: { name: "nested", description: "beta.2's shape." },
        run: async () => "ran",
      },
    }),
    null,
  );
  expect(run.value).toBe("ran");
  expect(said(run)).toEqual({ defineExecutableWorkflow: 1 });
});

test("a turn in a race, a turn's is(), a stage around receive and start's id each log once", async () => {
  const run = await testWorkflow(
    caseRun(async (wf) => {
      await wf.stage("first", () => wf.receive());
      const fixer = await wf.agents.open({ key: "fixer", runtime: "claude" });
      const turn = await fixer.start({ id: "fix-1", prompt: "Fix it." });
      const won = await wf.race("fix-or-quiet", { fixed: turn, quiet: "1d" });
      const ended = turn.is({ name: "agent:ended", from: "fixer", data: won.fixed });
      await fixer.start({ prompt: "Again." });
      const again = await wf.race("again", { fixed: fixer, quiet: "1d" });
      // An outcome taken at a wait reports as one awaited does.
      return [ended, again.fixed ? isAnswered(again.fixed.outcome) : false];
    }),
    { ...startCase, agents: { fixer: answer("fixed") } },
  );
  expect(run.value).toEqual([true, true]);
  expect(said(run)).toEqual({
    "stage-receive": 1,
    "call-id": 1,
    "turn-source": 1,
    "turn-is": 1,
    isAnswered: 1,
  });
});

test("the new forms log nothing, and a wait's label may be a function", async () => {
  const labels: string[] = [];
  const run = await testWorkflow(
    caseRun(async (wf) => {
      await wf.receive({ label: () => "first" });
      const fixer = await wf.agents.open({ key: "fixer", runtime: "claude" });
      await fixer.start({ prompt: "Fix it." });
      const won = await wf.race(
        "fix",
        { fixed: fixer },
        {
          label: () => {
            labels.push("asked");
            return "fixing";
          },
        },
      );
      return won.fixed ? won.fixed.outcome.answered : false;
    }),
    { ...startCase, agents: { fixer: answer("fixed") } },
  );
  expect(run.value).toBe(true);
  expect(labels).toEqual(["asked"]);
  expect(said(run)).toEqual({});
});

test("receive refuses take: oldest, which select does, and takes the old default, all", async () => {
  const run = await testWorkflow(
    caseRun(async (wf) => {
      const refused = await wf.receive({ take: "oldest" } as never).then(
        () => "taken",
        (error: Error) => error.message,
      );
      const taken = await wf.receive({ take: "all" } as never);
      return [refused, taken.map((e) => e.name).join()];
    }),
    startCase,
  );
  expect(run.value).toEqual([
    "receive takes every event not yet acknowledged; wf.select takes one at a time",
    "dd.changes",
  ]);
});

test("a race whose label throws is refused, and leaves its name to a retry", async () => {
  const run = await testWorkflow(
    caseRun(async (wf) => {
      const quiet = wf.timer("quiet", new Date(0));
      const label = () => {
        throw new Error("no label yet");
      };
      const refused = await wf.race("wait", { quiet }, { label }).then(
        () => "raced",
        (error: Error) => error.message,
      );
      const won = await wf.race("wait", { quiet }, { label: () => "quiet" });
      return [refused, won.key];
    }),
    startCase,
  );
  expect(run.value).toEqual(["no label yet", "quiet"]);
});

// Each site alone, so a check deleted from any one of them fails its test.
const plainRun = (
  name: string,
  run: Parameters<typeof defineWorkflow<null, JsonValue>>[0]["run"],
  options: Parameters<typeof testWorkflow>[2] = {},
) =>
  testWorkflow(defineWorkflow<null, JsonValue>({ meta: { name, description: name }, run }), null, {
    agents: { a: answer("yes") },
    ...options,
  });

test("id on compact alone logs", async () => {
  const run = await plainRun("compact-id", async (wf) => {
    const agent = await wf.agents.open({ key: "a", runtime: "claude" });
    await agent.run({ prompt: "One." });
    await agent.compact({ id: "c1", prompt: "Keep it." });
    return null;
  });
  expect(said(run)).toEqual({ "call-id": 1 });
});

test("id on set alone logs", async () => {
  const run = await plainRun("set-id", async (wf) => {
    const agent = await wf.agents.open({ key: "a", runtime: "claude" });
    await agent.set({ id: "s1", effort: "high" });
    return null;
  });
  expect(said(run)).toEqual({ "call-id": 1 });
});

test("labels on fork alone log", async () => {
  const run = await plainRun("fork-labels", async (wf) => {
    const agent = await wf.agents.open({ key: "a", runtime: "claude" });
    await agent.run({ prompt: "One." });
    await agent.fork({ key: "b", labels: { y: 2 } });
    return null;
  });
  expect(said(run)).toEqual({ labels: 1 });
});

test("labels on forkCaller alone log", async () => {
  const run = await plainRun(
    "fork-caller-labels",
    async (wf) => (await wf.agents.forkCaller({ key: "b", labels: { y: 2 } }))?.key ?? null,
    { caller: { harness: "claude", model: "claude-opus-5-5", here: false } },
  );
  expect(run.value).toBe("b");
  expect(said(run)).toEqual({ labels: 1 });
});

test("a fork's runtime runs as its flat fields did, which log once; both at once is refused", async () => {
  const run = await plainRun("fork-runtime", async (wf) => {
    const agent = await wf.agents.open({ key: "a", runtime: "claude" });
    await agent.run({ prompt: "One." });
    const given = await agent.fork({
      key: "given",
      runtime: { placement: "headless", metered: true, effort: "low" },
    });
    await agent.fork({ key: "flat", placement: "headless", metered: true, effort: "low" });
    await agent.fork({ key: "flat-again", placement: "headless", metered: true });
    // Either form of one spec is the same fork.
    const same = await agent.fork({
      key: "given",
      placement: "headless",
      metered: true,
      effort: "low",
    });
    const both = await agent
      .fork({ key: "both", placement: "headless", runtime: { metered: true } })
      .then(
        () => "forked",
        (error: Error) => error.message,
      );
    const model = await agent
      .fork({ key: "model", runtime: { model: "claude-opus-5-5" } as never })
      .then(
        () => "forked",
        (error: Error) => error.message,
      );
    return [same === given, both, model];
  });
  expect(run.value).toEqual([
    true,
    "agent both: a fork's placement, metered and effort go in its runtime, not beside it",
    "agent model: a fork continues its parent's session on its harness and model; its runtime takes placement, metered and effort, not model",
  ]);
  expect(run.agentOf("given").execution).toMatchObject({
    placement: "headless",
    metered: true,
    effort: "low",
  });
  expect(run.agentOf("given").execution).toEqual(run.agentOf("flat").execution);
  expect(said(run)).toEqual({ "fork-runtime": 1 });
});

test("a fork's runtime: either order of the two forms is one fork, an empty one is none, and what it leaves out is its parent's", async () => {
  const run = await plainRun("fork-runtime-forms", async (wf) => {
    const agent = await wf.agents.open({ key: "a", runtime: { alias: "claude", effort: "high" } });
    await agent.run({ prompt: "One." });
    const flat = await agent.fork({ key: "flat", placement: "headless", metered: true });
    const given = await agent.fork({
      key: "flat",
      runtime: { placement: "headless", metered: true },
    });
    const bare = await agent.fork({ key: "bare" });
    const empty = await agent.fork({ key: "bare", runtime: {} });
    await agent.fork({ key: "tui", runtime: { metered: true } });
    return [flat === given, bare === empty];
  });
  expect(run.value).toEqual([true, true]);
  expect(run.agentOf("flat").execution).toMatchObject({
    placement: "headless",
    metered: true,
    effort: "high",
  });
  expect(run.agentOf("bare").execution).toMatchObject({ effort: "high" });
  expect(run.agentOf("bare").execution).not.toHaveProperty("placement");
  // A TUI fork drops metered, where it means nothing.
  expect(run.agentOf("tui").execution).not.toHaveProperty("metered");
  expect(run.agentOf("tui").execution).not.toHaveProperty("placement");
});

test("flat fields refused beside runtime log nothing", async () => {
  const run = await plainRun("fork-runtime-refused", async (wf) => {
    const agent = await wf.agents.open({ key: "a", runtime: "claude" });
    await agent.run({ prompt: "One." });
    return agent.fork({ key: "both", effort: "low", runtime: { placement: "headless" } }).then(
      () => "forked",
      (error: Error) => error.message,
    );
  });
  expect(run.value).toBe(
    "agent both: a fork's placement, metered and effort go in its runtime, not beside it",
  );
  expect(said(run)).toEqual({});
});

test("agents.stop ends an agent as close() does, and logs once", async () => {
  const run = await plainRun("agents-stop", async (wf) => {
    const a = await wf.agents.open({ key: "a", runtime: "claude" });
    const b = await wf.agents.open({ key: "b", runtime: "claude" });
    const stopped = [await wf.agents.stop("a", "done"), await wf.agents.stop("a")];
    const closed = [await b.close("done"), await b.close()];
    const ran = await a.run({ prompt: "More." }).then(
      () => "ran",
      (error: Error) => error.message,
    );
    return [...stopped, ...closed, ran];
  });
  expect(run.value).toEqual([true, false, true, false, "logical agent is closed"]);
  expect(said(run)).toEqual({ "agents-stop": 1 });
});

test("a turn as a select's branch logs", async () => {
  const run = await testWorkflow(
    caseRun(async (wf) => {
      await wf.receive();
      const fixer = await wf.agents.open({ key: "fixer", runtime: "claude" });
      const turn = await fixer.start({ prompt: "Fix it." });
      for await (const next of wf.select({ fixed: turn })) return next.key;
      return null;
    }),
    { ...startCase, agents: { fixer: answer("fixed") } },
  );
  expect(run.value).toBe("fixed");
  expect(said(run)).toEqual({ "turn-source": 1 });
});

test("a stage around receive replayed by a continue logs, as each attempt logs its own", async () => {
  const workflow = caseRun(async (wf) => (await wf.stage("first", () => wf.receive())).length);
  const runRoot = runDirs.tempRunDir();
  const run = await createRun(runRoot, {
    id: "k",
    workflow: workflow.meta.name,
    argv: [],
    cwd: process.cwd(),
    sandbox: null,
  });
  await appendMailbox(run.dir, {
    version: MAILBOX_RECORD_VERSION,
    at: new Date().toISOString(),
    kind: "event",
    id: "e1",
    name: "dd.changes",
    data: { case: "k" },
    from: "operator",
  });
  const attempt = async (n: number) => {
    const logs: string[] = [];
    const result = await runWorkflow(workflow, null, {
      runRoot,
      run: { dir: run.dir, id: "k", attempt: n },
      runtime: { aliases: OPERATOR_ALIASES, host: createSingleSessionHostFactory(answering()) },
      deadline: future(),
      onLog: (text) => logs.push(text),
    });
    return { value: result.value, logs: logs.filter((line) => line.includes("deprecated")) };
  };
  const line = `awf: ${DEPRECATIONS["stage-receive"].old} is deprecated; ${DEPRECATIONS["stage-receive"].instead}`;
  // The first takes the batch at its wait; the continue reuses the stage, and its batch, unwaited.
  expect(await attempt(1)).toEqual({ value: 1, logs: [line] });
  expect(await attempt(2)).toEqual({ value: 1, logs: [line] });
});

test("testing's reply.…, run.stopped and run.parked work as before, each logged once", async () => {
  const run = await plainRun(
    "old-test-forms",
    async (wf) => {
      const a = await wf.agents.open({ key: "a", runtime: "claude" });
      const b = await wf.agents.open({ key: "b", runtime: "claude" });
      const first = await a.run({ prompt: "One." });
      const second = await b.run({ prompt: "Two." });
      return wf.stop(`${first.outcome.kind}, ${second.outcome.kind}`);
    },
    { agents: { a: reply.failed("crashed"), b: reply.failed("crashed") } },
  );
  expect(run.turns.map((turn) => turn.outcome)).toEqual(["failed", "failed"]);
  expect(run.stopped).toEqual({ reason: "failed, failed" });
  expect(run.stopped).toEqual({ reason: "failed, failed" });
  expect(run.parked).toBeUndefined();
  expect(said(run)).toEqual({ "test-reply": 1, "run-stopped": 1, "run-parked": 1 });
});

test("a reply.… met only by a compaction logs", async () => {
  const run = await plainRun(
    "old-compaction",
    async (wf) => {
      const agent = await wf.agents.open({ key: "a", runtime: "claude" });
      await agent.run({ prompt: "One." });
      return (await agent.compact({ prompt: "Keep it." })).kind;
    },
    { compactions: { a: reply.failed("nothing to compact") } },
  );
  expect(run.value).toBe("failed");
  expect(said(run)).toEqual({ "test-reply": 1 });
});

test("an event's id, the start's or a scripted one's, is its id in the mailbox, logged once", async () => {
  const run = await testWorkflow(
    caseRun(async (wf) => {
      const agent = await wf.agents.open({ key: "a", runtime: "claude" });
      await agent.run({ prompt: "One." });
      return (await wf.receive()).length;
    }),
    {
      id: "k",
      event: { name: "dd.changes", data: { case: "k" }, id: "start-1" },
      agents: { a: answer("yes") },
      events: [{ during: "a#1", name: "dd.changes", data: { case: "k" }, id: "next-1" }],
    },
  );
  expect(eventIds(run)).toEqual(["start-1", "next-1"]);
  expect(said(run)).toEqual({ "test-event-id": 1 });
});

test("testing's new forms log nothing", async () => {
  const run = await testWorkflow(
    caseRun(async (wf) => {
      const agent = await wf.agents.open({ key: "a", runtime: "claude" });
      const { outcome } = await agent.run({ prompt: "One." });
      await wf.receive();
      return wf.stop(outcome.kind);
    }),
    {
      id: "k",
      event: { name: "dd.changes", data: { case: "k" }, eventId: "start-1" },
      agents: { a: noAnswer.failed() },
      events: [{ during: "a#1", name: "dd.changes", data: { case: "k" }, eventId: "next-1" }],
    },
  );
  expect(run.ending).toMatchObject({ kind: "stopped", reason: "failed" });
  expect(eventIds(run)).toEqual(["start-1", "next-1"]);
  expect(said(run)).toEqual({});
});

test("each key with a colon logs once an attempt, naming it with - for each colon", async () => {
  const run = await plainRun(
    "colon-keys",
    async (wf) => {
      const security = await wf.agents.open({ key: "reviewer:security", runtime: "claude" });
      await wf.agents.open({ key: "reviewer:security", runtime: "claude" });
      await wf.agents.open({ key: "reviewer:style", runtime: "claude" });
      await wf.participants.connect({ key: "lead:x" });
      const { outcome } = await security.run({ prompt: "One." });
      return outcome.kind;
    },
    { agents: { "reviewer:security": answer("yes") } },
  );
  expect(run.value).toBe("answered");
  const lines = run.logs
    .map((log) => log.message)
    .filter((line) => line.includes("a key with a colon"));
  expect(lines).toEqual([
    "awf: a key with a colon, reviewer:security, is deprecated; name it reviewer-security: a colon is kept for awf's own event names",
    "awf: a key with a colon, reviewer:style, is deprecated; name it reviewer-style: a colon is kept for awf's own event names",
    "awf: a key with a colon, lead:x, is deprecated; name it lead-x: a colon is kept for awf's own event names",
  ]);
});

test("a forked, caller's or participant's key with a colon logs too", async () => {
  const forked = await plainRun("colon-fork", async (wf) => {
    const agent = await wf.agents.open({ key: "a", runtime: "claude" });
    await agent.run({ prompt: "One." });
    await agent.fork({ key: "a:copy" });
    return null;
  });
  expect(said(forked)).toEqual({ "colon-key": 1 });
  const caller = await plainRun(
    "colon-caller",
    async (wf) => (await wf.agents.caller({ key: "me:here" }))?.key ?? null,
    { caller: { harness: "claude", model: "claude-opus-5-5", here: true } },
  );
  expect(said(caller)).toEqual({ "colon-key": 1 });
  const connected = await plainRun("colon-participant", async (wf) => {
    await wf.participants.connect({ key: "lead:x" });
    return null;
  });
  expect(said(connected)).toEqual({ "colon-key": 1 });
});

test("a deprecation that names no subject reads whole", () => {
  expect(deprecationLine("colon-key")).toBe(
    "awf: a key with a colon is deprecated; use - in its place: a colon is kept for awf's own event names",
  );
});

function eventIds(run: TestRun<JsonValue>): string[] {
  return run.mailbox.flatMap((record) => (record.kind === "event" ? [record.id] : []));
}
