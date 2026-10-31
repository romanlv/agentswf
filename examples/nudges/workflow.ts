import { type Duration, defineWorkflow } from "@agentswf/contract/workflow";
import Type from "typebox";
import { outputSchema } from "../output-schema";
import { Ledger } from "./ledger";

/**
 * A question for the engineer, how long to wait before each nudge, how long a "later" puts the
 * next one off, and how many nudges before giving up: `"4h"`, `"1d"` and 3 in earnest.
 */
export const Asked = outputSchema(
  Type.Object({
    question: Type.String(),
    nudgeAfter: Type.String(),
    putOff: Type.String(),
    maxNudges: Type.Number(),
  }),
);

export const Nudge = outputSchema(Type.Object({ text: Type.String() }));

/**
 * Story 037's time read from state: a question waits for the engineer's answer, nudging while it
 * waits. The next nudge's time lives in the run's ledger, and the select's `nudge` branch reads it
 * at each wait: a nudge sets the next one, a reply of "later" moves it, and an answer clears it. No
 * timer per nudge, no name per move, no stale nudge to ignore. The ledger is a file,
 * `.nudges/{run id}.json` under the run's cwd, so a parked run reads it again when it wakes.
 */
export default defineWorkflow({
  meta: {
    name: "nudges",
    description: "Asks the engineer a question, nudging until it is answered.",
  },
  file: import.meta.path,
  events: { "question.asked": Asked },
  starts: ["question.asked"],
  async run(workflow) {
    const asked = workflow.started;
    if (asked?.name !== "question.asked")
      return workflow.stop("started by hand: send question.asked");
    const { question, nudgeAfter, putOff, maxNudges } = asked.data;
    const ledger = await Ledger.open(`${workflow.cwd}/.nudges/${workflow.runId}.json`, () =>
      workflow.after(nudgeAfter as Duration),
    );
    const engineer = await workflow.participants.connect({ key: "engineer", to: "code" });
    await workflow.stage("ask", () => engineer.post(question));
    const writer = await workflow.agents.open({
      key: "writer",
      runtime: { harness: "codex", model: "gpt-6-luna", effort: "low", placement: "headless" },
    });
    for await (const next of workflow.select(
      { reply: engineer, nudge: workflow.at(() => ledger.nextNudge()) },
      { label: () => `awaiting an answer, ${ledger.nudges} nudged` },
    )) {
      if (next.reply) {
        // A stand-in for reading a reply: one that starts "later" asks for time.
        if (/^later\b/i.test(next.reply.text.trim())) {
          await ledger.putOff(workflow.after(putOff as Duration));
          continue;
        }
        await ledger.answered();
        return { answer: next.reply.text, nudges: ledger.nudges };
      }
      if (next.nudge) {
        const n = ledger.nudges + 1;
        await workflow.stage(`nudge-${n}`, async () => {
          const drafted = await writer.run({
            prompt: `Write one short, friendly sentence nudging an engineer to answer this question: "${question}". This is nudge ${n} of ${maxNudges}.`,
            schema: Nudge,
          });
          const text =
            drafted.outcome.kind === "answered" ? drafted.outcome.value.text : `Nudge: ${question}`;
          await engineer.post(text);
        });
        if (n >= maxNudges) {
          await ledger.nudged(null);
          return { answer: null, nudges: n };
        }
        await ledger.nudged(workflow.after(nudgeAfter as Duration));
      }
    }
    return { answer: null, nudges: ledger.nudges };
  },
});
