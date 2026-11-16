// The decide stage alone: the case gives the read stage's value, so no helpdesk or shop is
// needed, and the run stops once the agent has decided. A prompt change is checked here, on
// many tickets, for the cost of one agent turn each.

import { defineEnv } from "@agentswf/lab/cases";
import { daysBetween } from "../../days";
import type { Decision } from "../../workflow";
import { readCase } from "../case-files";

export default defineEnv({
  workflow: () => import("../../workflow"),

  async setup(c) {
    const { ticket, order, today } = await readCase(c);
    const daysSinceDelivery = daysBetween(order.deliveredAt, today);

    return {
      argv: [ticket.id],
      stages: { read: () => ({ ticket, order, daysSinceDelivery }) },
      until: "decide",
      observe: (_result, { stages }) => {
        const decision = stages.decide as Decision;
        return { action: decision.action, amount: decision.amount };
      },
    };
  },
});
