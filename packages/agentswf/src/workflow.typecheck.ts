// Checked by `tsc --noEmit`, never run: what `agentswf/workflow` offers an author, and what it
// doesn't. Each deprecated name compiles until story 039's last task removes it.

import {
  type AgentDirectory,
  AgentEnded,
  type AgentEndedEvent,
  type AgentOpenSpec,
  type AgentRef,
  type CallerRef,
  type CodeParticipantRef,
  type CodeParticipantSpec,
  type Duration,
  defineExecutableWorkflow,
  defineWorkflow,
  duration,
  type EventAgentDirectory,
  type EventAgentOpenSpec,
  type EventAgentRef,
  type EventWorkflowContext,
  isAnswered,
  type JsonValue,
  type OutputSchema,
  type ParticipantRef,
  ParticipantReply,
  type ParticipantReplyEvent,
  tool,
  type WorkflowContext,
  type WorkflowEvent,
  yesNo,
} from "./workflow";

type Surface = typeof import("./workflow");
// @ts-expect-error The engine's own check of a workflow's events, not an author's.
export type EventWorkflowProblem = Surface["eventWorkflowProblem"];
// @ts-expect-error The engine reads an agent's placement; an author writes it.
export type PlacementOf = Surface["placementOf"];
// @ts-expect-error Removed: a workflow is a `Workflow`, from `defineWorkflow`.
export type Definition = import("./workflow").WorkflowDefinition<null, null>;
// @ts-expect-error Removed with `wf.call`, which was never built.
export type CallSpec = import("./workflow").WorkflowCallSpec<null, null>;
// @ts-expect-error Removed with `wf.steps`, which was never built.
export type StepSpec = import("./workflow").StepSpec;
// @ts-expect-error One `WaitOptions` for receive, race and select.
export type SelectOptions = import("./workflow").SelectOptions;
// @ts-expect-error One `WaitOptions` for receive, race and select.
export type ReceiveOptions = import("./workflow").ReceiveOptions;

declare const plain: WorkflowContext;
declare const Changed: OutputSchema<{ head: string }>;
type Events = { changed: typeof Changed };
declare const wf: WorkflowContext<Events>;

export async function removed(): Promise<void> {
  // @ts-expect-error A stage and wf.sleep do what steps would have.
  await plain.steps.run({ id: "x" }, async () => null);
  // @ts-expect-error One workflow calling another was never built.
  await plain.call({ id: "child" });
  // @ts-expect-error Opening the same key again returns the agent opened before.
  await plain.agents.attach("reviewer");
  // @ts-expect-error A participant's ref is what connect returned.
  await plain.participants.get("coordinator");
  // @ts-expect-error A loop over each timer is a select with each as a branch.
  wf.timers();
  // @ts-expect-error receive takes every event not yet acknowledged; select takes one at a time.
  await wf.receive({ take: "oldest" });
}

export async function deprecated(): Promise<void> {
  const reviewer = await wf.agents.open({ key: "r", runtime: "claude", labels: { lens: "x" } });
  await reviewer.fork({ key: "r2", labels: { lens: "y" } });
  await plain.agents.forkCaller({ key: "me2", labels: { lens: "z" } });
  const { outcome } = await reviewer.run({ id: "turn-1", prompt: "Review." });
  if (isAnswered(outcome)) void outcome.value;
  await reviewer.compact({ id: "c-1", prompt: "Keep the findings." });
  await reviewer.set({ id: "s-1", effort: "high" });
  const batch = await wf.stage("first", () => wf.receive());
  void batch;
  const turn = await reviewer.start({ id: "turn-2", prompt: "Again." });
  const won = await wf.race("review", { done: turn, quiet: "1d" });
  if (won.done && turn.is({ name: "agent:ended", from: "r", data: won.done })) void turn.id;
  for await (const next of wf.select({ done: turn })) void next.done;
  // One context and one agent: the event-only names are the same types.
  const context: EventWorkflowContext<Events> = wf;
  const agent: EventAgentRef = reviewer;
  const spec: EventAgentOpenSpec = { key: "k", runtime: "claude", keepAlive: {} };
  const agents: EventAgentDirectory = context.agents;
  void [agent satisfies AgentRef, spec satisfies AgentOpenSpec, agents satisfies AgentDirectory];
}

export async function deprecatedAgents(): Promise<void> {
  const worker = await plain.agents.open({ key: "worker", runtime: "codex" });
  await worker.fork({ key: "w2", placement: "headless", metered: true, effort: "low" });
  await plain.agents.forkCaller({ key: "me2", placement: "headless" });
  await plain.agents.stop("worker", "done");
}

export async function caller(): Promise<void> {
  const me = await plain.agents.caller({ key: "me" });
  if (!me) return;
  // @ts-expect-error The calling session's model and effort are the operator's.
  await me.set({ effort: "high" });
  // @ts-expect-error The calling session is the operator's, and is not compacted.
  await me.compact({ prompt: "Keep the plan." });
  // @ts-expect-error A fork of the calling session takes no tools.
  await me.fork({ key: "me3", tools: {} });
  // @ts-expect-error A fork continues its parent's session on its harness and model.
  await me.fork({ key: "me4", runtime: { model: "gpt-6-luna" } });
  // @ts-expect-error The caller is not an agent the run opened.
  const opened: AgentRef = me;
  void opened;
  const fork = await me.fork({ key: "me5", runtime: { placement: "headless", metered: true } });
  const ref: CallerRef = fork;
  await wf.messages.allow({ between: [me, fork], purpose: "Agree on the plan." });
  const won = await wf.race("either", { mine: me, theirs: ref, quiet: "1h" });
  if (won.mine && me.is({ name: "agent:ended", from: "me", data: won.mine })) void won.mine;
  await fork.close("enough");
  await me.close();
}

export async function time(): Promise<void> {
  const reviewer = await wf.agents.open({ key: "r", runtime: "claude", timeout: "90s" });
  const until = new Date(Date.now() + 60_000);
  await reviewer.run({ prompt: "Review.", timeout: "1.5h" });
  await reviewer.run({ prompt: "Review.", timeout: until });
  await reviewer.run({ prompt: "Review.", timeout: false });
  await reviewer.start({ prompt: "Review.", timeout: "10m" });
  await reviewer.compact({ prompt: "Keep it.", timeout: "2m" });
  await reviewer.set({ effort: "high", timeout: "30s" });
  await reviewer.fork({ key: "r2", timeout: "1m" });
  await plain.agents.forkCaller({ key: "me6", timeout: until });
  await plain.parallel([1], async (n) => n, { timeout: "20m" });
  await plain.decisions.decide({
    key: "ok",
    model: "jev",
    state: "x",
    questions: { ok: yesNo("Is it ok?") },
    timeout: "30s",
  });
  await wf.agents.open({
    key: "k",
    runtime: "claude",
    keepAlive: { window: "90s" },
    tools: { look: tool({ description: "Look.", handler: () => "seen", timeout: "30s" }) },
  });
  await wf.messages.allow({ from: reviewer, to: reviewer, purpose: "p", timeout: "30m" });
  wf.timer("in-90s", "90s");
  wf.timer("in-1.5h", "1.5h");
  wf.timer("at", until);
  await wf.sleep("a-while", "14d");
  const every: Duration = duration(String(JSON.parse('"2h"')));
  void every;
  const end: Date | undefined = plain.deadline;
  void end;
  // @ts-expect-error A duration is a decimal and s, m, h or d.
  await reviewer.run({ prompt: "Review.", timeout: "10x" });
  // @ts-expect-error Nor a number: milliseconds are what timeoutMs took.
  await reviewer.run({ prompt: "Review.", timeout: 60_000 });
  // @ts-expect-error A timer's duration is the same grammar.
  wf.timer("typo", "10x");
  // @ts-expect-error A route's timeout is a length of time per question, not a time.
  await wf.messages.allow({ from: reviewer, to: reviewer, purpose: "p", timeout: until });
  // @ts-expect-error A tool's timeout is each call's budget, not a time.
  tool({ description: "Look.", handler: () => "seen", timeout: until });
}

export async function deprecatedTime(): Promise<void> {
  const deadline = { unixMilliseconds: Date.now() + 60_000 };
  const reviewer = await wf.agents.open({ key: "r", runtime: "claude", deadline });
  await reviewer.run({ prompt: "Review.", timeoutMs: 60_000, nudge: { deadline } });
  await reviewer.run({ prompt: "Review.", deadline });
  await reviewer.compact({ prompt: "Keep it.", timeoutMs: 60_000 });
  await reviewer.set({ effort: "high", deadline });
  await plain.parallel([1], async (n) => n, { deadline });
  await plain.decisions.decide({
    key: "ok",
    model: "jev",
    state: "x",
    questions: { ok: yesNo("Is it ok?") },
    deadline,
  });
  await wf.agents.open({
    key: "k",
    runtime: "claude",
    keepAlive: { timeoutMs: 90_000 },
    tools: { look: tool({ description: "Look.", handler: () => "seen", timeoutMs: false }) },
  });
  await wf.messages.allow({ from: reviewer, to: reviewer, purpose: "p", timeoutMs: 60_000 });
  const left = plain.deadline ? plain.deadline.unixMilliseconds - Date.now() : undefined;
  void left;
}

export const old = defineExecutableWorkflow({
  definition: {
    meta: { name: "old", description: "beta.2's shape.", whenToUse: "Never." },
    run: async () => null,
  },
});

export async function current(): Promise<void> {
  const fixer = await wf.agents.open({ key: "fixer", runtime: "claude" });
  await fixer.start({ prompt: "Fix it." });
  const first = await wf.race(
    "fix-or-quiet",
    { fixed: fixer, quiet: "1d" },
    { label: () => `fixing at ${wf.now().toISOString()}` },
  );
  if (first.quiet) await fixer.turn?.cancel("quiet for a day");
  if (first.fixed?.outcome.answered) void first.fixed.outcome.value;
  await wf.receive({ label: () => "waiting" });
}

export default defineWorkflow({
  meta: { name: "current", description: "The new forms." },
  run: async () => null,
});

// Story 039 task 7: participants and agents routed to the code are declared in `events`.
const Change: OutputSchema<{ id: string }> = {
  type: "object",
  properties: { id: { type: "string" } },
  required: ["id"],
};

export const declaring = defineWorkflow({
  meta: { name: "declaring", description: "Declares what wakes it." },
  events: { change: Change, "thread:reply": ParticipantReply, "fixer:ended": AgentEnded },
  async run(wf) {
    const thread: ParticipantRef = await wf.participants.connect({ key: "thread" });
    await thread.post("Looking.");
    // @ts-expect-error A ParticipantRef is not a source: race the signal of its declared reply.
    await wf.race("bare", { reply: thread });
    // @ts-expect-error is(e) stays on timers and agents: a reply is told by its name.
    void thread.is;
    const fixer = await wf.agents.open({ key: "fixer", runtime: "claude" });
    await fixer.start({ prompt: "Fix it." });
    for (const e of await wf.receive()) {
      if (e.name === "thread:reply") {
        const reply: ParticipantReply = e.data;
        void reply.author;
      }
      if (e.name === "fixer:ended") void e.data.outcome.answered;
      // @ts-expect-error A misspelled end is no event the workflow declares.
      if (e.name === "fxier:ended") void e;
      if (fixer.is(e)) void e.data.meta;
      // Narrowed under the name it arrives by, the declared one included.
      if (fixer.is(e) && e.name === "fixer:ended") void e.data.outcome;
    }
    const next = await wf.race("approval", { reply: wf.signal("thread:reply"), quiet: "1d" });
    // @ts-expect-error An agent's end is waited on by naming the agent: { done: fixer }.
    wf.signal("fixer:ended");
    if (next.reply) void next.reply.data.text;
    // @ts-expect-error A run speaks for no participant: wf.emit sends its target's own events.
    await wf.emit(declaringTarget, "k", "thread:reply", { text: "hi" });
    return null;
  },
});
declare const declaringTarget: typeof declaring;

// @ts-expect-error `{key}:reply` takes ParticipantReply, and no other schema.
export const wrongSchema = defineWorkflow({
  meta: { name: "wrong", description: "An awf name with a schema of its own." },
  events: { "thread:reply": Change },
  run: async () => null,
});

// @ts-expect-error Only `{key}:reply` and `{key}:ended` have a colon.
export const unknownColon = defineWorkflow({
  meta: { name: "colon", description: "A colon name awf doesn't make." },
  events: { "thread:said": ParticipantReply },
  run: async () => null,
});

export const awfStart = defineWorkflow({
  meta: { name: "start", description: "A reply can't start a run." },
  file: "/flows/start.ts",
  events: { change: Change, "thread:reply": ParticipantReply },
  // @ts-expect-error `starts` takes only the workflow's own events.
  starts: ["thread:reply"],
  run: async () => null,
});

export const stillCompiles = defineWorkflow({
  meta: { name: "old-routing", description: "The deprecated form." },
  events: { change: Change },
  async run(wf) {
    const thread: CodeParticipantRef = await wf.participants.connect({ key: "thread", to: "code" });
    await thread.post("Looking.");
    for (const e of await wf.receive()) if (thread.is(e)) void e.data.text;
    const next = await wf.race("reply", { reply: thread, quiet: "1d" });
    if (next.reply) void next.reply.text;
    // A spec held in a variable, which no excess-property check sets apart, still routes.
    const spec: CodeParticipantSpec = { key: "pager", to: "code" };
    const pager = await wf.participants.connect(spec);
    for (const e of await wf.receive()) if (pager.is(e)) void e.data.text;
    await wf.race("page", { reply: pager, quiet: "1d" });
    return null;
  },
});

// As before task 7: an end read from a loosely typed event narrows to `AgentEndedEvent`.
declare const loose: WorkflowEvent<string, JsonValue>;
declare function handleEnd(e: AgentEndedEvent<{ n: number }>): void;
declare function handleReply(e: ParticipantReplyEvent): void;
export async function looseEvents(inv: AgentRef, thread: CodeParticipantRef): Promise<void> {
  if (inv.is<{ n: number }>(loose)) handleEnd(loose);
  if (inv.is(loose)) void loose.data.outcome;
  if (thread.is(loose)) handleReply(loose);
}
