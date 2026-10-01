// awf run packages/lab/src/review/lab/loop/propose.workflow.ts --cwd {try} --sandbox {spec} -- \
//   [--runtime codex/gpt-6-sol]
//
// The autoresearch loop's proposer (story 013): one agent reads `bundle/`, which awf-lab built
// from the tuning cases only, writes one changed review workflow to `candidate/workflow.ts`, and
// answers with its hypothesis. `bundle/program.md`, the operator's, steers it; the rules of the
// try are here. awf-lab checks the candidate's scope before anything runs it.
import {
  defineExecutableWorkflow,
  isAnswered,
  type WorkflowInvocation,
} from "@agentswf/contract/workflow";
import { runtimeOf } from "../../format/runtime";
import { type Hypothesis, HypothesisSchema } from "./format";
import { ALLOWED_IMPORTS } from "./scope";

type Args = { runtime: string };

const PROMPT = `You are the proposer in an autoresearch loop over a code-review workflow. Your working directory holds:

- \`bundle/program.md\`: the operator's program. Read it first and follow it.
- \`bundle/incumbent.ts\`: the workflow to improve, the best so far.
- \`bundle/feedback.json\`: how the incumbent did on each tuning case and trial: which known issues it hit, the judges' words on what it missed and what it would have had to look at, and hit rates by issue category and severity.
- \`bundle/history.json\`: every earlier try, its change, its prediction and what the comparison decided. Do not repeat a discarded idea unchanged.
- \`bundle/rules.json\`: how a try is judged, and the spend left.

Write one changed workflow to \`candidate/workflow.ts\`, and nothing else anywhere.

The rules of a try:

1. One hypothesis: change one thing about how the review works, such as the prompt, the shape (more agents, more turns, a planning or verifying step, lenses), or the model per stage, and say why it should find more of what was missed.
2. Aim at a gain the comparison can see. A change whose likely gain is under the resolution in rules.json will be undecided and wasted.
3. Describe failure behaviour in general terms. Never copy case content into the workflow: no file names, paths, identifiers, code or issue text from the feedback. It runs on cases you have not seen.
4. \`candidate/workflow.ts\` is one self-contained file. It imports only ${ALLOWED_IMPORTS.map((name) => `\`${name}\``).join(", ")}; it uses no Bun, process, fetch, require or dynamic import: only its agents look at the repository. It takes the incumbent's arguments and returns the incumbent's result shape.
5. Keep agents headless, and on the models rules.json allows.

Answer with the change, the hypothesis, the predicted effect, and the mechanism the records must show if it holds.`;

const executable = defineExecutableWorkflow<Args, Hypothesis>({
  definition: {
    meta: {
      name: "loop-proposer",
      description: "Write one changed review workflow from the tuning cases' feedback.",
    },
    async run(workflow, args) {
      const agent = await workflow.agents.open({
        key: "proposer",
        runtime: runtimeOf(args.runtime),
      });
      const { outcome } = await agent.run({ prompt: PROMPT, schema: HypothesisSchema });
      if (!isAnswered(outcome)) throw new Error(`no proposal: ${outcome.kind}: ${outcome.reason}`);
      // Checked against the schema by `wf result` as it was answered.
      return outcome.value as Hypothesis;
    },
  },
  prepare: (invocation: WorkflowInvocation) => {
    const [flag, value, ...rest] = invocation.argv;
    if (flag === undefined) return { runtime: "codex/gpt-6-sol" };
    if (flag !== "--runtime" || !value || rest.length > 0) {
      throw new Error("the proposer takes --runtime harness/model, or nothing");
    }
    return { runtime: value };
  },
  present: (hypothesis) => `${hypothesis.change}\n${hypothesis.predicted}`,
});

export default executable;
