import {
  choice,
  defineExecutableWorkflow,
  score,
  type WorkflowInvocation,
  yesNo,
} from "@wf/contract/workflow";

/** Synthetic tickets, so a run sends nothing private. */
const SAMPLE_TICKETS = [
  "Checkout charges the card twice when the customer presses Pay again after a timeout.",
  "The settings page would look nicer with the save button on the right.",
  "Since this morning nobody can log in: the sign-in page returns a 500.",
  "Could you add dark mode to the dashboard?",
] as const;

const URGENCY = ["later", "this week", "now"] as const;

/**
 * Below this top probability an answer is flagged rather than taken. On matching, answers at 0.9
 * or above were right 117 times in 118 (docs/findings/system-one-models.md, S8).
 */
const CONFIDENT = 0.9;

/** The call, as a function other workflows could import: one state, three questions about it. */
export function triageTicket(id: string, ticket: string) {
  return {
    key: `triage:${id}`,
    model: "jev",
    state: { ticket },
    questions: {
      team: choice("Which team owns `ticket`?", {
        payments: "Checkout, billing and refunds",
        accounts: "Sign-in, sign-up and permissions",
        frontend: "Layout, styling and new screens",
      }),
      bug: yesNo("Does `ticket` report something that is broken, rather than ask for a change?"),
      urgency: score("How soon does `ticket` need a fix?", URGENCY),
    },
  };
}

export type TriageArgs = { tickets: string[] };

export type Triage = {
  ticket: string;
  team: string;
  bug: boolean;
  urgency: (typeof URGENCY)[number];
  /** The answers below `CONFIDENT`: a person or an agent should look at these. */
  unsure: string[];
};

export type TriageResult = { triaged: Triage[] };

const executable = defineExecutableWorkflow<TriageArgs, TriageResult>({
  definition: {
    meta: {
      name: "triage",
      description: "Route support tickets with a decision model: team, bug or not, and urgency.",
      whenToUse:
        "Use to see a decision model answer typed questions with probabilities, for well under a cent.",
    },
    async run(workflow, { tickets }) {
      const triaged = await workflow.parallel(
        tickets,
        async (ticket, index): Promise<Triage> => {
          const { answers } = await workflow.decisions.decide(triageTicket(`${index + 1}`, ticket));
          const { team, bug, urgency } = answers;
          const unsure = [
            ...(team.probabilities[team.choice] < CONFIDENT ? ["team"] : []),
            ...(Math.max(bug.yes, 1 - bug.yes) < CONFIDENT ? ["bug"] : []),
            ...(urgency.probabilities[urgency.level]! < CONFIDENT ? ["urgency"] : []),
          ];
          return {
            ticket,
            team: team.choice,
            bug: bug.yes >= 0.5,
            urgency: URGENCY[urgency.level],
            unsure,
          };
        },
        { label: "Triage" },
      );
      return { triaged };
    },
  },
  prepare: (invocation: WorkflowInvocation) => ({
    tickets: invocation.argv.length === 0 ? [...SAMPLE_TICKETS] : [...invocation.argv],
  }),
  present: ({ triaged }) =>
    triaged
      .map(
        ({ ticket, team, bug, urgency, unsure }) =>
          `${team.padEnd(8)} ${(bug ? "bug" : "request").padEnd(7)} ${urgency.padEnd(9)} ${
            unsure.length === 0 ? "" : `(unsure: ${unsure.join(", ")}) `
          }${ticket}`,
      )
      .join("\n"),
});

export default executable;
