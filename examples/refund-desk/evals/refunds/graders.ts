import { defineGrader } from "@agentswf/lab/cases";

/** The dollar amounts a text names: "$24", "$ 24.00", "$1,024". */
function dollars(text: string): number[] {
  return [...text.matchAll(/\$\s?(\d{1,3}(?:,\d{3})+|\d+)(\.\d{1,2})?/g)].map((match) =>
    Number(`${match[1]!.replaceAll(",", "")}${match[2] ?? ""}`),
  );
}

/**
 * The policy's rule that a refund's reply states the amount refunded. Every fact can be right, the
 * right $24 paid, while the reply says only "we've processed your refund", or "your $54 order has
 * been refunded". It checks that the amount paid is named, not that no other is: a reply may
 * mention the $200 it declines.
 */
export const replyStatesRefund = defineGrader({
  readsFacts: true,
  grade({ facts }) {
    if (typeof facts.refunded !== "number") throw new Error("observe returned no refunded number");
    const refunded = facts.refunded;
    if (refunded === 0) return { notApplies: "nothing was refunded" };
    const named = dollars(String(facts.reply));
    if (named.some((amount) => Math.abs(amount - refunded) < 0.005)) {
      return {
        verdict: "passed",
        reasons: [{ about: "reply", text: `it names $${refunded}, the amount refunded` }],
      };
    }
    const said =
      named.length > 0 ? `it names ${named.map((n) => `$${n}`).join(", ")}` : "it names no amount";
    return {
      verdict: "failed",
      reasons: [{ about: "reply", text: `$${refunded} was refunded, and ${said}` }],
    };
  },
});
