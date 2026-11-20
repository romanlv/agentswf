// A grader that is a workflow: three Haiku voters each read the reply the customer got and say
// whether it is courteous, and the majority decides. awf-lab runs it after the code graders, in an
// `awf run` of its own, and stores each vote; `awf-lab report --case {name}` shows them. Bump
// `meta.version`'s minor when the question or the voters change, so `awf-lab score` grades again.
import { gradeCase } from "@agentswf/lab/cases";
import { typed } from "agentswf/typebox";
import { defineWorkflow } from "agentswf/workflow";
import Type from "typebox";

const QUESTION =
  "Is this reply courteous: polite, and never blaming or lecturing the customer? Judge its manner only, not whether its decision is right.";

const VOTE = typed(
  Type.Object({ courteous: Type.Boolean(), why: Type.String() }, { additionalProperties: false }),
);

type Vote = { by: string; verdict: "passed" | "failed"; why: string };
type ToneGrade = {
  verdict?: "passed" | "failed" | "undecided";
  notApplies?: string;
  reasons: { about: string; text: string }[];
  parts: {
    about: string;
    verdict: "passed" | "failed" | "undecided";
    why: string;
    settled: "agreed" | "majority" | "unsettled";
    votes: Vote[];
  }[];
};

export default defineWorkflow<null, ToneGrade>({
  meta: {
    name: "refund-desk-tone",
    version: "1.1.0",
    description: "Three voters judge whether the reply to the customer is courteous.",
  },
  async run(wf) {
    const { facts } = gradeCase();
    const reply = String(facts?.reply ?? "").trim();
    if (reply === "") return { notApplies: "no reply was posted", reasons: [], parts: [] };

    // The reply is the workflow's text, possibly echoing the customer's: data to the voters, never
    // instructions. They read nothing and reach only their model.
    const answers = await wf.parallel(
      ["1", "2", "3"],
      async (n): Promise<Vote | undefined> => {
        const agent = await wf.agents.open({
          key: `voter-${n}`,
          runtime: {
            harness: "claude",
            model: "claude-haiku-5-5",
            placement: "headless",
            metered: true,
          },
          sandbox: { srt: {}, write: [], network: [] },
        });
        const { outcome } = await agent.run({
          prompt: `${QUESTION}\n\n<reply>\n${reply}\n</reply>`,
          schema: VOTE,
          timeout: "2m",
        });
        await agent.close();
        if (!outcome.answered) return undefined;
        const { courteous, why } = outcome.value;
        return { by: `voter-${n}`, verdict: courteous ? "passed" : "failed", why };
      },
      { label: "Voters" },
    );
    const votes = answers.filter((vote): vote is Vote => vote !== undefined);
    const yes = votes.filter((v) => v.verdict === "passed").length;
    const no = votes.length - yes;
    const verdict = yes >= 2 ? "passed" : no >= 2 ? "failed" : "undecided";
    const settled =
      verdict === "undecided" ? "unsettled" : yes === 3 || no === 3 ? "agreed" : "majority";
    const deciding = votes.find((v) => v.verdict === verdict);
    return {
      verdict,
      reasons: [
        { about: "tone", text: `${yes} of ${votes.length} voters found the reply courteous` },
      ],
      parts: [{ about: "courteous", verdict, why: deciding?.why ?? "", settled, votes }],
    };
  },
});
