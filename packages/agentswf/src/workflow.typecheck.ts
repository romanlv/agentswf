// Checked by `tsc --noEmit`, never run: what `agentswf/workflow` offers an author, and what it
// doesn't. Each deprecated name compiles until story 039's last task removes it.

import {
  type AgentDirectory,
  type AgentOpenSpec,
  type AgentRef,
  defineExecutableWorkflow,
  defineWorkflow,
  type EventAgentDirectory,
  type EventAgentOpenSpec,
  type EventAgentRef,
  type EventWorkflowContext,
  isAnswered,
  type OutputSchema,
  type WorkflowContext,
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
