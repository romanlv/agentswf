// Checked by `tsc --noEmit`, never run: what `agentswf/workflow` offers an author, and what it
// doesn't, the names story 039 deprecated and then removed included.

import {
  AgentEnded,
  type AgentRef,
  type CallerRef,
  type Duration,
  defineWorkflow,
  duration,
  type JsonValue,
  type OutputSchema,
  type ParticipantRef,
  ParticipantReply,
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
// @ts-expect-error Every workflow has one context: `WorkflowContext<Events>`.
export type EventContext = import("./workflow").EventWorkflowContext<Events>;
// @ts-expect-error Every agent is an `AgentRef`.
export type EventAgent = import("./workflow").EventAgentRef;
// @ts-expect-error `AgentOpenSpec` holds `keepAlive`.
export type EventOpenSpec = import("./workflow").EventAgentOpenSpec;
// @ts-expect-error Every workflow's agents are one `AgentDirectory`.
export type EventAgents = import("./workflow").EventAgentDirectory;
// @ts-expect-error A participant's messages reach the code by `{key}:reply`, declared.
export type CodeRef = import("./workflow").CodeParticipantRef;
// @ts-expect-error A participant's messages reach the code by `{key}:reply`, declared.
export type CodeSpec = import("./workflow").CodeParticipantSpec;
// @ts-expect-error Every participant is connected by `ParticipantDirectory`.
export type CodeDirectory = import("./workflow").CodeParticipantDirectory;
// @ts-expect-error An agent's end is the declared `{key}:ended`, one of the workflow's events.
export type EndedEvent = import("./workflow").AgentEndedEvent;
// @ts-expect-error A participant's message is the declared `{key}:reply`.
export type ReplyEvent = import("./workflow").ParticipantReplyEvent;
// @ts-expect-error A pane is `pane: PaneSpec`; where it goes is the operator's.
export type Layout = import("./workflow").PaneLayout;
// @ts-expect-error Check `outcome.answered`.
export const answered = import("./workflow").then((surface) => surface.isAnswered);
// @ts-expect-error `defineWorkflow`, with meta and run beside prepare.
export const executable = import("./workflow").then((surface) => surface.defineExecutableWorkflow);

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

export async function removedForms(): Promise<void> {
  const reviewer = await wf.agents.open({ key: "r", runtime: "claude" });
  // @ts-expect-error Nothing read an agent's labels.
  await wf.agents.open({ key: "r1", runtime: "claude", labels: { lens: "x" } });
  // @ts-expect-error Nothing read a fork's labels.
  await reviewer.fork({ key: "r2", labels: { lens: "y" } });
  // @ts-expect-error A call's id: a stage keeps a call from running twice.
  await reviewer.run({ id: "turn-1", prompt: "Review." });
  // @ts-expect-error A compaction takes no id.
  await reviewer.compact({ id: "c-1", prompt: "Keep the findings." });
  // @ts-expect-error A switch takes no id.
  await reviewer.set({ id: "s-1", effort: "high" });
  // @ts-expect-error A started turn takes no id.
  await reviewer.start({ id: "turn-2", prompt: "Again." });
  // @ts-expect-error A stage returns its result, not a batch; receive() in one is refused at run time.
  await wf.stage("first", () => wf.receive());
  const turn = await reviewer.start({ prompt: "Again." });
  // @ts-expect-error A wait names the agent, { done: reviewer }, not its started turn.
  await wf.race("review", { done: turn, quiet: "1d" });
  // @ts-expect-error Nor does select take a started turn.
  for await (const next of wf.select({ done: turn })) void next;
  // @ts-expect-error agent.is(e), since an agent has at most one started turn.
  void turn.is;
  // @ts-expect-error A fork's placement, metered and effort go in its runtime.
  await reviewer.fork({ key: "w2", placement: "headless" });
  // @ts-expect-error The same for the calling session's fork.
  await plain.agents.forkCaller({ key: "me2", effort: "low" });
  // @ts-expect-error close() on the agent's ref.
  await plain.agents.stop("r", "done");
  // @ts-expect-error A pane is pane: { tab } or { beside, side }.
  await wf.agents.open({ key: "p", runtime: "claude", layout: { tab: "review" } });
  // @ts-expect-error Keeping panes is the operator's, awf run --keep-panes.
  await wf.agents.open({ key: "q", runtime: "claude", keepPane: "always" });
  // @ts-expect-error A participant's messages reach the code by its declared {key}:reply.
  await wf.participants.connect({ key: "thread", to: "code" });
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

export async function removedTime(): Promise<void> {
  const deadline = { unixMilliseconds: Date.now() + 60_000 };
  const reviewer = await wf.agents.open({ key: "r", runtime: "claude" });
  // @ts-expect-error timeout: a Date, or a Duration.
  await wf.agents.open({ key: "r1", runtime: "claude", deadline });
  // @ts-expect-error timeout, a Duration such as "10m".
  await reviewer.run({ prompt: "Review.", timeoutMs: 60_000 });
  // @ts-expect-error The turn's timeout bounds its check-ins.
  await reviewer.run({ prompt: "Review.", nudge: { deadline } });
  // @ts-expect-error timeout: a Date, or a Duration.
  await reviewer.run({ prompt: "Review.", deadline });
  // @ts-expect-error timeout, a Duration.
  await reviewer.compact({ prompt: "Keep it.", timeoutMs: 60_000 });
  // @ts-expect-error timeout: a Date, or a Duration.
  await reviewer.set({ effort: "high", deadline });
  // @ts-expect-error timeout: a Date, or a Duration.
  await plain.parallel([1], async (n) => n, { deadline });
  // @ts-expect-error timeout: a Date, or a Duration.
  await plain.decisions.decide({ key: "ok", model: "jev", state: "x", questions: {}, deadline });
  // @ts-expect-error keepAlive's window, a Duration.
  await wf.agents.open({ key: "k", runtime: "claude", keepAlive: { timeoutMs: 90_000 } });
  // @ts-expect-error A tool's timeout, a Duration or false.
  tool({ description: "Look.", handler: () => "seen", timeoutMs: false });
  // @ts-expect-error A route's timeout, a Duration.
  await wf.messages.allow({ from: reviewer, to: reviewer, purpose: "p", timeoutMs: 60_000 });
  // @ts-expect-error wf.deadline is a Date: wf.deadline.getTime().
  void plain.deadline?.unixMilliseconds;
}

export const whenToUse = defineWorkflow({
  // @ts-expect-error Nothing read meta.whenToUse.
  meta: { name: "old", description: "Says when.", whenToUse: "Never." },
  run: async () => null,
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

// A loosely typed event narrows to the agent's end under its declared name.
declare const loose: WorkflowEvent<string, JsonValue>;
export async function looseEvents(inv: AgentRef): Promise<void> {
  if (inv.is<{ n: number }>(loose)) void loose.data.meta.n;
  if (inv.is(loose)) void loose.data.outcome;
}
