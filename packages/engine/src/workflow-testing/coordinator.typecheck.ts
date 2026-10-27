// Checked by `tsc --noEmit`, never run: story 032's workflow and its test, as an author writes them.
import {
  type ExternalParticipantRef,
  isAnswered,
  type WorkflowContext,
  type WorkflowDefinition,
} from "@agentswf/contract/workflow";
import { answer, type ParticipantScript, testWorkflow } from ".";

declare const runtime: string;

const investigate: WorkflowDefinition<null, string> = {
  meta: { name: "investigate", description: "watches checkout-api" },
  async run(workflow: WorkflowContext) {
    const investigator = await workflow.agents.open({ key: "investigator", runtime });
    const coordinator: ExternalParticipantRef = await workflow.participants.connect({
      key: "coordinator",
      labels: { audience: "operator" },
    });
    await workflow.messages.allow({
      between: [investigator, coordinator],
      purpose: "report findings that hold up; ask when the logs can't settle it",
      timeoutMs: 2 * 60 * 60_000,
    });
    const { outcome } = await investigator.run({ prompt: "Check the checkout-api logs." });
    await coordinator.release("investigation done");
    // A run has no deadline unless `awf run --timeout` gives it one.
    const left = workflow.deadline ? workflow.deadline.unixMilliseconds - Date.now() : undefined;
    return isAnswered(outcome) ? `${outcome.value} (${left ?? "no"} ms left)` : outcome.kind;
  },
};

export async function story(): Promise<string> {
  const run = await testWorkflow(investigate, null, {
    agents: { investigator: [answer("…")] },
    participants: {
      coordinator: (event) =>
        event.kind === "message" && event.asks
          ? event.reply("Keep two, and link them.")
          : undefined,
    },
  });
  return run.value;
}

export const sendsFirst: ParticipantScript = async (event) => {
  if (event.kind !== "route") return;
  const sent = await event.send("Also check the 09:12 deploy.");
  if (sent.code !== "delivered") throw new Error(sent.code);
};

export async function refused(workflow: WorkflowContext): Promise<void> {
  // @ts-expect-error bindingPath is gone: the socket's place is fixed.
  await workflow.participants.connect({ key: "coordinator", bindingPath: "/tmp/x" });
}
