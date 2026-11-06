// Checked by `tsc --noEmit`, never run: story 032's workflow and its test, as an author writes them.
import {
  defineWorkflow,
  type ParticipantRef,
  type WorkflowContext,
} from "@agentswf/contract/workflow";
import { answer, type ParticipantScript, testWorkflow } from ".";

declare const runtime: string;

const investigate = defineWorkflow<null, string>({
  meta: { name: "investigate", description: "watches checkout-api" },
  async run(wf: WorkflowContext) {
    const investigator = await wf.agents.open({ key: "investigator", runtime });
    const coordinator: ParticipantRef = await wf.participants.connect({
      key: "coordinator",
      labels: { audience: "operator" },
    });
    await wf.messages.allow({
      between: [investigator, coordinator],
      purpose: "report findings that hold up; ask when the logs can't settle it",
      timeout: "2h",
    });
    const { outcome } = await investigator.run({ prompt: "Check the checkout-api logs." });
    await coordinator.release("investigation done");
    // A run has no deadline unless `awf run --timeout` gives it one.
    const left = wf.deadline ? wf.deadline.getTime() - Date.now() : undefined;
    return outcome.answered ? `${outcome.value} (${left ?? "no"} ms left)` : outcome.kind;
  },
});

export async function story(): Promise<string> {
  const run = await testWorkflow(investigate, {
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
  if ("code" in sent) throw new Error(sent.code);
};

export async function refused(wf: WorkflowContext): Promise<void> {
  // @ts-expect-error bindingPath is gone: the socket's place is fixed.
  await wf.participants.connect({ key: "coordinator", bindingPath: "/tmp/x" });
}
