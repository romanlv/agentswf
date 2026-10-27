import type {
  AbsoluteDeadline,
  AgentForkSpec,
  AgentOpenSpec,
  AgentRef,
  AgentRunTextSpec,
  CompactSpec,
  ParallelOptions,
  StepSpec,
  TurnOutcome,
  WorkflowCallSpec,
  WorkflowContext,
  WorkflowDefinition,
} from "./index";

declare const deadline: AbsoluteDeadline;
declare const context: WorkflowContext;
declare const agentRef: AgentRef;
declare const workflow: WorkflowDefinition<null, string>;

const turn = {
  prompt: "Review the change",
  deadline,
  nudge: { deadline },
} satisfies AgentRunTextSpec;

const parallel = { deadline, concurrency: 2 } satisfies ParallelOptions;
const inheritedTurn = { prompt: "Review the change", nudge: {} } satisfies AgentRunTextSpec;
const disabledNudge = { prompt: "Review the change", nudge: false } satisfies AgentRunTextSpec;
const inheritedParallel = { concurrency: 2 } satisfies ParallelOptions;
const inheritedOpen = { key: "reviewer", runtime: "default" } satisfies AgentOpenSpec;
const inheritedCall = {
  id: "child",
  workflow,
  args: null,
} satisfies WorkflowCallSpec<null, string>;
const inheritedStep = { id: "step" } satisfies StepSpec;
const inheritedCompact = { prompt: "Keep the plan." } satisfies CompactSpec;
const boundedCompact = { prompt: "Keep the plan.", timeoutMs: 60_000 } satisfies CompactSpec;
// A fork is bounded by the workflow scope, as an agent's opening is.
const inheritedFork = { key: "tests" } satisfies AgentForkSpec;

function terminalKind(outcome: TurnOutcome<string>): string {
  return outcome.kind === "timed-out" ? outcome.reason : outcome.kind;
}

function rejectedShapes(): void {
  // @ts-expect-error Automatic recovery accepts options or false, never true.
  const unboundedNudge: AgentRunTextSpec = { prompt: "Review", deadline, nudge: true };
  void unboundedNudge;
}

void [
  inheritedFork,
  turn,
  parallel,
  inheritedTurn,
  disabledNudge,
  inheritedParallel,
  inheritedOpen,
  inheritedCall,
  inheritedStep,
  inheritedCompact,
  boundedCompact,
  terminalKind,
  rejectedShapes,
];
