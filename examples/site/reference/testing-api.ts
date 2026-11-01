import { defineWorkflow, isAnswered, type OutputSchema } from "@agentswf/contract/workflow";
import Type from "typebox";

export const investigate = defineWorkflow({
  meta: { name: "investigate", description: "An investigator asks a coordinator outside the run." },
  async run(wf) {
    const investigator = await wf.agents.open({
      key: "investigator",
      runtime: { alias: "codex", placement: "headless" },
    });
    const coordinator = await wf.participants.connect({ key: "coordinator" });
    await wf.messages.allow({
      between: [investigator, coordinator],
      purpose: "Ask when the logs can't settle it.",
    });
    const { outcome } = await investigator.run({
      prompt: "Find why checkout times out. Ask the coordinator how to file what you find.",
    });
    return isAnswered(outcome) ? outcome.value : outcome.kind;
  },
});

const Changed = Type.Object({ case: Type.String() }, { additionalProperties: false });
export const CHANGED: OutputSchema<Type.Static<typeof Changed>> = Changed;

export const caseRun = defineWorkflow({
  meta: {
    name: "case-run",
    description: "Investigate a case, and again on each reply in its thread.",
  },
  file: import.meta.path,
  events: { "case.changed": CHANGED },
  starts: ["case.changed"],
  async run(wf) {
    const started = wf.started;
    if (started?.name !== "case.changed") return wf.stop("started by hand: send case.changed");
    const name = started.data.case;
    const investigator = await wf.agents.open({ key: "investigator", runtime: "claude" });
    const thread = await wf.participants.connect({ key: "thread", to: "code" });
    await investigator.run({ prompt: `Investigate cases/${name}/case.md and update it.` });
    for await (const next of wf.select(
      { reply: thread },
      { label: `waiting on the thread about ${name}` },
    )) {
      if (next.reply) await investigator.run({ prompt: `The thread replied: ${next.reply.text}` });
    }
    return null;
  },
});

export const DOC = Type.Object({ path: Type.String() }, { additionalProperties: false });
export const BRANCH = Type.Object({ branch: Type.String() }, { additionalProperties: false });
export const QA = Type.Object({ preview: Type.String() }, { additionalProperties: false });

export const flow = defineWorkflow({
  meta: { name: "flow", description: "Review a doc, implement it, then check a preview." },
  async run(wf) {
    const worker = await wf.agents.open({ key: "worker", runtime: "claude" });
    const doc = await wf.stage("doc-review", { result: DOC }, async () => {
      const { outcome } = await worker.run<Type.Static<typeof DOC>>({
        prompt: "Review the ticket doc, and give its path.",
        schema: DOC,
      });
      return isAnswered(outcome) ? outcome.value : wf.stop(`doc-review: ${outcome.reason}`);
    });
    const built = await wf.stage("implement", { result: BRANCH }, async () => {
      const { outcome } = await worker.run<Type.Static<typeof BRANCH>>({
        prompt: `Implement ${doc.path} on a branch.`,
        schema: BRANCH,
      });
      if (!isAnswered(outcome)) return wf.stop(`implement: ${outcome.reason}`);
      await worker.compact({ prompt: "Keep the branch, and what is left to check." });
      return outcome.value;
    });
    const { outcome } = await worker.run<Type.Static<typeof QA>>({
      prompt: `Check a preview of ${built.branch}.`,
      schema: QA,
    });
    return isAnswered(outcome) ? outcome.value.preview : outcome.reason;
  },
});
