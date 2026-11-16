/**
 * The shop's orders and payments. This example has no shop, so outside a case they throw: its
 * cases put fakes here, and a real workflow would call its database and payment provider.
 */

export type Order = {
  id: string;
  customer: string;
  deliveredAt: string;
  items: { name: string; price: number }[];
};

export async function findOrder(id: string): Promise<Order> {
  throw new Error(`no shop is connected: order ${id} can't be read`);
}

/** Pays `amount` back to the card the order was paid with. */
export async function refund(orderId: string, amount: number): Promise<void> {
  throw new Error(`no shop is connected: ${amount} for order ${orderId} isn't refunded`);
}

export function today(): Date {
  return new Date();
}
