import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { JsonSchema } from "@agentswf/contract/schema";
import { WIRE_VERSION } from "@agentswf/contract/wire";
import {
  type AgentRef,
  type AgentTools,
  type EventAgentRef,
  isAnswered,
  type JsonObject,
  type JsonValue,
  type OutputSchema,
  type StartedTurn,
  tool,
  type WorkflowContext,
  type WorkflowDefinition,
} from "@agentswf/contract/workflow";
import { createSingleSessionHostFactory } from "@agentswf/harness";
import type { AgentRuntimeConfig, AgentSessionAdapter } from "@agentswf/harness/adapter";
import { createFakeAdapter, type FakeAdapterTurnContext } from "@agentswf/harness/testing";
import Type from "typebox";
import { messageOf } from "./errors";
import { logsCommand } from "./logs-command";
import { readTurns } from "./runs";
import { caseRun, createTempRunDirs, exchange, future, runNew, startCase } from "./testing";
import { ToolCalls, toolsLesson } from "./tools";
import { answer, testWorkflow } from "./workflow-testing";

const runDirs = createTempRunDirs();
afterAll(() => runDirs.cleanup());

const CLOSE: OutputSchema<{ id: string; status: "done" | "wontfix"; why?: string }> = {
  type: "object",
  properties: {
    id: { type: "string", minLength: 1 },
    status: {
      anyOf: [
        { type: "string", const: "done" },
        { type: "string", const: "wontfix" },
      ],
    },
    why: { type: "string" },
  },
  required: ["id", "status"],
};

const TEXT: OutputSchema<string> = { type: "string" };

type Ran = { exitCode: number; stdout: string; stderr: string };

/** The launcher the turn's prompt names, run as the agent's shell would, with no environment. */
async function wf(launcher: string, args: readonly string[], stdin?: string): Promise<Ran> {
  const child = Bun.spawn([launcher, ...args], {
    env: {},
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout: stdout.trimEnd(), stderr: stderr.trimEnd() };
}

/** The launcher's full path, from the result line, or a message turn's routes lesson. */
function launcherOf(context: FakeAdapterTurnContext): string {
  const path = /(\/\S+\/wf) (?:result|send|reply|peers)/.exec(context.prompt)?.[1];
  if (!path) throw new Error(`no launcher in the prompt: ${context.prompt}`);
  return path;
}

function callIdOf(context: FakeAdapterTurnContext): string {
  const line = context.prompt.split("return it by running:\n\n")[1]!.split("\n")[0]!;
  return line.split(" result ")[1]!.split(" ")[0]!;
}

/**
 * One agent with `tools`, whose turn runs `act` with its launcher, then answers "done" unless
 * `act` answered. What `act` saw comes back as the run's value.
 */
async function withTools(
  tools: AgentTools,
  act: (
    wf: (args: readonly string[], stdin?: string) => Promise<Ran>,
    context: FakeAdapterTurnContext,
  ) => Promise<unknown>,
  options: {
    prompt?: string;
    around?: (agent: AgentRef, context: WorkflowContext) => Promise<unknown>;
  } = {},
): Promise<{ seen: unknown; value: unknown }> {
  let seen: unknown;
  const adapter = createFakeAdapter({
    script: (context) => ({
      act: async () => {
        const launcher = launcherOf(context);
        seen = await act((args, stdin) => wf(launcher, args, stdin), context);
        await wf(launcher, ["result", callIdOf(context)], '"done"');
      },
    }),
  });
  const workflow: WorkflowDefinition<null, null> = {
    meta: { name: "tools", description: "tools" },
    async run(context) {
      const agent = await context.agents.open({ key: "triager", runtime: "fake", tools });
      if (options.around) await options.around(agent, context);
      else
        await agent.run({
          prompt: options.prompt ?? "work",
          schema: TEXT,
          deadline: future(),
          nudge: false,
        });
      return null;
    },
  };
  const result = await runNew(workflow, null, {
    runRoot: runDirs.tempRunDir(),
    deadline: future(),
    runtime: runtime(adapter),
  });
  return { seen, value: result.value };
}

function runtime(adapter: AgentSessionAdapter): AgentRuntimeConfig {
  return {
    aliases: { fake: { harness: "fake", model: "fake" } },
    host: createSingleSessionHostFactory(adapter),
  };
}

describe("a tool call", () => {
  test("runs the handler once with the flags read by its schema, and prints its result", async () => {
    const calls: JsonObject[] = [];
    const { seen } = await withTools(
      {
        close: tool({
          description: "Close an item.",
          input: CLOSE,
          handler: (input, call) => {
            calls.push({ ...input, agent: call.agent });
            return `Closed ${input.id}.`;
          },
        }),
      },
      (wf) => wf(["tool", "close", "--id", "a1", "--status", "done", "--why", "it's $HOME"]),
    );
    expect(seen).toEqual({ exitCode: 0, stdout: "Closed a1.", stderr: "" });
    expect(calls).toEqual([{ id: "a1", status: "done", why: "it's $HOME", agent: "triager" }]);
  });

  test("JSON on standard input, a JSON result, and nothing returned print as the design says", async () => {
    const { seen } = await withTools(
      {
        close: tool({ description: "Close.", input: CLOSE, handler: () => ({ closed: true }) }),
        list: tool({
          description: "List.",
          handler: (input) => (Object.keys(input).length === 0 ? undefined : "x"),
        }),
      },
      async (wf) => [
        await wf(["tool", "close"], '{"id":"a1","status":"wontfix"}'),
        await wf(["tool", "list"]),
      ],
    );
    expect(seen).toEqual([
      { exitCode: 0, stdout: '{"closed":true}', stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
    ]);
  });

  test("bad calls are refused, exit 3, and run no handler", async () => {
    let ran = 0;
    const { seen } = await withTools(
      {
        close: tool({ description: "Close.", input: CLOSE, handler: () => void ran++ }),
        list: tool({ description: "List.", handler: () => void ran++ }),
      },
      async (wf) => {
        const answers: Ran[] = [];
        for (const [args, stdin] of [
          [["tool", "open_it"]],
          [["tool", "close", "--id", "a1", "--status", "maybe"]],
          [["tool", "close", "--id", "a1"]],
          [["tool", "close"], "not json"],
          [["tool", "close"], "[1]"],
          [["tool", "list", "--now", "1"]],
        ] as [string[], string?][])
          answers.push(await wf(args, stdin));
        return answers;
      },
    );
    const answers = seen as Ran[];
    expect(answers.map((each) => each.exitCode)).toEqual([3, 3, 3, 3, 3, 3]);
    expect(answers[0]!.stderr).toContain(
      "open_it refused (unknown-tool): you have no tool named open_it; yours: close, list",
    );
    expect(answers[1]!.stderr).toContain("(invalid-input)");
    expect(answers[1]!.stderr).toContain(
      "expected: --id <text, at least 1 character> --status done|wontfix [--why <text>]",
    );
    expect(answers[2]!.stderr).toContain("value.status: required property is missing");
    expect(answers[5]!.stderr).toContain("list takes no input; call it with its name alone");
    expect(ran).toBe(0);
  });

  test("a handler that throws or returns what isn't JSON fails the call, exit 1, and the run goes on", async () => {
    const { seen, value } = await withTools(
      {
        boom: tool({
          description: "Throws.",
          handler: () => {
            throw new Error("the backlog is locked");
          },
        }),
        date: tool({ description: "A Date.", handler: () => new Date() as never }),
      },
      async (wf) => [await wf(["tool", "boom"]), await wf(["tool", "date"])],
    );
    const [boom, date] = seen as Ran[];
    expect(boom!.exitCode).toBe(1);
    expect(boom!.stderr).toContain("the backlog is locked");
    expect(date!.exitCode).toBe(1);
    expect(date!.stderr).toContain("isn't JSON");
    expect(value).toBeNull();
  });

  test("the same call made again while it runs joins it once; another is refused tool-busy, and wf result tool-running", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = Promise.withResolvers<void>();
    let ran = 0;
    const ID: OutputSchema<{ id: string }> = {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    };
    const { seen } = await withTools(
      {
        slow: tool({
          description: "Slow.",
          input: ID,
          handler: async ({ id }) => {
            ran += 1;
            entered.resolve();
            await held;
            return `late ${id}`;
          },
        }),
      },
      async (wf, context) => {
        const first = wf(["tool", "slow", "--id", "a1"]);
        await entered.promise;
        const other = await wf(["tool", "slow", "--id", "b2"]);
        // The same input, sent as JSON this time.
        const again = wf(["tool", "slow"], '{ "id": "a1" }');
        const third = wf(["tool", "slow", "--id=a1"]);
        // Whichever of the two came second is refused, which ends it before the handler can.
        const refused = await Promise.race([again, third]);
        const result = await wf(["result", callIdOf(context)], '"early"');
        release();
        const joined = refused === (await again) ? await third : await again;
        return [await first, joined, other, refused, result];
      },
    );
    const [first, joined, other, refused, result] = seen as Ran[];
    expect(first).toEqual({ exitCode: 0, stdout: "late a1", stderr: "" });
    expect(joined).toEqual(first!);
    expect(ran).toBe(1);
    for (const busy of [other!, refused!]) {
      expect(busy.exitCode).toBe(3);
      expect(busy.stderr).toContain("(tool-busy): your call of slow is still running; wait for it");
    }
    expect(result!.exitCode).toBe(1);
    expect(result!.stderr).toContain("tool-running");
  });

  test("past its budget the signal aborts and wf tool exits 4, saying it may have run", async () => {
    let aborted = false;
    const { seen } = await withTools(
      {
        stuck: tool({
          description: "Waits for its signal.",
          timeoutMs: 100,
          handler: (_input, call) =>
            new Promise((resolve) => {
              call.signal.addEventListener("abort", () => {
                aborted = true;
                resolve("too late");
              });
            }),
        }),
      },
      (wf) => wf(["tool", "stuck"]),
    );
    expect(aborted).toBe(true);
    expect(seen).toMatchObject({ exitCode: 4, stdout: "" });
    expect((seen as Ran).stderr).toContain("stuck didn't answer in time (0.1 s); it may have run");
  });

  test("a call after the result is accepted is refused, and one after the turn has no operation", async () => {
    let launcher = "";
    const { seen } = await withTools(
      { list: tool({ description: "List.", handler: () => "x" }) },
      async (wf, context) => {
        launcher = launcherOf(context);
        await wf(["result", callIdOf(context)], '"done"');
        return wf(["tool", "list"]);
      },
      {
        around: async (agent) => {
          await agent.run({ prompt: "work", schema: TEXT, deadline: future(), nudge: false });
          const after = await wf(launcher, ["tool", "list"]);
          expect(after.exitCode).toBe(3);
          expect(after.stderr).toContain("(no-operation)");
        },
      },
    );
    expect((seen as Ran).exitCode).toBe(3);
    expect((seen as Ran).stderr).toContain("(result-accepted)");
  });
});

describe("a handler", () => {
  test("can't give work to the agent it was called by, but can run another", async () => {
    let own = "";
    const adapter = createFakeAdapter({
      script: (context) => ({
        act: async () => {
          const launcher = launcherOf(context);
          if (context.activation.key === "triager") await wf(launcher, ["tool", "ask"]);
          await wf(launcher, ["result", callIdOf(context)], '"done"');
        },
      }),
    });
    const workflow: WorkflowDefinition<null, string> = {
      meta: { name: "nested", description: "nested" },
      async run(context) {
        const helper = await context.agents.open({ key: "helper", runtime: "fake" });
        const triager: AgentRef = await context.agents.open({
          key: "triager",
          runtime: "fake",
          tools: {
            ask: tool({
              description: "Ask.",
              handler: async () => {
                own = await triager.run({ prompt: "self", schema: TEXT, deadline: future() }).then(
                  () => "ran",
                  (error: Error) => error.message,
                );
                const other = await helper.run({
                  prompt: "help",
                  schema: TEXT,
                  deadline: future(),
                  nudge: false,
                });
                return other.outcome.kind;
              },
            }),
          },
        });
        const outcome = await triager.run({
          prompt: "work",
          schema: TEXT,
          deadline: future(),
          nudge: false,
        });
        return outcome.outcome.kind;
      },
    };
    const result = await runNew(workflow, null, {
      runRoot: runDirs.tempRunDir(),
      deadline: future(),
      runtime: runtime(adapter),
    });
    expect(result.value).toBe("answered");
    expect(own).toContain("agent-in-tool");
  });
});

describe("tools on a spec", () => {
  const typed = (description: string) =>
    tool({ description, input: CLOSE, handler: () => description });

  test("over a limit, they are refused at open", async () => {
    const workflow: WorkflowDefinition<null, string[]> = {
      meta: { name: "limits", description: "limits" },
      async run(context) {
        const refusals: string[] = [];
        const tries: AgentTools[] = [
          { "Bad-Name": typed("x") },
          Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`t${i}`, typed("x")])),
          { long: typed("x".repeat(1025)) },
          { scalar: { description: "x", input: { type: "string" }, handler: () => "x" } as never },
          { slow: { ...typed("x"), timeoutMs: 0 } },
        ];
        for (const [index, tools] of tries.entries()) {
          await context.agents.open({ key: `a${index}`, runtime: "fake", tools }).then(
            () => refusals.push("opened"),
            (error: Error) => refusals.push(error.message),
          );
        }
        return refusals;
      },
    };
    const result = await runNew(workflow, null, {
      runRoot: runDirs.tempRunDir(),
      deadline: future(),
      runtime: runtime(createFakeAdapter({ script: () => ({}) })),
    });
    expect(result.value).toEqual([
      expect.stringContaining("a tool's name matches"),
      expect.stringContaining("at most 16"),
      expect.stringContaining("over 1024 bytes"),
      expect.stringContaining("must be an object"),
      expect.stringContaining("timeoutMs is a positive integer, or false"),
    ]);
  });

  test("a reopen with matching tools takes the new handlers; different tools conflict; none keeps them", async () => {
    const said: string[] = [];
    const adapter = createFakeAdapter({
      script: (context) => ({
        act: async () => {
          const launcher = launcherOf(context);
          said.push(
            (await wf(launcher, ["tool", "close", "--id", "a", "--status", "done"])).stdout,
          );
          await wf(launcher, ["result", callIdOf(context)], '"done"');
        },
      }),
    });
    const json = JSON.parse(JSON.stringify(CLOSE)) as typeof CLOSE;
    const workflow: WorkflowDefinition<null, string> = {
      meta: { name: "reopen", description: "reopen" },
      async run(context) {
        const open = (tools?: AgentTools) =>
          context.agents.open({ key: "triager", runtime: "fake", ...(tools ? { tools } : {}) });
        const run = async (agent: AgentRef) =>
          agent.run({ prompt: "work", schema: TEXT, deadline: future(), nudge: false });
        await run(await open({ close: typed("first") }));
        // The same schema written as plain JSON Schema, keys in another order, matches.
        await run(
          await open({
            close: tool({
              description: "first",
              input: { ...json, required: ["status", "id"] },
              handler: () => "second",
            }),
          }),
        );
        await run(await open());
        return open({ close: typed("other") }).then(
          () => "opened",
          (error: Error) => error.message,
        );
      },
    };
    const result = await runNew(workflow, null, {
      runRoot: runDirs.tempRunDir(),
      deadline: future(),
      runtime: runtime(adapter),
    });
    expect(said).toEqual(["first", "second", "second"]);
    expect(result.value).toBe("agent triager is already open with different tools");
  });

  test("a fork has its parent's tools, called as itself; its own replace them, and {} gives none", async () => {
    const said: string[] = [];
    const adapter = createFakeAdapter({
      continues: true,
      forks: () => true,
      script: (context) => ({
        act: async () => {
          const launcher = launcherOf(context);
          const answer = await wf(launcher, ["tool", "who"]);
          said.push(
            `${context.activation.key}: ${answer.stdout || answer.stderr.split("\n").at(-1)}`,
          );
          await wf(launcher, ["result", callIdOf(context)], '"done"');
        },
      }),
    });
    const who = (prefix: string) =>
      tool({ description: "Who calls.", handler: (_input, call) => `${prefix} ${call.agent}` });
    const workflow: WorkflowDefinition<null, null> = {
      meta: { name: "forks", description: "forks" },
      async run(context) {
        const parent = await context.agents.open({
          key: "parent",
          runtime: "fake",
          tools: { who: who("parent's") },
        });
        const run = (agent: AgentRef) =>
          agent.run({ prompt: "work", schema: TEXT, deadline: future(), nudge: false });
        await run(parent);
        await run(await parent.fork({ key: "inherits" }));
        await run(await parent.fork({ key: "own", tools: { who: who("own") } }));
        await run(await parent.fork({ key: "none", tools: {} }));
        return null;
      },
    };
    await runNew(workflow, null, {
      runRoot: runDirs.tempRunDir(),
      deadline: future(),
      runtime: runtime(adapter),
    });
    expect(said).toEqual([
      "parent: parent's parent",
      "inherits: parent's inherits",
      "own: own own",
      expect.stringContaining("none: wf: who refused (unknown-tool)"),
    ]);
  });
});

describe("a call in a message turn, and at an operation's end", () => {
  test("a message turn's call runs; one still running when it ends is stopped and waited for", async () => {
    const order: string[] = [];
    const stuckEntered = Promise.withResolvers<void>();
    const adapter = createFakeAdapter({
      script: (context) => ({
        act: async () => {
          const launcher = launcherOf(context);
          if (context.activation.key === "asker") {
            await wf(launcher, ["send", "peer", "go"]);
            await wf(launcher, ["result", callIdOf(context)], '"done"');
            return;
          }
          if (context.kind !== "turn" || context.prompt.includes("return it by running")) {
            order.push("peer's next turn");
            await wf(launcher, ["result", callIdOf(context)], '"done"');
            return;
          }
          order.push((await wf(launcher, ["tool", "quick"])).stdout);
          // Left running as the turn ends, as a command backgrounded by its harness would be.
          void wf(launcher, ["tool", "stuck"]).then((ran) =>
            order.push(`stuck exited ${ran.exitCode}`),
          );
          await stuckEntered.promise;
        },
      }),
    });
    const workflow: WorkflowDefinition<null, null> = {
      meta: { name: "message-turn", description: "message-turn" },
      async run(context) {
        const asker = await context.agents.open({ key: "asker", runtime: "fake" });
        const peer = await context.agents.open({
          key: "peer",
          runtime: "fake",
          tools: {
            quick: tool({ description: "Quick.", handler: () => "quick answered" }),
            stuck: tool({
              description: "Stuck until stopped.",
              timeoutMs: false,
              handler: (_input, call) =>
                new Promise((resolve) => {
                  stuckEntered.resolve();
                  call.signal.addEventListener("abort", () => {
                    order.push(`stuck aborted: ${call.signal.reason?.message}`);
                    resolve(null);
                  });
                }),
            }),
          },
        });
        await context.messages.allow({ from: asker, to: peer, purpose: "Ask." });
        await asker.run({ prompt: "Ask.", schema: TEXT, deadline: future(), nudge: false });
        // Queued while its message turn still has the call running.
        await stuckEntered.promise;
        await peer.run({ prompt: "Next.", schema: TEXT, deadline: future(), nudge: false });
        return null;
      },
    };
    await runNew(workflow, null, {
      runRoot: runDirs.tempRunDir(),
      deadline: future(),
      runtime: runtime(adapter),
    });
    expect(order.slice(0, 2)).toEqual([
      "quick answered",
      "stuck aborted: the tool call was cancelled",
    ]);
    expect(order.indexOf("stuck aborted: the tool call was cancelled")).toBeLessThan(
      order.indexOf("peer's next turn"),
    );
    expect(order).toContain("stuck exited 4");
  });

  test("a handler that ignores its aborted signal is settled 5 s later, and run() resolves after", async () => {
    let answered: Ran | undefined;
    const started = Date.now();
    await withTools(
      {
        never: tool({
          description: "Never answers.",
          timeoutMs: 200,
          handler: () => new Promise(() => {}),
        }),
      },
      async (wf) => {
        answered = await wf(["tool", "never"]);
      },
    );
    expect(answered?.exitCode).toBe(4);
    expect(Date.now() - started).toBeGreaterThanOrEqual(5_000);
  }, 15_000);

  test("a deadline shorter than the budget wins, and timeoutMs: false is bounded by it alone", async () => {
    const { seen } = await withTools(
      {
        slow: tool({
          description: "Slow.",
          timeoutMs: false,
          handler: async (_input, call) => {
            await new Promise((resolve) => call.signal.addEventListener("abort", resolve));
            return "stopped";
          },
        }),
      },
      (wf) => wf(["tool", "slow"]),
      {
        around: async (agent) => {
          await agent.run({ prompt: "work", schema: TEXT, timeoutMs: 1_500, nudge: false });
        },
      },
    );
    expect(seen).toMatchObject({ exitCode: 4 });
    expect((seen as Ran).stderr).toContain(
      "slow didn't answer before your turn's deadline; it may have run",
    );
  }, 15_000);

  test("a handler runs in its operation's stage", async () => {
    const runRoot = runDirs.tempRunDir();
    const adapter = createFakeAdapter({
      script: (context) => ({
        act: async () => {
          const launcher = launcherOf(context);
          if (context.activation.key === "triager") await wf(launcher, ["tool", "help"]);
          await wf(launcher, ["result", callIdOf(context)], '"done"');
        },
      }),
    });
    const workflow: WorkflowDefinition<null, null> = {
      meta: { name: "staged", description: "staged" },
      async run(context) {
        const helper = await context.agents.open({ key: "helper", runtime: "fake" });
        const triager = await context.agents.open({
          key: "triager",
          runtime: "fake",
          tools: {
            help: tool({
              description: "Help.",
              handler: async () =>
                (await helper.run({ prompt: "help", schema: TEXT, nudge: false })).outcome.kind,
            }),
          },
        });
        await context.stage("triage", async () => {
          await triager.run({ prompt: "work", schema: TEXT, nudge: false });
        });
        return null;
      },
    };
    const result = await runNew(workflow, null, {
      runRoot,
      deadline: future(),
      runtime: runtime(adapter),
    });
    const turns = await readTurns(join(runRoot, "staged", result.runId));
    expect(turns.map((turn) => [turn.agent, turn.stage])).toEqual([
      ["helper", "triage"],
      ["triager", "triage"],
    ]);
  });
});

describe("the calling session's forks", () => {
  test("take no tools, by forkCaller or by caller()'s ref", async () => {
    const config = runtime(
      createFakeAdapter({ continues: true, forks: () => true, script: () => ({}) }),
    );
    config.host = { ...config.host, caller: { harness: "fake", cwd: process.cwd() } };
    const tools = { list: tool({ description: "List.", handler: () => "x" }) };
    const workflow: WorkflowDefinition<null, string[]> = {
      meta: { name: "caller-forks", description: "caller-forks" },
      async run(context) {
        const caller = (await context.agents.caller({ key: "author" }))!;
        const refusals: string[] = [];
        for (const fork of [
          () => caller.fork({ key: "by-ref", tools }),
          () => context.agents.forkCaller({ key: "by-fork-caller", tools } as never),
        ]) {
          await fork().then(
            () => refusals.push("forked"),
            (error: Error) => refusals.push(error.message),
          );
        }
        return refusals;
      },
    };
    const result = await runNew(workflow, null, {
      runRoot: runDirs.tempRunDir(),
      deadline: future(),
      runtime: config,
    });
    expect(result.value).toEqual([
      expect.stringContaining("a fork of the calling session takes no tools"),
      expect.stringContaining("a fork of the calling session takes no tools"),
    ]);
  });
});

describe("ToolCalls", () => {
  const spec = {
    slow: tool({
      description: "Slow.",
      timeoutMs: false,
      handler: (_i, call) =>
        new Promise((resolve) => call.signal.addEventListener("abort", () => resolve("late"))),
    }),
  };
  const operation = {
    id: "op-1",
    agent: "a",
    callPath: [],
    scope: undefined,
    deadline: () => undefined,
  };

  test("a record it can't write is an internal error, which wf tool reads as unknown", async () => {
    let writes = 0;
    const calls = new ToolCalls<undefined>({
      record: async () => ++writes === 1,
      runIn: (_scope, fn) => fn(),
    });
    calls.give("a", { list: tool({ description: "List.", handler: () => "x" }) });
    calls.opened(operation);
    expect(await calls.call("a", { version: 5, command: "tool", tool: "list" }, () => {})).toEqual({
      kind: "refused",
      code: "internal-error",
      error: expect.stringContaining("its end couldn't be recorded; check what it did"),
    });
  });

  test("an input of no properties is no input: the name alone, and taught that way", async () => {
    const calls = new ToolCalls<undefined>({
      record: async () => true,
      runIn: (_scope, fn) => fn(),
    });
    calls.give("a", {
      ping: tool({ description: "Ping.", input: Type.Object({}), handler: () => "pong" }),
    });
    calls.opened(operation);
    calls.give("b", {
      bag: tool({
        description: "Any JSON.",
        input: Type.Object({}, { additionalProperties: true }),
        handler: (input) => JSON.stringify(input),
      }),
    });
    expect(calls.taught("b")[0]?.input).toEqual({
      type: "object",
      properties: {},
      additionalProperties: true,
    });
    expect(calls.taught("a")).toEqual([{ name: "ping", description: "Ping." }]);
    expect(await calls.call("a", { version: 5, command: "tool", tool: "ping" }, () => {})).toEqual({
      kind: "tool-result",
      output: "pong",
    });
  });

  test("a call whose deadline has already passed doesn't run its handler", async () => {
    let ran = false;
    const calls = new ToolCalls<undefined>({
      record: async () => true,
      runIn: (_scope, fn) => fn(),
    });
    calls.give("a", {
      late: tool({
        description: "Late.",
        handler: () => {
          ran = true;
        },
      }),
    });
    calls.opened({ ...operation, deadline: () => Date.now() - 1 });
    expect(await calls.call("a", { version: 5, command: "tool", tool: "late" }, () => {})).toEqual({
      kind: "tool-failed",
      outcome: "timed-out",
      error: "late wasn't run: its time was up first",
    });
    expect(ran).toBe(false);
  });

  test("a budget weeks away doesn't overflow its timer", async () => {
    const calls = new ToolCalls<undefined>({
      record: async () => true,
      runIn: (_scope, fn) => fn(),
    });
    const lifetimes: (number | undefined)[] = [];
    calls.give("a", {
      far: tool({
        description: "Far.",
        timeoutMs: 30 * 24 * 3_600_000,
        handler: () => Bun.sleep(50).then(() => "in time"),
      }),
    });
    calls.opened(operation);
    expect(
      await calls.call("a", { version: 5, command: "tool", tool: "far" }, (ms) =>
        lifetimes.push(ms),
      ),
    ).toEqual({ kind: "tool-result", output: "in time" });
    expect(lifetimes[0]).toBeGreaterThan(2_147_483_647);
  });

  test("a call that arrives once its operation is stopped isn't run", async () => {
    let ran = false;
    const calls = new ToolCalls<undefined>({
      record: async () => true,
      runIn: (_scope, fn) => fn(),
    });
    calls.give("a", {
      list: tool({
        description: "List.",
        handler: () => {
          ran = true;
        },
      }),
    });
    calls.opened(operation);
    calls.abort("op-1", "cancelled");
    expect(
      await calls.call("a", { version: 5, command: "tool", tool: "list" }, () => {}),
    ).toMatchObject({
      kind: "refused",
      code: "no-operation",
    });
    expect(ran).toBe(false);
  });

  test("an operation's end cancels its running call and waits for it to settle", async () => {
    const recorded: string[] = [];
    const calls = new ToolCalls<undefined>({
      record: async (event) => {
        recorded.push(`${event.kind}${"outcome" in event ? ` ${event.outcome}` : ""}`);
        return true;
      },
      runIn: (_scope, fn) => fn(),
    });
    calls.give("a", spec);
    calls.opened(operation);
    const answer = calls.call("a", { version: 5, command: "tool", tool: "slow" }, () => {});
    await Bun.sleep(10);
    expect(calls.running("a")).toEqual({ tool: "slow" });
    await calls.ended("op-1");
    expect(calls.running("a")).toBeUndefined();
    expect(await answer).toMatchObject({ kind: "tool-failed", outcome: "cancelled" });
    expect(recorded).toEqual(["tool-called", "tool-ended cancelled"]);
  });
});

describe("more of a handler's limits", () => {
  test("compact, set, fork and agents.stop on its own agent are refused, and so is run up the chain", async () => {
    const refused: string[] = [];
    const adapter = createFakeAdapter({
      script: (context) => ({
        act: async () => {
          const launcher = launcherOf(context);
          if (context.activation.key === "a") await wf(launcher, ["tool", "own"]);
          if (context.activation.key === "b") await wf(launcher, ["tool", "back"]);
          await wf(launcher, ["result", callIdOf(context)], '"done"');
        },
      }),
    });
    const caught = (what: string, work: () => Promise<unknown>) =>
      Promise.resolve()
        .then(work)
        .then(
          () => refused.push(`${what}: ran`),
          (error: Error) => refused.push(`${what}: ${error.message.split(":")[0]}`),
        );
    const workflow: WorkflowDefinition<null, null> = {
      meta: { name: "limits-in-handler", description: "limits-in-handler" },
      async run(context) {
        let a!: AgentRef;
        const b: AgentRef = await context.agents.open({
          key: "b",
          runtime: "fake",
          tools: {
            back: tool({
              description: "Runs a.",
              handler: () =>
                caught("run a from b's handler", () => a.run({ prompt: "x", schema: TEXT })),
            }),
          },
        });
        a = await context.agents.open({
          key: "a",
          runtime: "fake",
          tools: {
            own: tool({
              description: "Tries its own agent, then runs b.",
              handler: async () => {
                await caught("compact", () => a.compact({ prompt: "x" }));
                await caught("set", () => a.set({ model: "other" }));
                await caught("fork", () => a.fork({ key: "f" }));
                await caught("stop", () => context.agents.stop("a"));
                await b.run({ prompt: "go", schema: TEXT, nudge: false });
              },
            }),
          },
        });
        await a.run({ prompt: "work", schema: TEXT, nudge: false });
        return null;
      },
    };
    await runNew(workflow, null, {
      runRoot: runDirs.tempRunDir(),
      deadline: future(),
      runtime: runtime(adapter),
    });
    expect(refused).toEqual([
      "compact: agent-in-tool",
      "set: agent-in-tool",
      "fork: agent-in-tool",
      "stop: agent-in-tool",
      "run a from b's handler: agent-in-tool",
    ]);
  });

  test("a result over 64 KiB or with a cycle fails, and input over 64 KiB is refused", async () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const { seen } = await withTools(
      {
        big: tool({ description: "Big.", handler: () => "x".repeat(70_000) }),
        loop: tool({ description: "Loop.", handler: () => cycle as never }),
        close: tool({ description: "Close.", input: CLOSE, handler: () => "closed" }),
      },
      async (wf) => [
        await wf(["tool", "big"]),
        await wf(["tool", "loop"]),
        await wf(
          ["tool", "close"],
          JSON.stringify({ id: "a", status: "done", why: "y".repeat(70_000) }),
        ),
      ],
    );
    const [big, loop, close] = seen as Ran[];
    expect([big!.exitCode, loop!.exitCode, close!.exitCode]).toEqual([1, 1, 3]);
    expect(big!.stderr).toContain("too large to send back");
    expect(loop!.stderr).toContain("isn't JSON");
    expect(close!.stderr).toContain("the input is too large");
  });

  test("stopping the agent aborts its running call at once", async () => {
    const entered = Promise.withResolvers<void>();
    let reason = "";
    const { value } = await withTools(
      {
        wait: tool({
          description: "Waits.",
          timeoutMs: false,
          handler: (_input, call) =>
            new Promise((resolve) => {
              entered.resolve();
              call.signal.addEventListener("abort", () => {
                reason = (call.signal.reason as Error).message;
                resolve(null);
              });
            }),
        }),
      },
      (wf) => wf(["tool", "wait"]),
      {
        around: async (agent, context) => {
          const running = agent.run({ prompt: "work", schema: TEXT, nudge: false });
          await entered.promise;
          await context.agents.stop("triager", "enough");
          await running;
        },
      },
    );
    expect(value).toBeNull();
    expect(reason).toBe("the tool call was cancelled");
  });

  test("a top-level turn's handler runs in no stage", async () => {
    const runRoot = runDirs.tempRunDir();
    const adapter = createFakeAdapter({
      script: (context) => ({
        act: async () => {
          const launcher = launcherOf(context);
          if (context.activation.key === "triager") await wf(launcher, ["tool", "help"]);
          await wf(launcher, ["result", callIdOf(context)], '"done"');
        },
      }),
    });
    const workflow: WorkflowDefinition<null, null> = {
      meta: { name: "top-level", description: "top-level" },
      async run(context) {
        const helper = await context.agents.open({ key: "helper", runtime: "fake" });
        const triager = await context.agents.open({
          key: "triager",
          runtime: "fake",
          tools: {
            help: tool({
              description: "Help.",
              handler: async () =>
                (await helper.run({ prompt: "help", schema: TEXT, nudge: false })).outcome.kind,
            }),
          },
        });
        await context.stage("before", async () => {});
        await triager.run({ prompt: "work", schema: TEXT, nudge: false });
        return null;
      },
    };
    const result = await runNew(workflow, null, {
      runRoot,
      deadline: future(),
      runtime: runtime(adapter),
    });
    const turns = await readTurns(join(runRoot, "top-level", result.runId));
    expect(turns.map((turn) => [turn.agent, turn.stage ?? null])).toEqual([
      ["helper", null],
      ["triager", null],
    ]);
  });
});

describe("more of tools on a spec", () => {
  test("TypeBox and JSON Schema forms match; a repeat fork keeps or replaces; a parent's reopen leaves its fork", async () => {
    const said: string[] = [];
    const adapter = createFakeAdapter({
      continues: true,
      forks: () => true,
      script: (context) => ({
        act: async () => {
          const launcher = launcherOf(context);
          said.push(
            `${context.activation.key}: ${(await wf(launcher, ["tool", "who", "--id", "x"])).stdout}`,
          );
          await wf(launcher, ["result", callIdOf(context)], '"done"');
        },
      }),
    });
    const input = Type.Object({ id: Type.String() });
    const who = (name: string, schema: object = input) =>
      ({
        who: tool({ description: "Who.", input: schema as never, handler: () => name }),
      }) as AgentTools;
    const workflow: WorkflowDefinition<null, string[]> = {
      meta: { name: "matching", description: "matching" },
      async run(context) {
        const run = (agent: AgentRef) => agent.run({ prompt: "work", schema: TEXT, nudge: false });
        const open = (tools?: AgentTools) =>
          context.agents.open({ key: "parent", runtime: "fake", ...(tools ? { tools } : {}) });
        const parent = await open(who("typebox"));
        await run(parent);
        await run(await open(who("json", JSON.parse(JSON.stringify(input)))));
        const fork = await parent.fork({ key: "fork" });
        await run(fork);
        await run(await open(who("parent again")));
        await run(fork);
        await run(await parent.fork({ key: "fork", tools: who("fork's own") }).catch(() => fork));
        await run(await parent.fork({ key: "fork" }));
        const refusals: string[] = [];
        await parent
          .fork({ key: "bad", tools: { "Bad-Name": who("x").who! } })
          .catch((error: Error) => refusals.push(error.message));
        return refusals;
      },
    };
    const result = await runNew(workflow, null, {
      runRoot: runDirs.tempRunDir(),
      deadline: future(),
      runtime: runtime(adapter),
    });
    expect(said).toEqual([
      "parent: typebox",
      "parent: json",
      "fork: json",
      "parent: parent again",
      "fork: json",
      "fork: fork's own",
      "fork: fork's own",
    ]);
    expect(result.value).toEqual([expect.stringContaining("a tool's name matches")]);
  });
});

describe("the tools lesson", () => {
  type Taught = { name: string; description: string; input?: JsonSchema };
  const close: Taught & { input: JsonSchema } = {
    name: "close_case",
    description: "Close the case when the engineer says it's fixed or noise.",
    input: {
      type: "object",
      properties: {
        status: {
          anyOf: [
            { type: "string", const: "closed" },
            { type: "string", const: "noise" },
          ],
        },
        why: { type: "string" },
      },
      required: ["status", "why"],
    },
  };
  const list = { name: "list_open", description: "The cases still open, one per line." };

  test("is the story's: the call form, then each tool's description and usage line", () => {
    expect(toolsLesson([close, list], "wf", true)).toBe(
      [
        "You have tools the workflow runs for you. Call one with:",
        "",
        "wf tool <name> --<option> '<value>' ...",
        "",
        "- close_case: Close the case when the engineer says it's fixed or noise.",
        "  wf tool close_case --status closed|noise --why <text>",
        "- list_open: The cases still open, one per line.",
        "  wf tool list_open",
      ].join("\n"),
    );
  });

  test("says the quoting rule when the result block didn't; a tool taught as JSON adds the heredoc form", () => {
    const nested: Taught = {
      name: "file",
      description: "File items.",
      input: {
        type: "object",
        properties: { items: { type: "array", items: { type: "string" } } },
      },
    };
    expect(toolsLesson([close, nested], "wf", false)).toBe(
      [
        "You have tools the workflow runs for you. Call one with:",
        "",
        "wf tool <name> --<option> '<value>' ...",
        "wf tool <name> <<'WF_JSON'",
        "<json>",
        "WF_JSON",
        "",
        "Put every value in single quotes; a ' inside a value is written '\\''.",
        "",
        "- close_case: Close the case when the engineer says it's fixed or noise.",
        "  wf tool close_case --status closed|noise --why <text>",
        `- file: File items.\n  input: ${JSON.stringify(nested.input)}`,
      ].join("\n"),
    );
    // A description's own lines stay under its tool.
    expect(
      toolsLesson([{ name: "two", description: "First.\n- not a tool" }], "wf", true),
    ).toContain("- two: First.\n  - not a tool\n  wf tool two");
    // Nothing to quote with no flags; no lesson with no tools.
    expect(toolsLesson([list], "wf", false)).not.toContain("single quotes");
    expect(toolsLesson([], "wf", false)).toBeUndefined();
  });

  test("comes after the result block in a turn, with the quoting rule said once; none without tools", async () => {
    const prompts: string[] = [];
    const adapter = createFakeAdapter({
      script: (context) => ({
        act: async () => {
          prompts.push(context.prompt);
          await wf(launcherOf(context), ["result", callIdOf(context), "--answer", "x"]);
        },
      }),
    });
    const ANSWER: OutputSchema<{ answer: string }> = {
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
    };
    const workflow: WorkflowDefinition<null, null> = {
      meta: { name: "lesson", description: "lesson" },
      async run(context) {
        const run = (agent: AgentRef) =>
          agent.run({ prompt: "Work.", schema: ANSWER, nudge: false });
        await run(
          await context.agents.open({
            key: "with",
            runtime: "fake",
            tools: {
              close_case: tool({
                description: close.description,
                input: close.input as never,
                handler: () => "ok",
              }),
            },
          }),
        );
        await run(await context.agents.open({ key: "without", runtime: "fake" }));
        return null;
      },
    };
    await runNew(workflow, null, {
      runRoot: runDirs.tempRunDir(),
      deadline: future(),
      runtime: runtime(adapter),
    });
    const [withTools, without] = prompts;
    const launcher = /(\/\S+\/wf) result/.exec(withTools!)![1]!;
    expect(withTools).toEndWith(
      [
        `${launcher} result ${/result (\S+)/.exec(withTools!)![1]} --answer <text>`,
        "",
        "Put every value in single quotes; a ' inside a value is written '\\''.",
        "",
        "You have tools the workflow runs for you. Call one with:",
        "",
        `${launcher} tool <name> --<option> '<value>' ...`,
        "",
        "- close_case: Close the case when the engineer says it's fixed or noise.",
        `  ${launcher} tool close_case --status closed|noise --why <text>`,
      ].join("\n"),
    );
    expect(withTools!.split("single quotes")).toHaveLength(2);
    expect(without).not.toContain("You have tools");
  });

  test("a message turn's prompt carries the block, quoting rule and all", async () => {
    const prompts: string[] = [];
    const adapter = createFakeAdapter({
      script: (context) => ({
        act: async () => {
          const launcher = launcherOf(context);
          if (context.activation.key === "asker") {
            await wf(launcher, ["send", "peer", "go"]);
            await wf(launcher, ["result", callIdOf(context)], '"done"');
          } else prompts.push(context.prompt);
        },
      }),
    });
    const workflow: WorkflowDefinition<null, null> = {
      meta: { name: "message-lesson", description: "message-lesson" },
      async run(context) {
        const asker = await context.agents.open({ key: "asker", runtime: "fake" });
        const peer = await context.agents.open({
          key: "peer",
          runtime: "fake",
          tools: {
            close_case: tool({
              description: close.description,
              input: close.input as never,
              handler: () => "ok",
            }),
          },
        });
        await context.messages.allow({ from: asker, to: peer, purpose: "Ask." });
        await asker.run({ prompt: "Ask.", schema: TEXT, nudge: false });
        return null;
      },
    };
    await runNew(workflow, null, {
      runRoot: runDirs.tempRunDir(),
      deadline: future(),
      runtime: runtime(adapter),
    });
    expect(prompts).toHaveLength(1);
    const [opening, block] = prompts[0]!.split("\n\nYou have tools the workflow runs for you.");
    expect(opening).toContain("go");
    expect(block).toEndWith(
      `  ${launcherOf({ prompt: prompts[0]! } as FakeAdapterTurnContext)} tool close_case --status closed|noise --why <text>`,
    );
    expect(prompts[0]!.split("Put every value in single quotes")).toHaveLength(2);
    expect(prompts[0]).not.toContain("return it by running");
  });
});

describe("tool records and awf logs", () => {
  test("each call leaves its records; an envelope refusal leaves none; awf logs shows a call on one line", async () => {
    const runRoot = runDirs.tempRunDir();
    let envelope = "";
    const adapter = createFakeAdapter({
      script: (context) => ({
        act: async () => {
          const launcher = launcherOf(context);
          await wf(launcher, ["tool", "close", "--id", "a1", "--status", "done"]);
          await wf(launcher, ["tool", "nope"]);
          await wf(launcher, ["tool", "close", "--id", "a1"]);
          await wf(launcher, ["tool", "boom"]);
          await wf(launcher, ["tool", "slow"]);
          // An envelope wf would never send: refused before it is a call, and not recorded.
          const socket = /--at '?([^' ]+)/.exec(await Bun.file(launcher).text())?.[1];
          envelope = await exchange(
            socket!,
            `${JSON.stringify({ version: WIRE_VERSION, command: "tool", tool: "close", operationId: "x" })}\n`,
          );
          await wf(launcher, ["result", callIdOf(context)], '"done"');
        },
      }),
    });
    const workflow: WorkflowDefinition<null, null> = {
      meta: { name: "records", description: "records" },
      async run(context) {
        const agent = await context.agents.open({
          key: "triager",
          runtime: "fake",
          tools: {
            close: tool({
              description: "Close.",
              input: CLOSE,
              handler: ({ id }) => `Closed ${id}.`,
            }),
            boom: tool({
              description: "Throws.",
              handler: () => {
                throw new Error("locked");
              },
            }),
            slow: tool({
              description: "Slow.",
              timeoutMs: 50,
              handler: () => new Promise((resolve) => setTimeout(resolve, 200)),
            }),
          },
        });
        await agent.run({ prompt: "work", schema: TEXT, nudge: false });
        return null;
      },
    };
    const result = await runNew(workflow, null, {
      runRoot,
      deadline: future(),
      runtime: runtime(adapter),
    });
    expect(result.value).toBeNull();
    expect(JSON.parse(envelope)).toMatchObject({ kind: "rejected", code: "invalid-request" });
    const text = await Bun.file(join(runRoot, "records", result.runId, "turns.jsonl")).text();
    const lines = text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { kind: string; [key: string]: unknown })
      .filter((line) => line.kind.startsWith("tool-"));
    expect(
      lines.map((line) =>
        [line.kind, line.tool, line.outcome ?? line.code ?? "", line.error ? "error" : ""]
          .join(" ")
          .trim(),
      ),
    ).toEqual([
      "tool-called close",
      "tool-ended close ok",
      "tool-refused nope unknown-tool",
      "tool-refused close invalid-input error",
      "tool-called boom",
      "tool-ended boom failed error",
      "tool-called slow",
      "tool-ended slow timed-out error",
    ]);
    expect(lines[1]).toMatchObject({ result: "Closed a1.", agent: "triager", tool: "close" });
    expect(lines[0]).toMatchObject({ input: { id: "a1", status: "done" } });

    const out: string[] = [];
    await logsCommand(
      [`records/${result.runId}`, "--run-root", runRoot],
      process.cwd(),
      { stdout: (text) => out.push(text), stderr: (text) => out.push(text) },
      undefined,
      runRoot,
    );
    const shown = out
      .join("\n")
      .split("\n")
      .filter((line) => line.includes("tool call "));
    expect(shown.map((line) => line.replace(/^@\S+ \S+ triager {2}/, ""))).toEqual([
      'tool call close {"id":"a1","status":"done"}  ok  → Closed a1.',
      "tool call nope  refused  unknown-tool",
      expect.stringMatching(
        /^tool call close {2}refused {2}invalid-input {2}.*required property is missing/,
      ),
      "tool call boom  failed  locked",
      expect.stringMatching(
        /^tool call slow {2}timed-out {2}slow didn't answer in time \(0\.05 s\)/,
      ),
    ]);
  }, 20_000);
});

describe("with started turns", () => {
  /** A tool that runs until its signal aborts, then takes 200 ms more to settle. */
  const lingering = (seen: { entered: PromiseWithResolvers<void>; settledAt?: number }) =>
    tool({
      description: "Lingers.",
      handler: async (_input, call) => {
        seen.entered.resolve();
        await new Promise((resolve) =>
          call.signal.addEventListener("abort", resolve, { once: true }),
        );
        await Bun.sleep(200);
        seen.settledAt = Date.now();
      },
    });
  const calls = answer(async (turn) => {
    await turn.tool("linger");
    return "done";
  });

  test("a cancelled turn's end is written, and cancel() resolves, once its call has settled", async () => {
    const seen = { entered: Promise.withResolvers<void>() } as Parameters<typeof lingering>[0];
    const run = await testWorkflow(
      caseRun(async (workflow) => {
        await workflow.receive();
        const agent = await workflow.agents.open({
          key: "investigator",
          runtime: "claude",
          tools: { linger: lingering(seen) },
        });
        const turn = await agent.start({ prompt: "look" });
        await seen.entered.promise;
        const cancelled = await turn.cancel("closed");
        const resolvedAt = Date.now();
        const [end] = await workflow.receive();
        return {
          cancelled,
          settledFirst: seen.settledAt !== undefined && seen.settledAt <= resolvedAt,
          kind: end && agent.ended(end) ? end.data.outcome.kind : null,
        };
      }),
      { ...startCase, agents: { investigator: calls } },
    );
    expect(run.value).toEqual({ cancelled: true, settledFirst: true, kind: "cancelled" });
    const end = run.mailbox.find((each) => each.kind === "event" && each.name === "agent:ended");
    expect(Date.parse(end!.at)).toBeGreaterThanOrEqual(seen.settledAt!);
  });

  test("a run with a call settling doesn't park until the turn's end is taken", async () => {
    const seen = { entered: Promise.withResolvers<void>() } as Parameters<typeof lingering>[0];
    const taken: boolean[] = [];
    const run = await testWorkflow(
      caseRun(async (workflow) => {
        await workflow.receive();
        const agent = await workflow.agents.open({
          key: "investigator",
          runtime: "claude",
          tools: { linger: lingering(seen) },
        });
        const turn = await agent.start({ prompt: "look" });
        await seen.entered.promise;
        void turn.cancel();
        for (;;)
          for (const e of await workflow.receive({ label: "idle" }))
            if (agent.ended(e)) taken.push(seen.settledAt !== undefined);
      }),
      { ...startCase, agents: { investigator: calls } },
    );
    expect(run.parked).toEqual({ label: "idle" });
    expect(taken).toEqual([true]);
  });

  test("a turn started from a handler isn't in it: its own handler may cancel the first agent's next turn", async () => {
    const ready = Promise.withResolvers<void>();
    let a!: EventAgentRef;
    let b!: EventAgentRef;
    let next!: StartedTurn;
    let turns = 0;
    const run = await testWorkflow(
      caseRun(async (workflow) => {
        await workflow.receive();
        a = await workflow.agents.open({
          key: "a",
          runtime: "claude",
          tools: {
            kick: tool({
              description: "Starts b.",
              handler: async () => void (await b.start({ prompt: "go" })),
            }),
          },
        });
        b = await workflow.agents.open({
          key: "b",
          runtime: "claude",
          tools: {
            stop_a: tool({
              description: "Cancels a's turn.",
              handler: async () => {
                await ready.promise;
                return String(await next.cancel("by b"));
              },
            }),
          },
        });
        await a.start({ prompt: "one" });
        let said: JsonValue = null;
        let waiting = 2;
        while (waiting > 0)
          for (const e of await workflow.receive()) {
            if (a.ended(e) && e.data.outcome.kind === "answered" && !next) {
              next = await a.start({ prompt: "two" });
              ready.resolve();
            } else if (a.ended(e)) waiting -= 1;
            else if (b.ended(e)) {
              said = isAnswered(e.data.outcome) ? e.data.outcome.value : e.data.outcome.kind;
              waiting -= 1;
            }
          }
        return said;
      }),
      {
        ...startCase,
        agents: {
          a: answer(async (turn) => {
            turns += 1;
            if (turns === 1) {
              await turn.tool("kick");
              return "one";
            }
            await new Promise((resolve) =>
              turn.signal.addEventListener("abort", resolve, { once: true }),
            );
            return "two";
          }),
          b: answer(async (turn) => {
            const stopped = await turn.tool("stop_a");
            return stopped.kind === "result" ? (stopped.output ?? "") : stopped.error;
          }),
        },
      },
    );
    expect(run.value).toBe("true");
  });

  test("a message turn a handler's run made due isn't in that handler", async () => {
    const aRunning = Promise.withResolvers<void>();
    const sent = Promise.withResolvers<void>();
    const heard = Promise.withResolvers<string>();
    let b!: AgentRef;
    const workflow: WorkflowDefinition<null, JsonValue> = {
      meta: { name: "held", description: "held" },
      async run(context) {
        const a = await context.agents.open({
          key: "a",
          runtime: "claude",
          tools: {
            poke_b: tool({
              description: "Asks b for more.",
              // b's turn that ran a has ended by now, so this waits for nothing.
              handler: () =>
                b.run({ prompt: "again" }).then(
                  () => "ran",
                  (error: unknown) => messageOf(error),
                ),
            }),
          },
        });
        b = await context.agents.open({
          key: "b",
          runtime: "claude",
          tools: {
            ask_a: tool({
              description: "Has a work.",
              handler: async () => void (await a.run({ prompt: "work" })),
            }),
          },
        });
        const c = await context.agents.open({ key: "c", runtime: "claude" });
        await context.messages.allow({ between: [c, a], purpose: "Talk." });
        await Promise.all([b.run({ prompt: "go" }), c.run({ prompt: "tell a" })]);
        return heard.promise;
      },
    };
    const run = await testWorkflow(workflow, null, {
      agents: {
        // a's run is b's handler's; c's message arrives during it, so it is held until it ends.
        a: answer(async () => {
          aRunning.resolve();
          await sent.promise;
          return "worked";
        }),
        b: [
          answer(async (turn) => {
            await turn.tool("ask_a");
            return "asked";
          }),
          answer("again"),
        ],
        c: answer(async (turn) => {
          await aRunning.promise;
          await turn.send("a", "hello");
          sent.resolve();
          return "told";
        }),
      },
      messages: {
        a: async (message) => {
          const poked = await message.tool("poke_b");
          heard.resolve(poked.kind === "result" ? (poked.output ?? "") : poked.error);
          return message.silent();
        },
      },
    });
    expect(run.value).toBe("ran");
  });

  test("start() from a handler of a turn in a stage is refused agent-in-tool, not as in a stage", async () => {
    let agent!: EventAgentRef;
    const run = await testWorkflow(
      caseRun(async (workflow) => {
        await workflow.receive();
        agent = await workflow.agents.open({
          key: "investigator",
          runtime: "claude",
          tools: {
            poke: tool({
              description: "Pokes.",
              handler: () =>
                agent.start({ prompt: "again" }).then(
                  () => "taken",
                  (error: unknown) => messageOf(error),
                ),
            }),
          },
        });
        let said: JsonValue = null;
        await workflow.stage("look", async () => {
          const { outcome } = await agent.run({ prompt: "look" });
          said = isAnswered(outcome) ? outcome.value : outcome.kind;
        });
        return said;
      }),
      {
        ...startCase,
        agents: {
          investigator: answer(async (turn) => {
            const poked = await turn.tool("poke");
            return poked.kind === "result" ? (poked.output ?? "") : poked.kind;
          }),
        },
      },
    );
    expect(run.value).toStartWith("agent-in-tool: start() on agent investigator is refused");
  });

  test("start(), cancel() and receive() from a handler of the agent's started turn are refused first", async () => {
    let agent!: EventAgentRef;
    let started!: StartedTurn;
    const run = await testWorkflow(
      caseRun(async (workflow) => {
        await workflow.receive();
        agent = await workflow.agents.open({
          key: "investigator",
          runtime: "claude",
          tools: {
            poke: tool({
              description: "Pokes.",
              handler: async () => {
                const errors: string[] = [];
                for (const attempt of [
                  () => agent.start({ prompt: "again" }),
                  () => started.cancel(),
                  () => workflow.receive(),
                ])
                  await attempt().then(
                    () => errors.push("taken"),
                    (error: unknown) => errors.push(messageOf(error)),
                  );
                return errors;
              },
            }),
          },
        });
        started = await agent.start({ prompt: "look" });
        const [end] = await workflow.receive();
        return end && agent.ended(end) && isAnswered(end.data.outcome)
          ? end.data.outcome.value
          : null;
      }),
      {
        ...startCase,
        agents: {
          investigator: answer(async (turn) => {
            const poked = await turn.tool("poke");
            return poked.kind === "result" ? (poked.output ?? "") : poked.kind;
          }),
        },
      },
    );
    const errors = JSON.parse(run.value as string) as string[];
    expect(errors[0]).toStartWith("agent-in-tool: start() on agent investigator is refused");
    expect(errors[1]).toStartWith("agent-in-tool: cancel() on agent investigator is refused");
    expect(errors[2]).toContain("receive() is refused in a tool's handler");
  });
});
