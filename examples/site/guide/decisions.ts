import {
  choice,
  DecisionError,
  defineWorkflow,
  isAnswered,
  score,
  yesNo,
} from "@agentswf/contract/workflow";
import Type from "typebox";

export const ROUTE = Type.Object(
  {
    team: Type.Union([
      Type.Literal("payments"),
      Type.Literal("accounts"),
      Type.Literal("frontend"),
    ]),
    bug: Type.Boolean(),
  },
  { additionalProperties: false },
);

export type Routed = Type.Static<typeof ROUTE> & { by: "decision" | "agent" };

// #region kinds
export const kinds = {
  team: choice("Which team owns `ticket`?", { payments: "Checkout and billing", accounts: null }),
  urgency: score("How soon does `ticket` need a fix?", ["later", "this week", "now"]),
  bug: yesNo("Is `ticket` a bug report?", { yes: "something is broken", no: "a request" }),
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
        questions: {
          team: choice("Which team owns `ticket`?", {
            payments: "Checkout, billing and refunds",
            accounts: "Sign-in, sign-up and permissions",
            frontend: "Layout, styling and new screens",
          }),
          bug: yesNo("Does `ticket` report something broken, rather than ask for a change?"),
        },
      })
      .catch((error: unknown) => {
        if (error instanceof DecisionError) return undefined; // the agent decides instead
        throw error;
      });

    if (decided) {
      const { team, bug } = decided.answers;
      const sure = team.probabilities[team.choice] >= 0.9 && Math.abs(bug.yes - 0.5) >= 0.4;
      if (sure) return { team: team.choice, bug: bug.yes >= 0.5, by: "decision" };
    }

    const router = await wf.agents.open({ key: "router", runtime: "codex" });
    const { outcome } = await router.run<Type.Static<typeof ROUTE>>({
      prompt: `Find the code this ticket is about. Which team owns it, and is it a bug?\n\n${ticket}`,
      schema: ROUTE,
    });
    if (!isAnswered(outcome)) return wf.stop(`${outcome.kind}: ${outcome.reason}`);
    return { ...outcome.value, by: "agent" };
    // #endregion route
  },
  prepare: ({ argv }) => ({ ticket: argv.join(" ") }),
});
