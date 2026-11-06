// The operator commands' words: where the commands that read runs look, and the commands they
// suggest, as text to paste into a shell.
import { resolve } from "node:path";
import type { RunCommand } from "./run-command";
import { runRootOf } from "./runs";

/** Where the commands that read runs look, and the options their suggested commands repeat. */
export type ReadPlace = { shellCwd: string; runRoot: string; repeat: string[] };

export type Out = { stdout(text: string): void; stderr(text: string): void };

/** `--cwd`, `--run-root` and `--json`, taken out of `argv`; the rest is left for the command. */
export function parsePlace(
  argv: readonly string[],
  shellCwd: string,
): { place: ReadPlace; json: boolean; rest: string[] } {
  let cwd = shellCwd;
  let runRoot: string | undefined;
  let json = false;
  const repeat: string[] = [];
  const rest: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    // What follows is the command's own, a message's text included.
    if (arg === "--") {
      rest.push(...argv.slice(index));
      break;
    }
    if (arg === "--json") json = true;
    else if (arg === "--cwd" || arg === "--run-root") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} needs a directory`);
      index += 1;
      if (arg === "--cwd") cwd = resolve(shellCwd, value);
      else runRoot = resolve(shellCwd, value);
      repeat.push(arg, value);
    } else rest.push(arg);
  }
  return { place: { shellCwd, runRoot: runRoot ?? runRootOf(cwd), repeat }, json, rest };
}

/** A suggested command, with the place repeated. */
export function command(place: ReadPlace, ...words: string[]): string[] {
  const [first, second, ...rest] = words;
  return [first!, second!, ...rest.slice(0, 1), ...place.repeat, ...rest.slice(1)];
}

/** The flags that find this run again from another command: the folder or run root given. */
export function placeFlags(
  run: Pick<RunCommand, "cwd" | "cwdGiven" | "runRoot" | "runRootGiven">,
): string[] {
  return [
    ...(run.cwdGiven ? ["--cwd", run.cwd] : []),
    ...(run.runRootGiven ? ["--run-root", run.runRoot] : []),
  ];
}

/** A suggested command as text to paste into a shell. */
export function shellLine(words: readonly string[]): string {
  return words.map(shellWord).join(" ");
}

export function shellWord(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}
