import { defineWorkflow, isAnswered, tool } from "@agentswf/contract/workflow";
import Type from "typebox";

// #region open
export const Finding = Type.Object({
  file: Type.String({ minLength: 1 }),
  line: Type.Integer({ minimum: 1 }),
  problem: Type.String({ minLength: 1 }),
});
export type Finding = Type.Static<typeof Finding>;

export default defineWorkflow({
  meta: {
    name: "dead-code",
    description: "An agent records each finding through a tool.",
  },
  async run(wf) {
    const findings: Finding[] = [];
    const reviewer = await wf.agents.open({
      key: "reviewer",
      runtime: "codex",
      tools: {
        add_finding: tool<Finding>({
          description: "Record one finding as soon as you are sure of it.",
          input: Finding,
          handler: (finding) => {
            if (
              findings.some(
                (f) => f.file === finding.file && f.line === finding.line,
              )
            ) {
              throw new Error(
                `${finding.file}:${finding.line} is already recorded`,
              );
            }
            findings.push(finding);
            return `Recorded; ${findings.length} so far.`;
          },
        }),
        list_findings: tool({
          description: "The findings recorded so far, one per line.",
          handler: () =>
            findings
              .map((f) => `${f.file}:${f.line}  ${f.problem}`)
              .join("\n") || "None yet.",
        }),
      },
    });
    const { outcome } = await reviewer.run({
      prompt:
        "Find dead code in src/. Record each finding with add_finding as you go.",
      timeoutMs: 20 * 60_000,
    });
    // What the agent recorded is kept, however its turn ended.
    return {
      findings,
      ended: isAnswered(outcome) ? "answered" : outcome.reason,
    };
  },
});
// #endregion open
