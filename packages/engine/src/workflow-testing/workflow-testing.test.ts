import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  choice,
  defineExecutableWorkflow,
  type JsonValue,
  type RuntimeSelection,
  score,
  type WorkflowDefinition,
  yesNo,
} from "@agentswf/contract/workflow";
import Type from "typebox";
import { answer, reply, testWorkflow } from ".";

const PLAN = Type.Object({ steps: Type.Array(Type.String()) }, { additionalProperties: false });
const STATUS = Type.Object(
  { step: Type.Integer(), state: Type.Union([Type.Literal("done"), Type.Literal("stuck")]) },
  { additionalProperties: false },
);
const VERDICT = Type.Object(
  { ready: Type.Boolean(), notes: Type.Array(Type.String(), { minItems: 1 }) },
  { additionalProperties: false },
);

function workflowOf<Args extends JsonValue, Result extends JsonValue>(
  run: WorkflowDefinition<Args, Result>["run"],
): WorkflowDefinition<Args, Result> {
  return { meta: { name: "test", description: "a test", whenToUse: "in tests" }, run };
}

/** Plans, reports each step, and summarizes: one agent asked three schemas in one session. */
const builder = workflowOf<{ task: string }, { done: number; summary: string }>(
  async (workflow, { task }) => {
    const agent = await workflow.agents.open({ key: "builder", runtime: "codex" });
    const plan = await agent.run({ prompt: `Plan ${task}.\nKeep it short.`, schema: PLAN });
    if (plan.outcome.kind !== "answered") throw new Error(`no plan: ${plan.outcome.kind}`);
    const { steps } = plan.outcome.value as { steps: string[] };
    let done = 0;
    for (const [step, name] of steps.entries()) {
      const status = await agent.run({ prompt: `Do step ${step}: ${name}.`, schema: STATUS });
      if (status.outcome.kind === "answered") done += 1;
    }
    const summary = await agent.run({ prompt: "Summarize what you did." });
    return {
      done,
      summary: summary.outcome.kind === "answered" ? summary.outcome.value : summary.outcome.kind,
    };
  },
);

/** One turn, and how it ended. */
const solo = (options: { schema?: boolean; runtime?: RuntimeSelection } = {}) =>
  workflowOf<null, JsonValue>(async (workflow): Promise<JsonValue> => {
    const agent = await workflow.agents.open({ key: "solo", runtime: options.runtime ?? "codex" });
    const { outcome } = options.schema
      ? await agent.run({ prompt: "Review.", label: "review", schema: VERDICT })
      : await agent.run({ prompt: "Say hello." });
    if (outcome.kind === "answered") return { kind: outcome.kind, value: outcome.value };
    return { kind: outcome.kind, reason: outcome.reason };
  });

/** A review per lens, in parallel; a lens without an answer fails the whole review. */
const lenses = workflowOf<{ lenses: string[] }, JsonValue[]>(async (workflow, args) =>
  workflow.parallel(args.lenses, async (lens) => {
    const agent = await workflow.agents.open({ key: `review:${lens}`, runtime: "codex" });
    const { outcome } = await agent.run({ prompt: `Review for ${lens}.`, schema: VERDICT });
    if (outcome.kind !== "answered") throw new Error(`${lens}: ${outcome.kind}`);
    return outcome.value;
  }),
);

const ok = { ready: true, notes: ["fine"] };

describe("testWorkflow", () => {
  test("a list answers turn by turn, each entry with its own schema, text included", async () => {
    const run = await testWorkflow(
      builder,
      { task: "a cache" },
      {
        agents: {
          builder: [
            answer(PLAN, { steps: ["add", "invalidate"] }),
            answer(STATUS, { step: 0, state: "done" }),
            answer(STATUS, (turn) => ({ step: turn.n - 2, state: "done" })),
            answer("Added a cache."),
          ],
        },
      },
    );
    expect(run.value).toEqual({ done: 2, summary: "Added a cache." });
    expect(run.turnsOf("builder").map((turn) => [turn.n, turn.outcome])).toEqual([
      [1, "answered"],
      [2, "answered"],
      [3, "answered"],
      [4, "answered"],
    ]);
    // The prompt as the workflow wrote it, not as the engine wrapped it.
    expect(run.turns[0]!.prompt).toBe("Plan a cache.\nKeep it short.");
    expect(run.turns[3]!.schema).toBeUndefined();
    expect(run.agents).toEqual([
      {
        key: "builder",
        execution: { harness: "codex", model: "gpt-5.6-sol", alias: "codex" },
      },
    ]);
  });

  test("a single answer meets every turn, and one never used passes", async () => {
    const twice = workflowOf<null, JsonValue[]>(async (workflow) => {
      const agent = await workflow.agents.open({ key: "solo", runtime: "codex" });
      const answers: JsonValue[] = [];
      for (const label of ["first", "second"]) {
        const { outcome } = await agent.run({ prompt: "Review.", label, schema: VERDICT });
        answers.push(outcome.kind === "answered" ? outcome.value : outcome.kind);
      }
      return answers;
    });
    const run = await testWorkflow(twice, null, {
      agents: { solo: answer(VERDICT, ok), unused: answer("never asked") },
    });
    expect(run.value).toEqual([ok, ok]);
    expect(run.turns.map(({ n, nudge, label }) => ({ n, nudge, label }))).toEqual([
      { n: 1, nudge: false, label: "first" },
      { n: 2, nudge: false, label: "second" },
    ]);
  });

  describe("each reply ends the turn its way", () => {
    for (const [name, given, kind] of [
      ["blocked", reply.blocked("a permission prompt"), "blocked"],
      ["failed", reply.failed("harness crashed"), "failed"],
      ["timedOut", reply.timedOut(), "timed-out"],
    ] as const) {
      test(name, async () => {
        const run = await testWorkflow(solo({ schema: true }), null, { agents: { solo: given } });
        expect(run.value).toMatchObject({ kind });
        expect(run.turns.map((turn) => turn.outcome)).toEqual([kind]);
      });
    }

    test("silent: the engine nudges once, and the reply ends the nudge too", async () => {
      const run = await testWorkflow(solo({ schema: true }), null, {
        agents: { solo: reply.silent() },
      });
      expect(run.value).toMatchObject({ kind: "unanswered" });
      expect(run.turns.map((turn) => [turn.n, turn.nudge, turn.outcome])).toEqual([
        [1, false, "silent"],
        [1, true, "silent"],
      ]);
    });

    test("a function sees the nudge and can answer it", async () => {
      const run = await testWorkflow(solo({ schema: true }), null, {
        agents: { solo: answer(VERDICT, (turn) => (turn.nudge ? ok : reply.silent())) },
      });
      expect(run.value).toEqual({ kind: "answered", value: ok });
      expect(run.turns.map((turn) => [turn.nudge, turn.outcome])).toEqual([
        [false, "silent"],
        [true, "answered"],
      ]);
    });

    test("needsLogin: the turn fails with login set, unnudged, and the workflow can stop on it", async () => {
      const run = await testWorkflow(
        workflowOf<null, JsonValue>(async (workflow) => {
          const agent = await workflow.agents.open({ key: "solo", runtime: "codex" });
          const { outcome } = await agent.run({ prompt: "Review.", schema: VERDICT });
          if (outcome.kind === "failed" && outcome.login) workflow.stop(outcome.reason);
          return outcome.kind;
        }),
        null,
        { agents: { solo: reply.needsLogin() } },
      );
      expect(run.turns.map((turn) => [turn.nudge, turn.outcome])).toEqual([[false, "needs-login"]]);
      expect(run.stopped?.reason).toStartWith("codex needs a login: run `codex login`");

      const seen = await testWorkflow(
        workflowOf<null, JsonValue>(async (workflow) => {
          const agent = await workflow.agents.open({ key: "solo", runtime: "codex" });
          const { outcome } = await agent.run({ prompt: "Review." });
          return outcome.kind === "failed" ? (outcome.login ?? null) : null;
        }),
        null,
        { agents: { solo: reply.needsLogin("openai") } },
      );
      expect(seen.value).toEqual({
        harness: "codex",
        provider: "openai",
        run: "run `codex login`",
      });
    });

    test("hang holds the turn until the engine cancels it: parallel's fail-fast", async () => {
      const cancelled: string[] = [];
      // A barrier: the fast lens fails only once the slow one is under way.
      const { promise: slowStarted, resolve: started } = Promise.withResolvers<void>();
      const run = await testWorkflow(
        lenses,
        { lenses: ["fast", "slow"] },
        {
          agents: {
            "review:fast": answer(VERDICT, async () => {
              await slowStarted;
              return reply.failed();
            }),
            "review:slow": answer(VERDICT, (turn) => {
              turn.signal.addEventListener("abort", () => cancelled.push(turn.agent));
              started();
              return reply.hang();
            }),
          },
        },
      );
      expect(() => run.value).toThrow("fast: failed");
      expect(cancelled).toEqual(["review:slow"]);
    });
  });

  test("a script still deciding when its turn is cancelled is let go, as cancelled", async () => {
    const { promise: slowStarted, resolve: started } = Promise.withResolvers<void>();
    const run = await testWorkflow(
      lenses,
      { lenses: ["fast", "slow"] },
      {
        agents: {
          "review:fast": answer(VERDICT, async () => {
            await slowStarted;
            return reply.failed();
          }),
          "review:slow": answer(VERDICT, () => {
            started();
            return new Promise(() => undefined);
          }),
        },
      },
    );
    expect(() => run.value).toThrow("fast: failed");
    expect(run.turnsOf("review:slow").map((turn) => turn.outcome)).toEqual(["cancelled"]);
  });

  test("runtimes adds aliases beside awf run's, and one of the same name replaces it", async () => {
    const two = workflowOf<null, string[]>(async (workflow) => {
      const agents = await Promise.all(
        ["claude", "cheap"].map((runtime) => workflow.agents.open({ key: runtime, runtime })),
      );
      return agents.map((agent) => agent.execution.model);
    });
    const run = await testWorkflow(two, null, {
      runtimes: { cheap: { harness: "codex", model: "mini" } },
    });
    expect(run.value).toEqual(["sonnet", "mini"]);
    const replaced = await testWorkflow(two, null, {
      runtimes: {
        claude: { harness: "claude", model: "opus" },
        cheap: { harness: "codex", model: "mini" },
      },
    });
    expect(replaced.value).toEqual(["opus", "mini"]);
  });

  test("timeoutMs is the run's deadline", async () => {
    const remaining = workflowOf<null, number>(
      async (workflow) => workflow.deadline.unixMilliseconds - Date.now(),
    );
    const run = await testWorkflow(remaining, null, { timeoutMs: 60_000 });
    expect(run.value).toBeGreaterThan(55_000);
    expect(run.value).toBeLessThanOrEqual(60_000);
  });

  test("a function that returns nothing fails the test", async () => {
    await expect(
      testWorkflow(solo(), null, {
        agents: { solo: answer((() => undefined) as unknown as () => string) },
      }),
    ).rejects.toThrow(/agent "solo" turn 1: its script returned nothing/);
  });

  test("the workflow's cwd, its log lines and what each agent was opened with", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "awf-test-cwd-"));
    const skill = join(cwd, "skills", "notes");
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, "SKILL.md"), "---\nname: notes\ndescription: Take notes.\n---\n");
    try {
      const opened = workflowOf<null, string>(async (workflow) => {
        workflow.log("opening", { skill: "notes" });
        await workflow.agents.open({
          key: "noter",
          runtime: "claude",
          instructions: "Take notes.",
          labels: { role: "noter" },
          skills: [{ path: skill }],
        });
        return workflow.cwd;
      });
      const run = await testWorkflow(opened, null, { cwd });
      expect(run.value).toBe(cwd);
      expect(run.logs).toContainEqual({ message: "opening", fields: { skill: "notes" } });
      expect(run.agents).toEqual([
        {
          key: "noter",
          execution: { harness: "claude", model: "sonnet", alias: "claude" },
          instructions: "Take notes.",
          labels: { role: "noter" },
          skills: ["notes"],
        },
      ]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  describe("scripts are found by key", () => {
    test("an exact key wins over a pattern", async () => {
      const run = await testWorkflow(
        lenses,
        { lenses: ["a", "b"] },
        {
          agents: {
            "review:*": answer(VERDICT, ok),
            "review:b": answer(VERDICT, { ready: false, notes: ["b"] }),
          },
        },
      );
      expect(run.value).toEqual([ok, { ready: false, notes: ["b"] }]);
    });

    test("a pattern's list is walked per agent", async () => {
      const run = await testWorkflow(
        lenses,
        { lenses: ["a", "b"] },
        {
          agents: {
            "review:*": [answer(VERDICT, (turn) => ({ ready: true, notes: [turn.agent] }))],
          },
        },
      );
      expect(run.value).toEqual([
        { ready: true, notes: ["review:a"] },
        { ready: true, notes: ["review:b"] },
      ]);
    });

    test("two patterns matching one key fail the test", async () => {
      await expect(
        testWorkflow(
          lenses,
          { lenses: ["a"] },
          {
            agents: { "review:*": answer(VERDICT, ok), "*:a": answer(VERDICT, ok) },
          },
        ),
      ).rejects.toThrow(/agent "review:a" turn 1: it matches "review:\*" and "\*:a"/);
    });

    test("an agent with no script fails the test, naming what is scripted", async () => {
      await expect(
        testWorkflow(solo(), null, { agents: { reviewer: answer("hi") } }),
      ).rejects.toThrow(
        /agent "solo" turn 1: no script for it; scripted: "reviewer". It was asked: Say hello\./,
      );
    });
  });

  describe("a list is strict", () => {
    test("an empty list is refused", async () => {
      await expect(testWorkflow(solo(), null, { agents: { solo: [] } })).rejects.toThrow(
        /agents\["solo"\] is an empty list/,
      );
    });

    test("a pattern's list no agent matched fails the test", async () => {
      await expect(
        testWorkflow(solo(), null, { agents: { solo: answer("hi"), "ghost:*": [answer("boo")] } }),
      ).rejects.toThrow(/no agent matching "ghost:\*" was asked; its script has 1 turn/);
    });

    test("an unfinished list's message keeps what the workflow threw", async () => {
      const quits = workflowOf<null, null>(async (workflow) => {
        const agent = await workflow.agents.open({ key: "solo", runtime: "codex" });
        await agent.run({ prompt: "Say hello." });
        throw new Error("the workflow gave up");
      });
      await expect(
        testWorkflow(quits, null, { agents: { solo: [answer("hi"), answer("again")] } }),
      ).rejects.toThrow(
        /was asked 1 turn; its script has 2\nthe workflow threw: the workflow gave up/,
      );
    });

    test("a turn past its end fails the test", async () => {
      await expect(
        testWorkflow(
          builder,
          { task: "x" },
          {
            agents: { builder: [answer(PLAN, { steps: ["one"] })] },
          },
        ),
      ).rejects.toThrow(/agent "builder" turn 2: its script has 1 turn\. It was asked: Do step 0/);
    });

    test("an entry never reached fails the test", async () => {
      await expect(
        testWorkflow(solo(), null, { agents: { solo: [answer("hi"), answer("again")] } }),
      ).rejects.toThrow(/agent "solo" was asked 1 turn; its script has 2/);
    });

    test("a list for an agent never opened fails the test", async () => {
      await expect(
        testWorkflow(solo(), null, { agents: { solo: answer("hi"), ghost: [answer("boo")] } }),
      ).rejects.toThrow(/agent "ghost" was never asked; its script has 1 turn/);
    });
  });

  describe("an answer is checked against what the turn asks", () => {
    test("a schema other than the turn's fails the test, naming both", async () => {
      await expect(
        testWorkflow(solo({ schema: true }), null, {
          agents: { solo: answer(PLAN, { steps: [] }) },
        }),
      ).rejects.toThrow(
        /agent "solo" turn 1: it asks for \{.*"notes".*; its script answers \{.*"steps"/,
      );
    });

    test("text for a turn that asks for a schema fails the test", async () => {
      await expect(
        testWorkflow(solo({ schema: true }), null, { agents: { solo: answer("ready") } }),
      ).rejects.toThrow(/its script answers text/);
    });

    test("equal TypeBox schemas with their properties in another order match", async () => {
      const swapped = Type.Object(
        { notes: Type.Array(Type.String(), { minItems: 1 }), ready: Type.Boolean() },
        { additionalProperties: false },
      );
      const run = await testWorkflow(solo({ schema: true }), null, {
        agents: { solo: answer(swapped, ok) },
      });
      expect(run.value).toEqual({ kind: "answered", value: ok });
    });

    test("an equal schema built in another key order matches", async () => {
      const reordered = {
        additionalProperties: false,
        required: ["ready", "notes"],
        properties: {
          notes: { minItems: 1, items: { type: "string" }, type: "array" },
          ready: { type: "boolean" },
        },
        type: "object",
      } as const;
      const run = await testWorkflow(solo({ schema: true }), null, {
        agents: { solo: answer(reordered, ok) },
      });
      expect(run.value).toEqual({ kind: "answered", value: ok });
    });

    test("an answer the schema refuses fails the test with the schema's error", async () => {
      const empty = { ready: true, notes: [] as string[] };
      await expect(
        testWorkflow(solo({ schema: true }), null, { agents: { solo: answer(VERDICT, empty) } }),
      ).rejects.toThrow(
        /agent "solo" turn 1: the schema refused its script's answer: [\s\S]*notes/,
      );
    });
  });

  test("a fake's file in turn.cwd is what the workflow reads", async () => {
    const reader = workflowOf<null, string>(async (workflow) => {
      const agent = await workflow.agents.open({ key: "writer", runtime: "codex" });
      const { outcome } = await agent.run({ prompt: "Write notes.md.", schema: PLAN });
      if (outcome.kind !== "answered") throw new Error(outcome.kind);
      return readFileSync(join(workflow.cwd, "notes.md"), "utf8");
    });
    const run = await testWorkflow(reader, null, {
      agents: {
        writer: answer(PLAN, (turn) => {
          writeFileSync(join(turn.cwd, "notes.md"), "written by the fake");
          return { steps: [] };
        }),
      },
    });
    expect(run.value).toBe("written by the fake");
  });

  test("an agent in a sandbox is recorded with its sandbox: key, provider, settings and domains", async () => {
    const boxed = workflowOf<null, string>(async (workflow) => {
      const box = await workflow.sandboxes.open({
        key: "team",
        write: ["."],
        read: ["/etc/hosts"],
        network: ["registry.npmjs.org"],
        docker: { image: "node:24" },
      });
      const inBox = await workflow.agents.open({ key: "inside", runtime: "codex", sandbox: box });
      const own = await workflow.agents.open({
        key: "own",
        runtime: { harness: "codex", model: "m", placement: "headless" },
        sandbox: { srt: {} },
      });
      await inBox.run({ prompt: "Hi." });
      await own.run({ prompt: "Hi." });
      return "done";
    });
    const run = await testWorkflow(boxed, null, { agents: { "*": answer("hello") } });
    expect(run.value).toBe("done");
    const team = run.agentOf("inside").sandbox!;
    expect(team).toEqual({
      key: "team",
      provider: "docker",
      spec: {
        cwd: team.spec.cwd,
        // Paths are recorded as the sandbox gets them: absolute, links resolved.
        read: [realpathSync("/etc/hosts")],
        write: [team.spec.cwd],
        network: ["registry.npmjs.org"],
        docker: { image: "node:24" },
      },
      domains: expect.arrayContaining(["registry.npmjs.org", "chatgpt.com"]),
    });
    expect(run.agentOf("own").sandbox).toMatchObject({
      key: "agent:own",
      provider: "srt",
      spec: { read: [], write: [], network: [], srt: {} },
    });
    expect(run.agentOf("own").sandbox!.domains).not.toContain("registry.npmjs.org");
    expect(() => run.agentOf("ghost")).toThrow(
      'no agent "ghost" was opened; opened: "inside", "own"',
    );
  });

  describe("the hosts refuse what the real ones refuse", () => {
    test("headless claude without metered", async () => {
      const runtime = { harness: "claude", model: "m", placement: "headless" } as const;
      const run = await testWorkflow(solo({ runtime }), null, { agents: { solo: answer("hi") } });
      expect(() => run.value).toThrow("set metered: true");
    });
  });

  describe("a stuck test fails, it doesn't hang", () => {
    test("a script that never settles", async () => {
      await expect(
        testWorkflow(solo(), null, {
          stallMs: 100,
          agents: { solo: answer(() => new Promise<string>(() => undefined)) },
        }),
      ).rejects.toThrow(
        /the run stalled: nothing started or ended for 100 ms; in flight: "solo" turn 1/,
      );
    });

    test("a hang nothing cancels", async () => {
      await expect(
        testWorkflow(solo(), null, { stallMs: 100, agents: { solo: reply.hang() } }),
      ).rejects.toThrow(/the run stalled.*in flight: "solo" turn 1$/);
    });
  });

  test("reading the value of a run whose workflow threw throws, with the throw as the cause", async () => {
    const run = await testWorkflow(
      workflowOf<null, null>(async () => {
        throw new Error("the workflow gave up");
      }),
      null,
    );
    expect(() => run.value).toThrow("the workflow threw: the workflow gave up");
    expect(() => run.value).toThrow(
      expect.objectContaining({ cause: new Error("the workflow gave up") }),
    );
  });

  test("an executable is run by its definition", async () => {
    const executable = defineExecutableWorkflow({ definition: solo(), prepare: () => null });
    const run = await testWorkflow(executable, null, { agents: { solo: answer("hi") } });
    expect(run.value).toEqual({ kind: "answered", value: "hi" });
  });

  describe("decisions", () => {
    const triage = workflowOf<{ ticket: string }, JsonValue>(async (workflow, { ticket }) => {
      const { answers } = await workflow.decisions.decide({
        key: "triage:1",
        model: "jev",
        state: { ticket },
        questions: {
          team: choice("Which team?", { payments: null, frontend: null }),
          bug: yesNo("Broken?"),
          urgency: score("How soon?", ["later", "now"]),
        },
      });
      return {
        team: answers.team.choice,
        bug: answers.bug.yes,
        urgency: answers.urgency.level,
      };
    });

    test("are answered in the author's terms, by key or pattern", async () => {
      const run = await testWorkflow(
        triage,
        { ticket: "Pay twice" },
        {
          decisions: { "triage:*": { team: "payments", bug: true, urgency: 1 } },
        },
      );
      expect(run.value).toEqual({ team: "payments", bug: 1, urgency: 1 });
      expect(run.decisions).toMatchObject([{ key: "triage:1", state: { ticket: "Pay twice" } }]);
    });

    test("a function of the request, with probabilities", async () => {
      const run = await testWorkflow(
        triage,
        { ticket: "Pay twice" },
        {
          decisions: {
            "triage:1": (request) => ({
              team: { payments: 0.3, frontend: 0.7 },
              bug: JSON.stringify(request.state).includes("twice") ? 0.8 : 0.1,
              urgency: [0.9, 0.1],
            }),
          },
        },
      );
      expect(run.value).toEqual({ team: "frontend", bug: 0.8, urgency: 0 });
    });

    test("an Error makes decide reject, as a provider failure does", async () => {
      const run = await testWorkflow(
        triage,
        { ticket: "t" },
        {
          decisions: { "triage:1": new Error("provider down") },
        },
      );
      expect(() => run.value).toThrow("provider down");
    });

    test("a script that throws fails the test", async () => {
      await expect(
        testWorkflow(
          triage,
          { ticket: "t" },
          {
            decisions: {
              "triage:1": () => {
                throw new Error("oops");
              },
            },
          },
        ),
      ).rejects.toThrow(/decision "triage:1": its script threw: oops/);
    });

    test("probabilities that are not a distribution fail the test", async () => {
      for (const team of <Record<string, number>[]>[
        { payments: 0.3 },
        { payments: 0.5, legal: 0.5 },
        { payments: 0.9, frontend: 0.9 },
      ]) {
        await expect(
          testWorkflow(
            triage,
            { ticket: "t" },
            {
              decisions: { "triage:1": { team, bug: 0.5, urgency: 0 } },
            },
          ),
        ).rejects.toThrow(/decision "triage:1": its script's answer is refused: question team: /);
      }
      await expect(
        testWorkflow(
          triage,
          { ticket: "t" },
          {
            decisions: { "triage:1": { team: "payments", bug: 3, urgency: 0 } },
          },
        ),
      ).rejects.toThrow(/question bug: no probability of yes/);
    });

    test("a distribution rounded as Jev's are, summing to 0.99, is one", async () => {
      const run = await testWorkflow(
        triage,
        { ticket: "t" },
        {
          decisions: {
            "triage:1": {
              team: { payments: 0.5, frontend: 0.49 },
              bug: 1,
              urgency: 0,
            },
          },
        },
      );
      expect(run.value).toMatchObject({ team: "payments" });
    });

    test("an unscripted decision fails the test", async () => {
      await expect(testWorkflow(triage, { ticket: "t" })).rejects.toThrow(
        /decision "triage:1": no decision is scripted/,
      );
    });

    test("an answer of the wrong kind fails the test", async () => {
      await expect(
        testWorkflow(
          triage,
          { ticket: "t" },
          {
            decisions: { "triage:1": { team: "legal", bug: true, urgency: 1 } },
          },
        ),
      ).rejects.toThrow(/"team" is a choice question; its script answers "legal"/);
    });
  });
});

/** Plans, compacts with a focus, then builds: one agent carried across a compaction. */
const compacting = workflowOf<{ compactions: number }, JsonValue>(async (workflow, args) => {
  const agent = await workflow.agents.open({ key: "builder", runtime: "claude" });
  await agent.run({ prompt: "Plan a cache.", schema: PLAN });
  const outcomes: JsonValue[] = [];
  for (let n = 1; n <= args.compactions; n++) {
    const outcome = await agent.compact({
      id: `after-plan-${n}`,
      prompt: `Keep the plan's decisions, round ${n}.`,
      deadline: { unixMilliseconds: Date.now() + 60_000 },
    });
    outcomes.push(
      outcome.kind === "answered"
        ? { kind: outcome.kind, value: outcome.value }
        : { kind: outcome.kind, reason: outcome.reason },
    );
  }
  const built = await agent.run({ prompt: "Build it.", schema: STATUS });
  return { compactions: outcomes, built: built.outcome.kind };
});

describe("testWorkflow compactions", () => {
  test("an unscripted compaction answers an empty summary, apart from the agent's turns", async () => {
    const run = await testWorkflow(
      compacting,
      { compactions: 1 },
      {
        agents: {
          builder: [answer(PLAN, { steps: ["a"] }), answer(STATUS, { step: 0, state: "done" })],
        },
      },
    );
    expect(run.value).toEqual({
      compactions: [{ kind: "answered", value: "" }],
      built: "answered",
    });
    expect(run.turnsOf("builder").map((turn) => turn.n)).toEqual([1, 2]);
    expect(run.compactionsOf("builder")).toEqual([
      {
        agent: "builder",
        n: 1,
        id: "after-plan-1",
        focus: "Keep the plan's decisions, round 1.",
        outcome: "answered",
      },
    ]);
  });

  test("a scripted compaction answers its summary, or ends as its reply says", async () => {
    const run = await testWorkflow(
      compacting,
      { compactions: 3 },
      {
        agents: {
          builder: [answer(PLAN, { steps: ["a"] }), answer(STATUS, { step: 0, state: "done" })],
        },
        compactions: {
          builder: [answer("kept the plan"), reply.failed("nothing to compact"), reply.silent()],
        },
      },
    );
    expect(run.value).toEqual({
      compactions: [
        { kind: "answered", value: "kept the plan" },
        { kind: "failed", reason: "nothing to compact" },
        { kind: "failed", reason: "the harness did not confirm a compaction" },
      ],
      built: "answered",
    });
    expect(run.compactionsOf("builder").map((c) => c.outcome)).toEqual([
      "answered",
      "failed",
      "silent",
    ]);
  });

  test("a compaction that hangs past its deadline times out, and the agent goes on", async () => {
    const hanging = workflowOf<null, JsonValue>(async (workflow) => {
      const agent = await workflow.agents.open({ key: "builder", runtime: "claude" });
      await agent.run({ prompt: "Plan it.", schema: STATUS });
      const compacted = await agent.compact({ prompt: "Keep everything.", timeoutMs: 50 });
      const built = await agent.run({ prompt: "Build it.", schema: STATUS });
      return { compacted: compacted.kind, built: built.outcome.kind };
    });
    const run = await testWorkflow(hanging, null, {
      agents: { builder: answer(STATUS, { step: 0, state: "done" }) },
      compactions: { builder: reply.hang() },
    });
    expect(run.value).toEqual({ compacted: "timed-out", built: "answered" });
  });

  test("a compaction id reused with another focus rejects; the same spec returns the same outcome", async () => {
    const reused = workflowOf<null, JsonValue>(async (workflow) => {
      const agent = await workflow.agents.open({ key: "builder", runtime: "claude" });
      const deadline = { unixMilliseconds: Date.now() + 60_000 };
      const first = agent.compact({ id: "c", prompt: "Keep A.", deadline });
      const again = agent.compact({ id: "c", prompt: "Keep A.", deadline });
      const other = agent.compact({ id: "c", prompt: "Keep B.", deadline }).then(
        () => "accepted",
        (error: Error) => error.message,
      );
      return { same: (await first) === (await again), other: await other };
    });
    const run = await testWorkflow(reused, null);
    expect(run.value).toEqual({
      same: true,
      other: "compaction id c was reused with a different specification",
    });
    expect(run.compactionsOf("builder")).toHaveLength(1);
  });

  test("a compaction without an id or a bound gets its own id and the workflow's deadline", async () => {
    const defaults = workflowOf<null, JsonValue>(async (workflow) => {
      const agent = await workflow.agents.open({ key: "builder", runtime: "claude" });
      await agent.run({ prompt: "Plan it.", schema: STATUS });
      const kinds = [];
      for (let n = 0; n < 2; n++) kinds.push((await agent.compact({ prompt: "Keep it." })).kind);
      const both = await agent
        .compact({ prompt: "Keep it.", timeoutMs: 1_000, deadline: { unixMilliseconds: 1 } })
        .then(
          () => "accepted",
          (error: Error) => error.message,
        );
      return { kinds, both };
    });
    const run = await testWorkflow(defaults, null, {
      agents: { builder: answer(STATUS, { step: 0, state: "done" }) },
      compactions: { builder: [answer("one"), answer("two")] },
    });
    expect(run.value).toEqual({
      kinds: ["answered", "answered"],
      both: "an operation cannot specify both deadline and timeoutMs",
    });
    const [first, second] = run.compactionsOf("builder");
    expect(first?.id).not.toEqual(second?.id);
  });

  test("a compaction script left unfinished fails the test, named as a compaction", async () => {
    await expect(
      testWorkflow(
        compacting,
        { compactions: 1 },
        {
          agents: {
            builder: [answer(PLAN, { steps: ["a"] }), answer(STATUS, { step: 0, state: "done" })],
          },
          compactions: { builder: [answer("one"), answer("two")] },
        },
      ),
    ).rejects.toThrow(/agent "builder" was asked 1 compaction; its compaction script has 2/);
  });
  test("a compaction a real host would refuse is refused here too, whatever the script", async () => {
    const refusals = workflowOf<null, JsonValue>(async (workflow) => {
      const fresh = await workflow.agents.open({ key: "fresh", runtime: "claude" });
      const early = await fresh.compact({ prompt: "Keep it." });
      const cursor = await workflow.agents.open({
        key: "cursor",
        runtime: { harness: "cursor", model: "composer", placement: "headless" },
      });
      await cursor.run({ prompt: "Plan it.", schema: STATUS });
      const none = await cursor.compact({ prompt: "Keep it." });
      return [early, none].map((o) => (o.kind === "failed" ? o.reason : o.kind));
    });
    const run = await testWorkflow(refusals, null, {
      agents: { cursor: answer(STATUS, { step: 0, state: "done" }) },
    });
    expect(run.value).toEqual([
      "there is nothing to compact before the first turn",
      expect.stringMatching(/^cursor has no compaction of its own: /),
    ]);
  });
});

describe("testWorkflow with effort and set", () => {
  const switching = workflowOf<null, JsonValue>(async (workflow) => {
    const reviewer = await workflow.agents.open({
      key: "reviewer",
      runtime: { alias: "codex", effort: "high" },
    });
    await reviewer.run({ prompt: "Review." });
    await reviewer.set({ model: "gpt-6-luna", effort: "low" });
    await reviewer.run({ prompt: "Summarise." });
    await reviewer.run({ prompt: "Check the fixes." });
    const again = await workflow.agents.open({
      key: "reviewer",
      runtime: { alias: "codex", effort: "high" },
    });
    return { same: again === reviewer, now: reviewer.execution };
  });

  test("each turn runs at the settings in force, and reopening with the original spec returns the agent", async () => {
    const run = await testWorkflow(switching, null, {
      agents: { reviewer: answer("ok") },
    });
    expect(run.value).toEqual({
      same: true,
      now: { harness: "codex", model: "gpt-6-luna", effort: "low", alias: "codex" },
    });
    expect(run.turnsOf("reviewer").map(({ model, effort }) => [model, effort])).toEqual([
      ["gpt-5.6-sol", "high"],
      ["gpt-6-luna", "low"],
      ["gpt-6-luna", "low"],
    ]);
    expect(run.setsOf("reviewer")).toEqual([
      { agent: "reviewer", n: 1, model: "gpt-6-luna", effort: "low" },
    ]);
    expect(run.agentOf("reviewer").execution).toEqual({
      harness: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
      alias: "codex",
    });
  });

  test("a level the harness lacks, and a switch it cannot make, are refused before any turn", async () => {
    const workflow = workflowOf<null, JsonValue>(async (workflow) => {
      const refusal = (promise: Promise<unknown>) =>
        promise.then(
          () => "accepted",
          (error: unknown) => String(error),
        );
      const level = await refusal(
        workflow.agents.open({ key: "a", runtime: { alias: "claude", effort: "ultracode" } }),
      );
      const cursor = await workflow.agents.open({
        key: "b",
        runtime: { harness: "cursor", model: "composer-2.5" },
      });
      return [
        level,
        await refusal(cursor.set({ model: "gpt-5.6-luna-high" })),
        await refusal(cursor.set({ effort: "high" })),
      ];
    });
    const run = await testWorkflow(workflow, null);
    expect(run.value).toEqual([
      'Error: claude has no effort "ultracode"; its levels are low, medium, high, xhigh, max',
      expect.stringContaining("cursor pane agents cannot switch model or effort: not measured"),
      expect.stringContaining("cursor takes no effort: cursor names a model's effort in its id"),
    ]);
    expect(run.turns).toEqual([]);
    expect(run.sets).toEqual([]);
  });
});

/** Each step of a short procedure in the calling session, and how each ended. */
const steps = (prompts: string[], options: { timeoutMs?: number } = {}) =>
  workflowOf<null, JsonValue>(async (workflow): Promise<JsonValue> => {
    const caller = await workflow.agents.caller({ key: "author" });
    if (!caller) return "no caller";
    const ended: JsonValue[] = [];
    for (const prompt of prompts) {
      const { outcome } = await caller.run({
        prompt,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      });
      ended.push(outcome.kind === "answered" ? outcome.value : outcome.kind);
    }
    return ended;
  });

describe("testWorkflow with a calling session", () => {
  test("without one, agents.caller is null", async () => {
    const run = await testWorkflow(steps(["Plan."]), null);
    expect(run.value).toBe("no caller");
    expect(run.agents).toEqual([]);
  });

  test("its turns run under the workflow's key, with the operator's harness and no model", async () => {
    const run = await testWorkflow(steps(["Plan.", "Fix."]), null, {
      caller: { harness: "pi" },
      agents: { author: [answer("planned"), answer("fixed")] },
    });
    expect(run.value).toEqual(["planned", "fixed"]);
    expect(run.agentOf("author").execution).toEqual({ harness: "pi", model: "", caller: true });
    expect(run.turnsOf("author").map((turn) => turn.prompt)).toEqual(["Plan.", "Fix."]);
  });

  test("an interrupted turn is cancelled, not nudged, and the session takes the next", async () => {
    const run = await testWorkflow(steps(["Plan.", "Fix."]), null, {
      caller: { harness: "claude" },
      agents: { author: [reply.interrupted(), answer("fixed")] },
    });
    expect(run.value).toEqual(["cancelled", "fixed"]);
    expect(run.turnsOf("author").map((turn) => turn.nudge)).toEqual([false, false]);
  });

  test("a turn that times out leaves the session usable", async () => {
    let first = true;
    const run = await testWorkflow(steps(["Plan.", "Fix."], { timeoutMs: 200 }), null, {
      caller: { harness: "codex" },
      agents: {
        author: answer(() => {
          if (!first) return "fixed";
          first = false;
          return reply.hang();
        }),
      },
    });
    expect(run.value).toEqual(["timed-out", "fixed"]);
  });

  test("an unanswered turn is nudged where the harness shows an interrupt, and not where it can't", async () => {
    const shows = await testWorkflow(steps(["Plan."]), null, {
      caller: { harness: "claude" },
      agents: { author: answer((turn) => (turn.nudge ? "planned" : reply.silent())) },
    });
    expect(shows.value).toEqual(["planned"]);
    expect(shows.turnsOf("author").map((turn) => turn.nudge)).toEqual([false, true]);
    const hides = await testWorkflow(steps(["Plan."]), null, {
      caller: { harness: "cursor" },
      agents: { author: reply.silent() },
    });
    expect(hides.value).toEqual(["unanswered"]);
    expect(hides.turnsOf("author")).toHaveLength(1);
  });

  test("set is refused: its model and effort are the operator's", async () => {
    const workflow = workflowOf<null, string>(async (workflow) => {
      const caller = await workflow.agents.caller({ key: "author" });
      return caller!.set({ effort: "low" }).then(
        () => "set",
        (error: unknown) => String(error),
      );
    });
    const run = await testWorkflow(workflow, null, { caller: { harness: "claude" } });
    expect(run.value).toBe(
      "Error: agent author is the calling session, whose model and effort are the operator's",
    );
    expect(run.sets).toEqual([]);
  });

  test("one key: the same returns the same ref, another rejects, and so do open and compact", async () => {
    const run = await testWorkflow(
      workflowOf<null, JsonValue>(async (workflow) => {
        const caller = await workflow.agents.caller({ key: "author" });
        const again = await workflow.agents.caller({ key: "author" });
        const attached = await workflow.agents.attach("author");
        const other = await workflow.agents
          .caller({ key: "other" })
          .catch((error) => error.message);
        const opened = await workflow.agents
          .open({ key: "author", runtime: "codex" })
          .catch((error) => error.message);
        await caller!.run({ prompt: "Plan." });
        const compacted = await caller!.compact({
          id: "c1",
          prompt: "keep the plan",
          deadline: { unixMilliseconds: Date.now() + 60_000 },
        });
        return {
          same: caller === again && caller === attached,
          other,
          opened,
          compacted: compacted.kind === "failed" ? compacted.reason : compacted.kind,
        };
      }),
      null,
      { caller: { harness: "claude" }, agents: { author: answer("planned") } },
    );
    expect(run.value).toEqual({
      same: true,
      other: "the calling session is already agent author; it cannot also be other",
      opened: "agent author is the calling session; it is not opened",
      compacted: "the calling session's context is the operator's, so a run does not compact it",
    });
  });

  test("an agent the run opened cannot be scripted as interrupted", async () => {
    await expect(
      testWorkflow(solo(), null, { agents: { solo: reply.interrupted() } }),
    ).rejects.toThrow('agent "solo" turn 1: only the calling session can be interrupted');
  });
});

/** Plans headless, then forks a tester that starts from the plan. */
const forking = workflowOf<{ placement?: "pane" }, JsonValue>(async (workflow, args) => {
  const worker = await workflow.agents.open({
    key: "worker",
    runtime: { alias: "claude", placement: "headless", metered: true },
  });
  await worker.run({ prompt: "Plan a cache.", schema: PLAN });
  const tests = await worker
    .fork({ key: "tests", instructions: "You write the tests.", ...args })
    .catch((error: Error) => error.message);
  if (typeof tests === "string") return tests;
  const status = await tests.run({ prompt: "Test the plan.", schema: STATUS });
  return status.outcome.kind;
});

describe("testWorkflow forks", () => {
  test("a fork is scripted by its own key and recorded with the agent it copied", async () => {
    const run = await testWorkflow(
      forking,
      {},
      {
        agents: {
          worker: [answer(PLAN, { steps: ["a"] })],
          tests: [answer(STATUS, { step: 0, state: "done" })],
        },
      },
    );
    expect(run.value).toBe("answered");
    expect(run.agentOf("tests")).toMatchObject({
      instructions: "You write the tests.",
      execution: run.agentOf("worker").execution,
      forkedFrom: { key: "worker", turns: 1 },
    });
    expect(run.agentOf("worker")).not.toHaveProperty("forkedFrom");
  });

  test("a sandboxed agent's fork runs in its sandbox, a private one too", async () => {
    const sandboxed = workflowOf<null, string>(async (workflow) => {
      const worker = await workflow.agents.open({
        key: "worker",
        runtime: { alias: "codex", placement: "headless" },
        sandbox: { srt: {} },
      });
      await worker.run({ prompt: "Plan a cache.", schema: PLAN });
      const tests = await worker.fork({ key: "tests" });
      return (await tests.run({ prompt: "Test the plan.", schema: STATUS })).outcome.kind;
    });
    const run = await testWorkflow(sandboxed, null, {
      agents: {
        worker: [answer(PLAN, { steps: ["a"] })],
        tests: [answer(STATUS, { step: 0, state: "done" })],
      },
    });
    expect(run.value).toBe("answered");
    expect(run.agentOf("tests").sandbox).toEqual(run.agentOf("worker").sandbox);
    expect(run.agentOf("tests").forkedFrom).toEqual({ key: "worker", turns: 1 });
  });

  test("a headless agent forks into a pane, which continues its copy", async () => {
    const run = await testWorkflow(
      forking,
      { placement: "pane" },
      {
        agents: {
          worker: [answer(PLAN, { steps: ["a"] })],
          tests: [answer(STATUS, { step: 0, state: "done" })],
        },
      },
    );
    expect(run.value).toBe("answered");
    expect(run.agentOf("tests").execution).toEqual({
      harness: run.agentOf("worker").execution.harness,
      model: run.agentOf("worker").execution.model,
      alias: "claude",
    });
  });
});
