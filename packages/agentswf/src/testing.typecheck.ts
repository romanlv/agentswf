// Checked by `tsc --noEmit`, never run: what `agentswf/testing` offers a workflow's test, and what
// it doesn't. Each deprecated name compiles until story 039's last task removes it.

import {
  answer,
  noAnswer,
  reply,
  type TestRun,
  type TestTurn,
  type TestTurnOutcome,
  testWorkflow,
} from "./testing";
import { defineWorkflow, type OutputSchema } from "./workflow";

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
const Ping = { type: "object" } as OutputSchema<{ n: number }>;
const withEvents = defineWorkflow({
  meta: { name: "events", description: "Woken by pings." },
  file: import.meta.path,
  events: { ping: Ping },
  run: async (wf) => (await wf.receive()).length,
});

export async function removed(): Promise<void> {
  // @ts-expect-error A wait is the harness's check-in, not a script's ending.
  reply.waiting("for CI");
  // @ts-expect-error Where an agent may await a reply is the engine's list.
  await testWorkflow(plain, null, { awaitReply: "anywhere" });
  // @ts-expect-error A message script ends a turn; it answers no call.
  await testWorkflow(plain, null, { messages: { a: () => answer("done") } });
}

export async function deprecated(run: TestRun<string>): Promise<void> {
  await testWorkflow(plain, null, {
    agents: { a: [reply.silent(), reply.blocked(), reply.failed(), reply.timedOut()] },
    compactions: { a: [reply.hang(), reply.interrupted(), reply.needsLogin()] },
    messages: { a: [(message) => message.silent(), (message) => message.fail("crashed")] },
  });
  await testWorkflow(withEvents, {
    id: "k",
    event: { name: "ping", data: { n: 1 }, id: "e-1" },
    events: [{ during: "a#1", name: "ping", data: { n: 2 }, id: "e-2" }],
  });
  void run.stopped?.reason;
  void run.parked?.label;
}

export async function current(): Promise<void> {
  const run = await testWorkflow(plain, null, {
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
