import { jsonLines, type Row } from "../json";
import type { TurnPlan } from "./define";

/** The same launch on a session that exists, its words after the command's name. */
export function resuming(plan: TurnPlan, ...words: string[]): TurnPlan {
  const [command, ...rest] = plan.argv;
  return { ...plan, argv: [command!, ...words, ...rest] };
}

export function lastJson(stdout: string): Row | undefined {
  return jsonLines(stdout).at(-1);
}

/** What `screen` shows after the last line holding `marker`, or nothing when none does. */
export function after(screen: string, marker: string): string {
  const at = screen.lastIndexOf(marker);
  return at < 0 ? "" : screen.slice(at + marker.length);
}
