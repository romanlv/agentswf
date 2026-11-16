// The whole workflow on one ticket: the helpdesk answers from the case's ticket, the shop from its
// order and day. The agent is real; no money moves and no reply is sent.

import { defineEnv } from "@agentswf/lab/cases";
import * as shop from "../../shop";
import { readCase } from "../case-files";

export default defineEnv({
  workflow: () => import("../../workflow"),

  async setup(c) {
    const { ticket, order, today } = await readCase(c);

    c.http({
      "GET https://helpdesk.example/api/tickets/:id": () => Response.json(ticket),
      "POST https://helpdesk.example/api/tickets/:id/replies": () =>
        new Response(null, { status: 201 }),
    });
    const shopSpies = c.mock(shop, {
      findOrder: async () => order,
      refund: async () => {},
      today: () => today,
    });

    /** The texts posted to this ticket's replies. */
    const replies = () =>
      c.http.requests
        .filter(
          (request) => request.method === "POST" && request.url.endsWith(`/${ticket.id}/replies`),
        )
        .map((request) => String(JSON.parse(request.body ?? "{}").text ?? ""));

    return {
      argv: [ticket.id],
      observe: (result) => ({
        action: result.action,
        /** What the code paid back, which can be less than the agent asked for. */
        refunded: shopSpies.refund.mock.calls.reduce((sum, [, amount]) => sum + amount, 0),
        refunds: shopSpies.refund.mock.calls.length,
        replied: replies().some((text) => text.trim() !== ""),
      }),
    };
  },
});
