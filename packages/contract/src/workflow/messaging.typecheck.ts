import type { AgentRef, JsonValue, OutputSchema, ParticipantRef, WorkflowContext } from "./index";
import { isAnswered } from "./index";

// The sketches in docs/design/messaging.md's "Routes by shape", as a workflow writes them.
declare const workflow: WorkflowContext;
declare const implementer: AgentRef;
declare const reviewer: AgentRef;
declare const architect: AgentRef;
declare const planner: AgentRef;
declare const critic: AgentRef;
declare const tester: AgentRef;
declare const runtime: string;
declare const LENSES: readonly { key: string }[];
declare const FIX_REPORT: OutputSchema<{ fixed: string[] }>;
declare const FINDINGS: OutputSchema<{ findings: number }>;
declare const PLAN: OutputSchema<{ steps: string[] }>;
declare function lensPrompt(key: string): string;
declare function planPrompt(ticket: string): string;
declare const ticket: string;

async function bothWays(): Promise<void> {
  await workflow.messages.allow({
    between: [implementer, reviewer],
    purpose: "Review and revise the implementation until both agree it is ready.",
  });
}

async function oneWayNothingOwed(): Promise<JsonValue> {
  const fixer = await workflow.agents.open({ key: "fixer", runtime });
  const lenses = await workflow.parallel(LENSES, (lens) =>
    workflow.agents.open({ key: lens.key, runtime }),
  );
  for (const lens of lenses) {
    await workflow.messages.allow({
      from: lens,
      to: fixer,
      purpose: "Report each finding as you confirm it, then `done`; the fixer does not reply.",
    });
  }
  const [fixed] = await Promise.all([
    fixer.run({
      prompt:
        "Fix each finding the lenses send; when every lens has said done, report what changed.",
      schema: FIX_REPORT,
    }),
    workflow.parallel(lenses, (lens) =>
      lens.run({ prompt: lensPrompt(lens.key), schema: FINDINGS }),
    ),
  ]);
  return isAnswered(fixed.outcome) ? fixed.outcome.value : null;
}

async function oneWayWithAnAnswer(): Promise<void> {
  await workflow.messages.allow({
    from: implementer,
    to: architect,
    purpose: "Ask about the design when the ticket document does not settle it.",
  });
}

async function room(): Promise<void> {
  const members = [planner, critic, tester];
  for (const [i, a] of members.entries()) {
    for (const b of members.slice(i + 1)) {
      await workflow.messages.allow({
        between: [a, b],
        purpose: "Agree the plan in PLAN.md; ask when an entry there is unclear.",
      });
    }
  }
}

async function lowerLimit(): Promise<void> {
  await workflow.messages.allow({
    between: [implementer, reviewer],
    purpose: "Review and revise the implementation until both agree it is ready.",
    maxMessages: 10,
  });
}

async function routeForOneStage(): Promise<{ steps: string[] }> {
  const plan = await workflow.stage("plan", { result: PLAN }, async () => {
    await workflow.messages.allow({
      from: planner,
      to: architect,
      purpose: "Ask about the design while drafting the plan.",
    });
    const { outcome } = await planner.run({ prompt: planPrompt(ticket), schema: PLAN });
    return isAnswered(outcome) ? outcome.value : workflow.stop(outcome.reason);
  });
  await workflow.agents.stop("architect", "design questions are settled");
  return plan;
}

async function refused(): Promise<void> {
  // A workflow names only participants the engine issued it.
  // @ts-expect-error A `{ key }` literal is not a ParticipantRef.
  const forged: ParticipantRef = { key: "reviewer" };
  await workflow.messages.allow({
    // @ts-expect-error Nor is one inline.
    from: { key: "reviewer" },
    to: implementer,
    purpose: "forged",
  });
  await workflow.messages.allow({
    // @ts-expect-error A route is one shape or the other.
    between: [implementer, reviewer],
    from: implementer,
    purpose: "both shapes",
  });
  void forged;
}

void [bothWays, oneWayNothingOwed, oneWayWithAnAnswer, room, lowerLimit, routeForOneStage, refused];
