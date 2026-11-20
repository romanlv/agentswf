const DAY = 24 * 60 * 60 * 1000;

/** Whole days from `from` to `to`, counted down: what the policy's 30 days are measured in. */
export function daysBetween(from: string | Date, to: Date): number {
  return Math.floor((to.getTime() - new Date(from).getTime()) / DAY);
}
