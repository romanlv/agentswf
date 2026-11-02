import {
  defineWorkflow,
  type RuntimeSelection,
} from "@agentswf/contract/workflow";

// #region cheap
export const SMALL = {
  harness: "codex",
  model: "gpt-6-luna", // a small model for a small job
  effort: "low", // less reasoning, fewer output tokens
  placement: "headless", // on your ChatGPT plan either way; nothing to watch
} satisfies RuntimeSelection;
// #endregion cheap

export default defineWorkflow({
  meta: {
    name: "summarize",
    description:
      "Summarize the branch's change on claude while its plan has room, else on codex.",
  },
  async run(wf) {
    // #region allowance
    const plan = await wf.allowance("claude");
    // counts the windows every model draws on, not one of some models' only; `none` is unknown
    const roomy =
      plan.read === "plan" &&
      plan.windows.every((w) => w.models || w.usedPercent < 80);
    const writer = await wf.agents.open({
      key: "writer",
      runtime: roomy ? "claude" : SMALL,
    });
    // #endregion allowance
    const summary = await writer.run({
      prompt: "Summarize the change on this branch in a line.",
    });
    // #region usage
    for (const turn of wf.usage()) {
      if (turn.deliveredAt && turn.settledAt) {
        const seconds =
          (Date.parse(turn.settledAt) - Date.parse(turn.deliveredAt)) / 1000;
        wf.log("turn", {
          agent: turn.agent,
          model: turn.execution.model,
          seconds,
        });
      }
    }
    // #endregion usage
    return summary.outcome.answered
      ? summary.outcome.value
      : summary.outcome.kind;
  },
});
