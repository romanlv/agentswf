import type {
  AgentForkSpec,
  AgentOpenSpec,
  AgentRef,
  AgentRunTextSpec,
  CompactSpec,
  ParallelOptions,
  TurnOutcome,
  WorkflowContext,
} from "./index";

declare const context: WorkflowContext;
declare const agentRef: AgentRef;

const turn = { prompt: "Review the change", timeout: "20m", nudge: {} } satisfies AgentRunTextSpec;

const parallel = { timeout: new Date(), concurrency: 2 } satisfies ParallelOptions;
const inheritedTurn = { prompt: "Review the change", nudge: {} } satisfies AgentRunTextSpec;
const disabledNudge = { prompt: "Review the change", nudge: false } satisfies AgentRunTextSpec;
const inheritedParallel = { concurrency: 2 } satisfies ParallelOptions;
const inheritedOpen = { key: "reviewer", runtime: "default" } satisfies AgentOpenSpec;
const inheritedCompact = { prompt: "Keep the plan." } satisfies CompactSpec;
const boundedCompact = { prompt: "Keep the plan.", timeout: "1m" } satisfies CompactSpec;
// A fork is bounded by the workflow scope, as an agent's opening is.
const inheritedFork = { key: "tests" } satisfies AgentForkSpec;

function terminalKind(outcome: TurnOutcome<string>): string {
  return outcome.kind === "timed-out" ? outcome.reason : outcome.kind;
}

function rejectedShapes(): void {
  // @ts-expect-error Automatic recovery accepts options or false, never true.
  const unboundedNudge: AgentRunTextSpec = { prompt: "Review", nudge: true };
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
  inheritedCompact,
  boundedCompact,
  terminalKind,
  rejectedShapes,
];
