// awf run packages/lab/src/cases/loop/propose.workflow.ts --cwd {try} -- [--runtime harness/model]
//
// A loop's proposer (story 044, task 12): one agent reads `bundle/`, which awf-lab built from the
// tuning cases alone, changes the copy of the code in `code/`, and answers with its hypothesis.
// `bundle/program.md`, the operator's, steers it; the rules of a try are here. It runs in the lab's
// box, which lets it write `code/` but not `code/evals/`, and awf-lab checks the change's scope
// before anything runs it.
import { defineWorkflow, type ExecutionConfig, type WorkflowInvocation } from "agentswf/workflow";
import { type Hypothesis, HypothesisSchema } from "../format/loop";

type Args = { runtime: string };

export const DEFAULT_PROPOSER = "claude/claude-sonnet-5-5";

const PROMPT = `You are the proposer in a loop that improves a workflow against cases with known answers. Your working directory holds:

- \`bundle/program.md\`: the operator's program. Read it first and follow it.
- \`bundle/feedback.json\`: how the current code did on each tuning case and trial: its facts, its outcome, and every grader's verdict, numbers, reasons and parts.
- \`bundle/history.json\`: every earlier try, its change, its prediction and what the comparison decided. Do not repeat a discarded idea unchanged.
- \`bundle/rules.json\`: how a try is judged, and the spend left.
- \`code/\`: a copy of the project's code, the best so far. \`code/evals/\` holds the dataset's env.ts and is read-only.

Change the code in \`code/\` and nothing else anywhere. Your shell is your only tool: read and write files with it.

The rules of a try:

1. One hypothesis: change one thing about how the workflow works, such as a prompt, its steps, or the model per stage, and say why it should do better on what the feedback shows it doing badly.
2. Aim at a gain the comparison can see; a change too small to show is wasted.
3. Describe failures in general terms. Never copy case content into the code: no names, values, text or files from the feedback. It runs on cases you have not seen.
4. Keep the workflow's arguments and its result's shape; do not touch \`code/evals/\` or any \`node_modules\`.

Answer with the change, the hypothesis, the predicted effect and its cost, and what the trials must show if it holds.`;

/** Every harness's effort levels: the lab may not import the harness package, so it repeats them. */
export const LEVELS: readonly string[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];

/** `harness/model[:effort]`, headless: the box has no terminal to put an agent in. */
export function proposerRuntime(name: string): ExecutionConfig {
  const slash = name.indexOf("/");
  if (slash <= 0 || slash === name.length - 1) {
    throw new Error(`the proposer is harness/model, not ${name}`);
  }
  const colon = name.lastIndexOf(":");
  const level = colon > slash ? name.slice(colon + 1) : undefined;
  const effort = level && LEVELS.includes(level) ? level : undefined;
  const harness = name.slice(0, slash);
  return {
    harness,
    model: name.slice(slash + 1, effort ? colon : undefined),
    ...(effort ? { effort } : {}),
    placement: "headless",
    // claude headless bills per token even on a subscription login: the loop's cap counts it.
    ...(harness === "claude" ? { metered: true } : {}),
  } as ExecutionConfig;
}

export default defineWorkflow<Args, Hypothesis>({
  meta: {
    name: "loop-proposer",
    description: "Change a copy of a workflow's code from the tuning cases' feedback.",
  },
  async run(wf, args) {
    const agent = await wf.agents.open({ key: "proposer", runtime: proposerRuntime(args.runtime) });
    const { outcome } = await agent.run({ prompt: PROMPT, schema: HypothesisSchema });
    if (!outcome.answered) throw new Error(`no proposal: ${outcome.kind}: ${outcome.reason}`);
    return outcome.value as Hypothesis;
  },
  prepare: (invocation: WorkflowInvocation) => {
    const [flag, value, ...rest] = invocation.argv;
    if (flag === undefined) return { runtime: DEFAULT_PROPOSER };
    if (flag !== "--runtime" || !value || rest.length > 0) {
      throw new Error("the proposer takes --runtime harness/model, or nothing");
    }
    return { runtime: value };
  },
  present: (hypothesis) => `${hypothesis.change}\n${hypothesis.predicted}`,
});
