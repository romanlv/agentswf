// Checked by `tsc --noEmit`, never run: what `agentswf/testing` offers a workflow's test, and what
// it doesn't. Each deprecated name compiles until story 039's last task removes it.

import {
  answer,
  noAnswer,
  reply,
  type TestOptions,
  type TestRun,
  type TestTurn,
  type TestTurnOutcome,
  testWorkflow,
} from "./testing";
import { AgentEnded, defineWorkflow, type OutputSchema, ParticipantReply } from "./workflow";

type Surface = typeof import("./testing");
// @ts-expect-error Only a claude TUI agent may wait, which its harness decides, not a workflow.
export type Waiting = Surface["waiting"];
// @ts-expect-error The engine's own tests, which say where an agent may await a reply, call it.
export type RunTest = Surface["runTest"];

const plain = defineWorkflow({
  meta: { name: "plain", description: "One agent." },
  run: async (wf) => {
    const agent = await wf.agents.open({ key: "a", runtime: "claude" });
    return (await agent.run({ prompt: "Go." })).outcome.kind;
  },
});
const greet = defineWorkflow<{ name: string }, string>({
  meta: { name: "greet", description: "Greets one name." },
  prepare: ({ argv }) => ({ name: argv[0] ?? "nobody" }),
  run: async (_wf, { name }) => `hi ${name}`,
});
const Ping = { type: "object" } as OutputSchema<{ n: number }>;
const withEvents = defineWorkflow({
  meta: { name: "events", description: "Woken by pings." },
  file: import.meta.path,
  events: { ping: Ping },
  run: async (wf) => (await wf.receive()).length,
});
const bare = { meta: plain.meta, run: plain.run };
const maybe = defineWorkflow<{ x: number } | null, number>({
  meta: { name: "maybe", description: "Args or none." },
  prepare: () => null,
  run: async (_wf, args) => args?.x ?? 0,
});
const listed = defineWorkflow<string[], number>({
  meta: { name: "listed", description: "Counts." },
  prepare: ({ argv }) => [...argv],
  run: async (_wf, names) => names.length,
});

export async function argsShapes(): Promise<void> {
  // Null among its args: they may be left out.
  await testWorkflow(maybe);
  await testWorkflow(maybe, { args: { x: 1 } });
  await testWorkflow(listed, { args: ["a"] });
  // @ts-expect-error Array args are required too.
  await testWorkflow(listed, {});
  // Deprecated: array args given second, with no options.
  await testWorkflow(listed, ["a", "b"]);
}

export async function oneSignature(): Promise<void> {
  await testWorkflow(plain);
  await testWorkflow(plain, { agents: { a: answer("done") }, maxTurns: 3, id: "r-1" });
  await testWorkflow(greet, { args: { name: "ada" } });
  // @ts-expect-error A workflow that takes args is given them.
  await testWorkflow(greet);
  // @ts-expect-error A workflow that takes args is given them, among its options.
  await testWorkflow(greet, { agents: { a: answer("done") } });
  // @ts-expect-error Its args given second are not options: an object there always is.
  await testWorkflow(greet, { name: "ada" });
  // @ts-expect-error A misspelled option is refused.
  await testWorkflow(plain, { agnets: { a: answer("done") } });
  // @ts-expect-error A workflow without events is sent none.
  await testWorkflow(plain, { event: { name: "ping", data: { n: 1 } } });
  // @ts-expect-error The one form tests what defineWorkflow made.
  await testWorkflow(bare, {});
  await testWorkflow(withEvents, {
    earlier: { stages: { plan: null }, mailbox: [] },
    event: { name: "ping", data: { n: 1 } },
    fromStage: "plan",
  });
  const shared: TestOptions = { agents: { a: answer("done") } };
  await testWorkflow(plain, shared);
  await testWorkflow(greet, { ...shared, args: { name: "ada" } });
}

export async function removed(): Promise<void> {
  // @ts-expect-error A wait is the harness's check-in, not a script's ending.
  reply.waiting("for CI");
  // @ts-expect-error Where an agent may await a reply is the engine's list.
  await testWorkflow(plain, { awaitReply: "anywhere" });
  // @ts-expect-error A message script ends a turn; it answers no call.
  await testWorkflow(plain, { messages: { a: () => answer("done") } });
}

export async function deprecated(run: TestRun<string>): Promise<void> {
  await testWorkflow(plain, null, {
    agents: { a: [reply.silent(), reply.blocked(), reply.failed(), reply.timedOut()] },
    compactions: { a: [reply.hang(), reply.interrupted(), reply.needsLogin()] },
    messages: { a: [(message) => message.silent(), (message) => message.fail("crashed")] },
    recorded: { plan: null },
  });
  await testWorkflow(greet, { name: "ada" }, undefined);
  await testWorkflow(plain, null);
  await testWorkflow(bare, null, {});
  await testWorkflow(withEvents, {
    id: "k",
    event: { name: "ping", data: { n: 1 }, id: "e-1" },
    events: [{ during: "a#1", name: "ping", data: { n: 2 }, id: "e-2" }],
    mailbox: [],
  });
  void run.stopped?.reason;
  void run.parked?.label;
}

export async function current(): Promise<void> {
  const run = await testWorkflow(plain, {
    agents: { a: [noAnswer.silent(), noAnswer.failed("crashed"), answer("done")] },
    messages: {
      a: [() => {}, async (message) => message.reply("Done."), () => noAnswer.failed("crashed")],
    },
  });
  const turn: TestTurn = run.turns[0]!;
  const outcome: TestTurnOutcome = turn.outcome;
  // @ts-expect-error A turn records the engine's word, unanswered, not the script's.
  const silent: TestTurnOutcome = "silent";
  void [outcome, silent];
  if (run.ending.kind === "stopped") void [run.ending.stage, run.ending.reason];
  if (run.ending.kind === "completed") void run.ending.value;
  await testWorkflow(withEvents, {
    id: "k",
    event: { name: "ping", data: { n: 1 }, eventId: "e-1" },
    events: [{ during: "a#1", name: "ping", data: { n: 2 }, eventId: "e-2" }],
  });
}

const declaring = defineWorkflow({
  meta: { name: "declaring", description: "Declares its thread's replies and an agent's end." },
  file: import.meta.path,
  events: { ping: Ping, "thread:reply": ParticipantReply, "a:ended": AgentEnded },
  run: async (wf) => (await wf.receive()).length,
});

export async function scriptedReplies(): Promise<void> {
  await testWorkflow(declaring, {
    events: [{ during: "a#1", name: "thread:reply", data: { text: "hi", author: "dana" } }],
  });
  // @ts-expect-error A reply's data is ParticipantReply's: text, and author.
  await testWorkflow(declaring, {
    events: [{ during: "a#1", name: "thread:reply", data: { body: "hi" } }],
  });
  // @ts-expect-error Only awf sends an agent's end.
  await testWorkflow(declaring, {
    events: [{ during: "a#1", name: "a:ended", data: { turn: "t", meta: null } }],
  });
  // Deprecated: the old name, from the participant's key.
  await testWorkflow(withEvents, {
    events: [{ during: "a#1", name: "participant:reply", from: "thread", data: { text: "hi" } }],
  });
}
