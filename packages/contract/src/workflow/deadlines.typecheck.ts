import type {
  AbsoluteDeadline,
  AgentOpenSpec,
  AgentRef,
  AgentRunTextSpec,
  CompactSpec,
  ParallelOptions,
  SignalSpec,
  StepSpec,
  TurnRef,
  TurnOutcome,
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

function terminalKind(outcome: TurnOutcome<string>): string {
  return outcome.kind === "timed-out" ? outcome.reason : outcome.kind;
}

function rejectedShapes(): void {
  // @ts-expect-error A turn cannot wait without an absolute deadline.
  const missingTurnDeadline: AgentRunTextSpec = { prompt: "Review the change" };
  // @ts-expect-error A nudge is a separately bounded operation, not a boolean toggle.
  const unboundedNudge: AgentRunTextSpec = { prompt: "Review", deadline, nudge: true };
  // @ts-expect-error Parallel collection cannot be unbounded.
  const missingParallelDeadline: ParallelOptions = { concurrency: 2 };
  // @ts-expect-error Activation is a bounded operation.
  const missingOpenDeadline: AgentOpenSpec = { key: "reviewer", runtime: "default" };
  // @ts-expect-error Enqueued turns are bounded even when not immediately awaited.
  agentRef.enqueue({ id: "review", prompt: "Review" });
  // @ts-expect-error A manual nudge cannot inherit an implicit infinite deadline.
  turnRef.nudge();
  // @ts-expect-error Compaction is a bounded turn.
  const missingCompactDeadline: CompactSpec = { id: "compact", prompt: "Summarize" };
  // @ts-expect-error A step operation can wait and must be bounded.
  context.steps.run({ id: "step" } satisfies StepSpec, async () => null);
  // @ts-expect-error Signal receipt cannot wait forever.
  const missingSignalDeadline: SignalSpec = { id: "signal", name: "approval" };
  // @ts-expect-error Child workflow calls are bounded.
  const missingCallDeadline: WorkflowCallSpec<null, string> = {
    id: "child",
    definition,
    args: null,
  };
  // @ts-expect-error Parallel collection always requires bounded options.
  context.parallel([], async () => null);
  void [
    missingTurnDeadline,
    unboundedNudge,
    missingParallelDeadline,
    missingOpenDeadline,
    missingCompactDeadline,
    missingSignalDeadline,
    missingCallDeadline,
  ];
}

void [turn, parallel, terminalKind, rejectedShapes];
