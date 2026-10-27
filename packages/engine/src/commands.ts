import { allowanceUsage } from "./allowance-command";
import { emitUsage } from "./emit-command";
import { replyUsage } from "./holder-command";
import { inboxUsage } from "./inbox-command";
import { initUsage } from "./init-command";
import { logsUsage } from "./logs-command";
import { usage as runUsage } from "./run-command";
import { shellLine } from "./run-commands";
import { runsUsage } from "./runs-command";
import { testUsage } from "./test-command";
import { tickUsage } from "./tick-command";

/**
 * Every `awf` command: what the index, `awf help` and the suggestion read, and what the dispatch is
 * keyed by. An entry's commands share its help; each has its own line in the index.
 */
export const COMMANDS = [
  {
    group: "Run a workflow",
    commands: { run: "Start a run of a workflow file, or continue one" },
    help: runUsage,
  },
  { group: "Run a workflow", commands: { test: "Run a workflow's tests" }, help: testUsage },
  {
    group: "Run a workflow",
    commands: { init: "Set up a directory for writing workflows" },
    help: initUsage,
  },
  {
    group: "Run a workflow",
    commands: { emit: "Send an event to a workflow with events, starting or waking its run" },
    help: emitUsage,
  },
  {
    group: "Run a workflow",
    commands: { tick: "Wake the runs of workflows with events that are due" },
    help: tickUsage,
  },
  {
    group: "Look at runs",
    commands: { runs: "The runs here, or one run in depth" },
    help: runsUsage,
  },
  {
    group: "Look at runs",
    commands: { logs: "What a run did and is doing, merged by time" },
    help: logsUsage,
  },
  {
    group: "Coordinate a run from outside",
    commands: { inbox: "What agents said to a participant outside the run, and what it said back" },
    help: inboxUsage,
  },
  {
    group: "Coordinate a run from outside",
    commands: { reply: "Answer a question an agent asked", send: "Message an agent first" },
    help: replyUsage,
  },
  {
    group: "This machine",
    commands: { allowance: "What is left of each harness's plan" },
    help: allowanceUsage,
  },
] as const;

type Entry = (typeof COMMANDS)[number];
type NamesOf<Each> = Each extends { commands: infer Commands } ? keyof Commands & string : never;
export type CommandName = NamesOf<Entry>;

const NAMES = COMMANDS.flatMap((entry) => Object.keys(entry.commands)) as CommandName[];

export function isCommand(word: string): word is CommandName {
  return (NAMES as string[]).includes(word);
}

/** The help `awf help {name}` and `awf {name} -h` print. */
export function helpOf(name: CommandName): string {
  return COMMANDS.find((entry) => name in entry.commands)!.help;
}

const WIDTH = Math.max(...NAMES.map((name) => name.length)) + 2;

function grouped(): [group: string, entries: Entry[]][] {
  const groups = new Map<string, Entry[]>();
  for (const entry of COMMANDS)
    groups.set(entry.group, [...(groups.get(entry.group) ?? []), entry]);
  return [...groups];
}

const lines = (entry: Entry) =>
  Object.entries(entry.commands).map(([name, summary]) => `${name.padEnd(WIDTH)}${summary}`);

/** What `awf`, `awf -h` and `awf help` print. */
export function index(): string {
  return [
    "awf runs workflows of coding agents.",
    "",
    "usage: awf <command> [arguments]",
    "",
    ...grouped().flatMap(([group, entries]) => [
      group,
      ...entries.flatMap(lines).map((line) => `  ${line}`),
      "",
    ]),
    "awf <command> -h      a command's usage, options and exit codes",
    "awf help reference    every command's usage, on one page",
    "awf --version",
  ].join("\n");
}

/** A command's usage lines: its help up to the first blank line. */
export function usageLines(help: string): string[] {
  const end = help.indexOf("\n\n");
  return (end < 0 ? help : help.slice(0, end)).split("\n");
}

/** What `awf help reference` prints: each command's summary and usage lines, grouped as the index. */
export function reference(): string {
  return [
    ...grouped().flatMap(([group, entries]) => [
      group,
      ...entries.flatMap((entry) => [
        ...lines(entry).map((line) => `  ${line}`),
        ...usageLines(entry.help).map((line) => `    ${line}`),
        "",
      ]),
    ]),
    "awf <command> -h for what each does, and its exit codes",
  ].join("\n");
}

const WORKFLOW_FILE = /\.(ts|mts|js|mjs)$/;

/** The one line `awf {word}` gets when no command is named `word`. */
export function unknownCommand(word: string): string {
  const said = `awf: no command ${JSON.stringify(word)}`;
  if (WORKFLOW_FILE.test(word)) return `${said}; did you mean: ${shellLine(["awf", "run", word])}`;
  const meant = suggest(word);
  const named =
    meant.length === 0
      ? ""
      : ` did you mean ${meant.length === 1 ? meant[0] : `${meant.slice(0, -1).join(", ")} or ${meant.at(-1)}`}?`;
  return `${said};${named} awf -h lists the commands`;
}

/**
 * The commands `word` is the start of, else the closest within two edits; every one tied for
 * closest.
 */
export function suggest(word: string): CommandName[] {
  if (word === "") return [];
  const started = NAMES.filter((name) => name.startsWith(word));
  if (started.length > 0) return started;
  const near = NAMES.map((name) => ({ name, distance: distance(word, name) })).filter(
    (each) => each.distance <= 2,
  );
  const closest = Math.min(...near.map((each) => each.distance));
  return near.filter((each) => each.distance === closest).map((each) => each.name);
}

/** Levenshtein distance. */
function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length]!;
}
