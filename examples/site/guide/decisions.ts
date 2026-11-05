// #region imports

import { typed } from "agentswf/typebox";
import {
  choice,
  DecisionError,
  defineWorkflow,
  score,
  yesNo,
} from "agentswf/workflow";
// #endregion imports
import Type from "typebox";

export const URGENCY = ["later", "this week", "now"] as const;

export const ROUTE = typed(
  Type.Object(
    {
      team: Type.Union([
        Type.Literal("payments"),
        Type.Literal("accounts"),
        Type.Literal("frontend"),
      ]),
      bug: Type.Boolean(),
      urgency: Type.Union([
        Type.Literal("later"),
        Type.Literal("this week"),
        Type.Literal("now"),
      ]),
    },
    { additionalProperties: false },
  ),
);

export type Routed = Type.Static<typeof ROUTE> & { by: "decision" | "agent" };

// #region kinds
export const QUESTIONS = {
  team: choice("Which team owns `ticket`?", {
    payments: "Checkout, billing and refunds",
    accounts: "Sign-in, sign-up and permissions",
    frontend: null,
  }),
  bug: yesNo("Does `ticket` report something broken?", {
    yes: "something that worked no longer does",
    no: "a request for something new or different",
  }),
  urgency: score("How soon does `ticket` need a fix?", URGENCY),
};
// #endregion kinds

export default defineWorkflow<{ ticket: string }, Routed>({
  meta: {
    name: "route",
    description: "Route a support ticket to a team, by decision or by agent.",
  },
  async run(wf, { ticket }) {
    // #region route
    const decided = await wf.decisions
      .decide({
        key: "route",
        model: "jev",
        state: { ticket },
        questions: QUESTIONS,
      })
      .catch((error: unknown) => {
        if (error instanceof DecisionError) return undefined; // the agent decides instead
        throw error;
      });

    if (decided) {
      const { team, bug, urgency } = decided.answers;
      const sure =
        team.probabilities[team.choice] >= 0.9 &&
        Math.abs(bug.yes - 0.5) >= 0.4;
      if (sure) {
        // `expected` is the probability-weighted level, 0 to 2 here.
        const level =
          urgency.expected >= 1.5 ? 2 : urgency.expected >= 0.5 ? 1 : 0;
        return {
          team: team.choice,
          bug: bug.yes >= 0.5,
          urgency: URGENCY[level],
          by: "decision",
        };
      }
    }

    const router = await wf.agents.open({ key: "router", runtime: "codex" });
    const { outcome } = await router.run({
      prompt:
        "Find the code this ticket is about. " +
        `Which team owns it, is it a bug, how urgent?\n\n${ticket}`,
      schema: ROUTE,
    });
    if (!outcome.answered) return wf.stop(`${outcome.kind}: ${outcome.reason}`);
    return { ...outcome.value, by: "agent" };
    // #endregion route
  },
  prepare: ({ argv }) => ({ ticket: argv.join(" ") }),
});
