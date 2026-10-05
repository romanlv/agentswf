/**
 * What each plan costs a month, by the name its harness reports, as the vendors listed it on the
 * date of `PLAN_BASIS`. Policy, not observation: a record keeps the plan's name, and a price is
 * looked up when it is shown. A plan not listed, or listed without a price, shows none.
 */
export const PLAN_BASIS = "plans 2026-10-05";

type Listed = { name: string; usdPerMonth?: number };

const PLANS: Readonly<Record<string, (plan: string, tier?: string) => Listed | undefined>> = {
  // `claude auth status` says `pro` or `max`; Max's tier is in its account: 5x is $100, 20x $200.
  claude: (plan, tier) => {
    if (plan === "pro") return { name: "Pro", usdPerMonth: 20 };
    if (plan !== "max") return undefined;
    if (tier?.endsWith("_max_20x")) return { name: "Max 20x", usdPerMonth: 200 };
    if (tier?.endsWith("_max_5x")) return { name: "Max 5x", usdPerMonth: 100 };
    return { name: "Max" };
  },
  // OpenAI's own product names for its plan types: `prolite` is Pro 100, `promax` Pro 500.
  codex: (plan) =>
    (
      ({
        free: { name: "Free", usdPerMonth: 0 },
        go: { name: "Go", usdPerMonth: 8 },
        plus: { name: "Plus", usdPerMonth: 20 },
        prolite: { name: "Pro 100", usdPerMonth: 100 },
        pro: { name: "Pro 200", usdPerMonth: 200 },
        promax: { name: "Pro 500", usdPerMonth: 500 },
      }) as Record<string, Listed>
    )[plan],
  // A team seat is Standard or Premium, $40 or $120, and `/usage` does not say which.
  cursor: (plan) => (plan === "Team" ? { name: "Team" } : undefined),
};

/** The plan as people name it and its monthly price, where `PLAN_BASIS` lists them. */
export function planPrice(harness: string, plan: string, tier?: string): Listed | undefined {
  return Object.hasOwn(PLANS, harness) ? PLANS[harness]!(plan, tier) : undefined;
}
