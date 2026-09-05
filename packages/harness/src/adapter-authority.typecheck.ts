import type { AgentStructuredTurnSpec, OutputSchema } from "@wf/contract/workflow";
import type {
  AgentSessionAdapter,
  HarnessActivation,
  HarnessNudgeSpec,
  HarnessOperationBinding,
  HarnessSession,
  HarnessTurnOutcome,
} from "./adapter";

declare const session: HarnessSession;
declare const schema: OutputSchema<{ verdict: string }>;
declare const binding: HarnessOperationBinding;
declare const adapter: AgentSessionAdapter;
declare const activation: HarnessActivation;
declare const nudge: HarnessNudgeSpec;

const turn = {
  id: "review",
  prompt: "Review the change",
  deadline: { unixMilliseconds: 1_800_000_000_000 },
  schema,
} satisfies AgentStructuredTurnSpec<{ verdict: string }>;

const localOutcome = {
  state: "completed",
  resultEvidence: { kind: "unavailable" },
  nativeUsage: [],
} satisfies HarnessTurnOutcome;

async function boundStart(): Promise<void> {
  const started = await session.start(turn, binding);
  await started.nudge(nudge);
  await session.compact("compact", "Summarize", turn.deadline);
  // @ts-expect-error The engine-created operation binding is mandatory.
  await session.start(turn);
  // @ts-expect-error Harness activation is bounded.
  const unboundedActivation: HarnessActivation = {
    key: "reviewer",
    cwd: ".",
    execution: { harness: "codex", model: "default" },
  };
  // @ts-expect-error Harness nudges are separately bounded.
  await started.nudge({ id: "review:nudge" });
  // @ts-expect-error A nudge cannot replace engine-owned operation authority.
  await started.nudge(nudge, binding);
  // @ts-expect-error Harness compaction is bounded.
  await session.compact("compact", "Summarize");

  const activated = await adapter.activate(activation);
  const nativeFork = activated.capabilities.nativeFork;
  if (nativeFork) await nativeFork.fork(turn.deadline);
  // @ts-expect-error Unsupported native fork is a literal false, not an optional method.
  if (!nativeFork) await nativeFork.fork(turn.deadline);

  const engineOutcome: HarnessTurnOutcome = {
    state: "completed",
    resultEvidence: { kind: "unavailable" },
    nativeUsage: [],
    // @ts-expect-error Harness-local outcomes do not carry engine-owned logical identity.
    agent: "reviewer",
  };
  void [unboundedActivation, engineOutcome];
}

void [localOutcome, boundStart];
