import type {
  AbsoluteDeadline,
  AgentForkSpec,
  AgentOpenSpec,
  AgentRef,
  AgentRunTextSpec,
  CompactSpec,
  ParallelOptions,
  SignalSpec,
  StepSpec,
  TurnOutcome,
  TurnRef,
  WorkflowCallSpec,
  WorkflowContext,
  WorkflowDefinition,
} from "./index";

declare const deadline: AbsoluteDeadline;
declare const context: WorkflowContext;
declare const agentRef: AgentRef;
declare const turnRef: TurnRef<string>;
declare const definition: WorkflowDefinition<null, string>;

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
const inheritedSignal = { id: "signal", name: "approval" } satisfies SignalSpec;
const inheritedCall = {
  id: "child",
  definition,
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
  // @ts-expect-error A nudge is a separately bounded operation, not a boolean toggle.
  const unboundedNudge: AgentRunTextSpec = { prompt: "Review", deadline, nudge: true };
  // @ts-expect-error Enqueued turns are bounded even when not immediately awaited.
  agentRef.enqueue({ id: "review", prompt: "Review" });
  // @ts-expect-error A manual nudge cannot inherit an implicit infinite deadline.
  turnRef.nudge();
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
  inheritedSignal,
  inheritedCall,
  inheritedStep,
  inheritedCompact,
  boundedCompact,
  terminalKind,
  rejectedShapes,
];
