// A reviewer for awf-lab's tests: it returns the findings a file lists for the frozen head it is
// given, in a shape of its own, and echoes the range and the request's title it was handed. A head
// listed as "throw" fails the run.
import { defineExecutableWorkflow, type WorkflowInvocation } from "../../../packages/contract/src/workflow";

export type CannedFinding = { file: string; line: number; claim: string };
type Args = { answers: string; head: string; request: string; range: string };
export type CannedResult = { range: string; title: string; findings: CannedFinding[] };

const executable = defineExecutableWorkflow<Args, CannedResult>({
  definition: {
    meta: { name: "canned-review", description: "Return canned findings for a frozen head." },
    async run(_workflow, args) {
      const answers: Record<string, CannedFinding[] | "throw"> = await Bun.file(args.answers).json();
      const listed = answers[args.head] ?? [];
      if (listed === "throw") throw new Error("the canned reviewer was told to fail");
      const title = (await Bun.file(args.request).text()).split("\n")[0]!;
      return { range: args.range, title, findings: listed };
    },
  },
  prepare: (invocation: WorkflowInvocation) => {
    const values = new Map<string, string>();
    for (let i = 0; i < invocation.argv.length; i += 2) {
      values.set(invocation.argv[i]!.slice(2), invocation.argv[i + 1]!);
    }
    return {
      answers: values.get("answers")!,
      head: values.get("head")!,
      request: values.get("request")!,
      range: values.get("range")!,
    };
  },
});

export default executable;
