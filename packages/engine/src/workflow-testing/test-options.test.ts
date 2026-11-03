import { describe, expect, test } from "bun:test";
import { MAILBOX_RECORD_VERSION, type MailboxRecord } from "@agentswf/contract/records";
import { defineWorkflow, type Workflow } from "@agentswf/contract/workflow";
import { caseRun, DOC } from "../testing";
import { answer, testWorkflow } from ".";

const greet = defineWorkflow<{ name: string }, string>({
  meta: { name: "greet", description: "Greets one name." },
  prepare: ({ argv }) => ({ name: argv[0] ?? "nobody" }),
  run: async (wf, { name }) => `hi ${name} in ${wf.runId}`,
});

/** Starts `n` turns of one agent, one after another. */
const turns = (n: number) =>
  defineWorkflow({
    meta: { name: "turns", description: "One agent, n turns." },
    run: async (wf) => {
      const agent = await wf.agents.open({ key: "a", runtime: "claude" });
      for (let i = 0; i < n; i += 1) await agent.run({ prompt: `Step ${i}.` });
      return n;
    },
  });

describe("testWorkflow(workflow, options?)", () => {
  test("args are an option, and absent, the run gets what prepare makes of none, as test", async () => {
    expect((await testWorkflow(greet, { args: { name: "ada" } })).value).toBe("hi ada in test");
    const unargued = greet as unknown as Workflow<{ name: string } | null, string>;
    expect((await testWorkflow(unargued)).value).toBe("hi nobody in test");
    expect((await testWorkflow(greet, { args: { name: "ada" }, id: "r-1" })).value).toBe(
      "hi ada in r-1",
    );
  });

  test("a misspelled option fails the test, naming it", async () => {
    await expect(testWorkflow(turns(1), { agnets: { a: answer("ok") } } as never)).rejects.toThrow(
      'testWorkflow has no option "agnets"',
    );
    await expect(
      testWorkflow(turns(1), { agents: { a: answer("ok") }, earlier: { stage: {} } } as never),
    ).rejects.toThrow('earlier has no "stage"');
  });

  test("a workflow's object args given second are options, and refused by their first key", async () => {
    await expect(testWorkflow(greet, { name: "ada" } as never)).rejects.toThrow(
      'testWorkflow has no option "name"',
    );
  });

  test("a workflow without events is given no event", async () => {
    await expect(
      testWorkflow(turns(0), { event: { name: "x", data: null } } as never),
    ).rejects.toThrow("event is an option for a workflow with events, and turns declares none");
  });

  test("a workflow with events given args second is refused: that form was never its own", async () => {
    const withEvents = caseRun(async () => null);
    for (const args of [null, "x"])
      await expect(testWorkflow(withEvents, args as never)).rejects.toThrow(
        "a workflow with events is tested as testWorkflow(workflow, { id, event? })",
      );
  });

  test("meta and run alone are refused: the one form tests what defineWorkflow made", async () => {
    const bare = { meta: { name: "bare", description: "bare" }, run: async () => "ran" };
    await expect(testWorkflow(bare as never)).rejects.toThrow("define it with defineWorkflow");
  });

  test("maxTurns fails a run without events that starts one turn too many", async () => {
    const agents = { a: answer("ok") };
    expect((await testWorkflow(turns(3), { agents, maxTurns: 3 })).value).toBe(3);
    await expect(testWorkflow(turns(4), { agents, maxTurns: 3 })).rejects.toThrow(
      "the run started more than 3 turns (maxTurns)",
    );
  });
});

describe("earlier", () => {
  const event = (id: string, name: string): MailboxRecord => ({
    version: MAILBOX_RECORD_VERSION,
    at: new Date().toISOString(),
    kind: "event",
    id,
    name: "dd.changes",
    data: { case: name },
    from: "operator",
  });
  /** Plans in a stage, then takes what the mailbox holds. */
  const planned = (ran: string[]) =>
    caseRun(async (wf) => {
      const plan = await wf.stage("plan", { result: DOC }, async () => {
        ran.push("plan");
        return { path: "new.md" };
      });
      const taken = await wf.receive();
      return { plan, taken: taken.map((e) => e.id) };
    });

  test("a test continues an attempt's stages and mailbox, reusing both", async () => {
    const ran: string[] = [];
    const run = await testWorkflow(planned(ran), {
      earlier: { stages: { plan: { path: "old.md" } }, mailbox: [event("e-1", "kombo")] },
    });
    expect(run.value).toEqual({ plan: { path: "old.md" }, taken: ["e-1"] });
    expect(ran).toEqual([]);
  });

  test("fromStage on a workflow with events redoes the stage of an earlier attempt", async () => {
    const ran: string[] = [];
    const run = await testWorkflow(planned(ran), {
      earlier: { stages: { plan: { path: "old.md" } }, mailbox: [event("e-1", "kombo")] },
      fromStage: "plan",
    });
    expect(run.value).toEqual({ plan: { path: "new.md" }, taken: ["e-1"] });
    expect(ran).toEqual(["plan"]);
    await expect(testWorkflow(planned([]), { fromStage: "plan" })).rejects.toThrow(
      "takes fromStage only with earlier",
    );
  });

  test("an earlier form given with its deprecated one is refused", async () => {
    await expect(
      testWorkflow(planned([]), {
        earlier: { stages: { plan: { path: "old.md" } } },
        recorded: { plan: { path: "old.md" } },
      }),
    ).rejects.toThrow("give earlier.stages alone");
    await expect(
      testWorkflow(planned([]), { earlier: { mailbox: [] }, mailbox: [] }),
    ).rejects.toThrow("give earlier.mailbox alone");
  });

  test("an earlier given at all is the continue, attempt 2, empty or not", async () => {
    const ran: string[] = [];
    const run = await testWorkflow(planned(ran), {
      earlier: {},
      fromStage: "plan",
    });
    expect(run.ending).toMatchObject({ kind: "parked" });
    expect(ran).toEqual(["plan"]);
    const attempt = defineWorkflow({
      meta: { name: "attempt", description: "Says which attempt it is." },
      run: async (wf) => {
        const plan = await wf.stage("plan", { result: DOC }, async () => ({ path: "new.md" }));
        return [wf.attempt, plan.path];
      },
    });
    expect(
      (await testWorkflow(attempt, { earlier: { stages: { plan: { path: "old.md" } } } })).value,
    ).toEqual([2, "old.md"]);
    expect((await testWorkflow(attempt, { earlier: { stages: undefined } })).value).toEqual([
      2,
      "new.md",
    ]);
  });

  test("a workflow with events takes no values; a plain one takes fromStage alone", async () => {
    await expect(
      testWorkflow(planned([]), {
        earlier: {},
        fromStage: "plan",
        values: { plan: { path: "a.md" } },
      }),
    ).rejects.toThrow("a run of a workflow with events takes no values");
    const staged = defineWorkflow({
      meta: { name: "staged", description: "Two stages." },
      run: async (wf) => {
        const plan = await wf.stage("plan", { result: DOC }, async () => ({ path: "new.md" }));
        const built = await wf.stage("build", { result: DOC }, async () => ({ path: plan.path }));
        return [wf.attempt, built.path];
      },
    });
    const run = await testWorkflow(staged, {
      fromStage: "build",
      values: { plan: { path: "given.md" } },
    });
    expect(run.value).toEqual([1, "given.md"]);
  });
});

describe("prepare, when no args are given", () => {
  const preparing = (prepare: () => unknown) =>
    defineWorkflow<{ n: number } | null, string>({
      meta: { name: "preparing", description: "Prepares." },
      prepare: prepare as () => { n: number },
      run: async () => "ran",
    });

  test("what it makes is checked as awf run checks it, and a refusal says to give args", async () => {
    await expect(testWorkflow(preparing(() => new Date()))).rejects.toThrow(
      /preparing arguments must contain only JSON values; give args/,
    );
    await expect(testWorkflow(preparing(() => Promise.resolve({ n: 1 })))).rejects.toThrow(
      /must contain only JSON values; give args/,
    );
    await expect(
      testWorkflow(
        preparing(() => {
          throw new Error("takes one path");
        }),
      ),
    ).rejects.toThrow(/prepare of none failed: takes one path; give args/);
  });
});

describe("the options", () => {
  test("are an object literal: a Date or a class's instance is refused, named", async () => {
    await expect(testWorkflow(turns(0), new Date() as never)).rejects.toThrow(
      "testWorkflow's options are an object literal, not a Date",
    );
    class Options {
      agents = {};
    }
    await expect(testWorkflow(turns(0), new Options() as never)).rejects.toThrow("not a Options");
  });

  test("object args given second to meta and run alone are refused by their key first", async () => {
    const bare = { meta: { name: "bare", description: "bare" }, run: async () => "ran" };
    await expect(testWorkflow(bare as never, { target: "x" } as never)).rejects.toThrow(
      `testWorkflow has no option "target"`,
    );
    await expect(testWorkflow(bare as never, { target: "x" } as never)).rejects.toThrow(
      "a workflow's args are given as { args }",
    );
  });
});
