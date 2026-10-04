import { jsonLines, type Row } from "../json";
import type { LaunchSettings, TurnPlan } from "./define";

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

/** What a launch passes of an agent's settings: none of an empty model, as the caller's is. */
export function launchSettings({
  model,
  effort,
}: {
  model: string;
  effort?: string;
}): LaunchSettings {
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}
