import { Refusal } from "./refusal";

// The older lab's commands and flags, retired with it (story 044, task 13): each is refused with
// what replaced it, or as gone when nothing did.

const COMMANDS: Record<string, string | null> = {
  show: "report --case {case}",
  list: "runs",
  check: null,
  schema: null,
};

const FLAGS: Record<string, string | null> = {
  "--scorer": "score --grader {name}",
  "--baseline":
    "the reference column: your checkout, --against's first folder or --vary's first value",
  "--comparison": "compare in the dataset's graders.ts",
  "--rest-from": "a grader's previous parts, in its grade folder",
  "--categories": "the grader's numbers",
  "--source": "the loop's scope check",
  "--rescore": null,
  "--only": null,
  "--where": null,
};

const retired = (what: string, instead: string | null) =>
  new Refusal(
    instead
      ? `${what} went with the older lab: ${instead}`
      : `${what} went with the older lab, and nothing replaced it`,
  );

/** Refuses a flag the older lab had. */
export function refuseRetiredFlag(flag: string): void {
  if (flag in FLAGS) throw retired(flag, FLAGS[flag]!);
}

/** Refuses a command the older lab had. */
export function refuseRetiredCommand(command: string): void {
  if (command in COMMANDS) throw retired(command, COMMANDS[command]!);
}
