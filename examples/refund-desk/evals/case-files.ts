import { join } from "node:path";
import type { Case } from "@agentswf/lab/cases";
import type { Ticket } from "../helpdesk";
import type { Order } from "../shop";

/**
 * A case's two files: `ticket.md`, the customer's text under its fields, the day it came in as
 * `date`; and `order.json`, what the shop holds for the order.
 */
export async function readCase(c: Case): Promise<{ ticket: Ticket; order: Order; today: Date }> {
  const file = await Bun.file(join(c.dir, "ticket.md")).text();
  const [, front, text] =
    file.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n(?:\r?\n)?([\s\S]*?)\s*$/) ?? [];
  if (front === undefined || text === undefined)
    throw new Error("ticket.md needs its fields under ---");
  const fields = Bun.YAML.parse(front) as Record<string, string>;
  const ticket = { id: fields.id, order: fields.order, from: fields.from, text } as Ticket;
  return {
    ticket,
    order: c.json<Order>("order.json"),
    today: new Date(`${fields.date}T12:00:00Z`),
  };
}
