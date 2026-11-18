// Harder tickets for the decide stage, the room a loop has to improve the desk's prompt: two of a
// kind, one item named twice, a plea past the window, an amount in the ticket, a complaint the
// policy doesn't refund. The run stops once the agent has decided, as `decide/` does.

import { defineEnv } from "@agentswf/lab/cases";
import { daysBetween } from "../../days";
import type { Decision } from "../../workflow";
import { readCase } from "../case-files";

export default defineEnv({
  workflow: () => import("../../workflow"),

  async setup(c) {
    const { ticket, order, today } = await readCase(c);
    return {
      argv: c.params.model ? [ticket.id, "--model", c.params.model] : [ticket.id],
      stages: {
        read: () => ({ ticket, order, daysSinceDelivery: daysBetween(order.deliveredAt, today) }),
      },
      until: "decide",
      observe: (_result, { stages }) => {
        const decision = stages.decide as Decision;
        return { action: decision.action, amount: decision.amount };
      },
    };
  },
});
