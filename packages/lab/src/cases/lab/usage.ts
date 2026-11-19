import { Refusal } from "./refusal";
import { EXITS } from "./verdict";

// The command line's one table: each command's synopses and what it does, each flag's line, and
// the exit codes. The full help, a command's own help and the flags a command accepts are all read
// from it, so none of them drifts from another.

type Synopsis = {
  line: string;
  about: string;
  /** The flag that picks this synopsis over the command's others, as `--final` does for loop. */
  mode?: string;
};

export type CommandName =
  | "case"
  | "run"
  | "report"
  | "score"
  | "capture"
  | "label"
  | "loop"
  | "runs";

type Command = {
  name: CommandName;
  /**
   * Each a synopsis, after `awf-lab`; the flags named in one are those the command takes in it, in
   * the one its `mode` flag picks or else the one with none.
   */
  synopses: Synopsis[];
  /** Its exit codes. */
  exit: string;
};

const EXIT_VERDICT = Object.entries(EXITS)
  .map(([code, meaning]) => `${code} ${meaning}`)
  .join(", ");
const EXIT_PLAIN = "0 done, 2 refused, 4 the lab broke";
const EXIT_LOOP =
  "0 done, 1 nothing kept to patch or check, 2 refused, 3 stopped at --budget, 4 the lab broke";

const COMMANDS: Command[] = [
  {
    name: "case",
    synopses: [
      {
        line: "case new {dataset}/{case}",
        about:
          "a case folder and its key's marker; the first time, also awf-lab.json, the dataset's dataset.json and a stub env.ts",
      },
    ],
    exit: EXIT_PLAIN,
  },
  {
    name: "run",
    synopses: [
      {
        line: "run [--dataset {name}] [--cases {a,b}] [--tags {a,b}] [--failed] [--holdout] [--trials {n}] [--against {folder}] [--param {name}={value}] [--vary {name}={a,b}] [--fresh] [--dry-run] [--budget {usd}] [--yes] [--json]",
        about:
          "the workflow, as it is in your checkout, on each case, each trial in a throwaway folder, graded against its key",
      },
    ],
    exit: EXIT_VERDICT,
  },
  {
    name: "report",
    synopses: [
      {
        line: "report [{run}] [--case {name}] [--json | --md]",
        about: "the last run again, or the run named by its id or last 4 characters",
      },
    ],
    exit: EXIT_VERDICT,
  },
  {
    name: "score",
    synopses: [
      {
        line: "score [{run}] [--grader {name} | --judge {harness}/{model} [--voters {n}]] [--tags {a,b}] [--dry-run] [--budget {usd}] [--yes] [--json]",
        about:
          "grade the last run, or the one named, again without running a trial: each grader whose key or version changed, or that errored",
      },
    ],
    exit: EXIT_VERDICT,
  },
  {
    name: "capture",
    synopses: [
      {
        line: 'capture {trial id} (--good | --needs-work "{note}") [--dataset {name}]',
        about:
          "a case from a trial, by its id, from the case it ran; or from a real run, by its awf run id, through the dataset's capture.ts; its key a draft to finish",
      },
    ],
    exit: EXIT_PLAIN,
  },
  {
    name: "label",
    synopses: [
      {
        line: 'label {trial id} (--good | --needs-work "{note}" | --clear)',
        about:
          "the person's verdict on a trial, by its id (report --case lists them); the report gives the lab's agreement with it",
      },
    ],
    exit: EXIT_PLAIN,
  },
  {
    name: "loop",
    synopses: [
      {
        line: "loop {name} --budget {usd} [--program {file}] [--proposer {harness}/{model}] [--rounds {n}] [--trials {n}] [--cases {a,b}] [--param {name}={value}] [--allowance {pct|off}] [--dataset {name}]",
        about:
          "a proposer changes a copy of the code from the tuning cases' feedback, the copy runs against the incumbent case by case until the dataset's compare stops it, and it is kept only when better; the first run names its program and starts from your checkout; again, it resumes",
      },
      {
        line: "loop {name} --final --budget {usd}",
        about: "the kept code against the start on the held-out cases, once",
        mode: "--final",
      },
      {
        line: "loop {name} --patch",
        about: "the kept code against the start, as a patch",
        mode: "--patch",
      },
    ],
    exit: EXIT_LOOP,
  },
  {
    name: "runs",
    synopses: [{ line: "runs", about: "the runs kept, newest first" }],
    exit: EXIT_PLAIN,
  },
];

/**
 * Each flag's line in the help, in its order: `about` in the full help and in a command's own,
 * unless `per` gives that command its own words.
 */
const FLAGS: { flag: string; arg?: string; about: string; per?: Record<string, string> }[] = [
  {
    flag: "--config",
    arg: "{file}",
    about: "the awf-lab.json to use; without it, the nearest here or above, or in an evals/ there",
  },
  {
    flag: "--dataset",
    arg: "{name}",
    about:
      "the dataset: a folder beside awf-lab.json holding a dataset.json; needed only when evals/ holds more than one",
    per: {
      capture:
        "the dataset the case goes in: a folder beside awf-lab.json holding a dataset.json; needed only when evals/ holds more than one",
    },
  },
  {
    flag: "--cases",
    arg: "{a,b}",
    about: "only these cases",
    per: { loop: "tune on only these cases" },
  },
  {
    flag: "--tags",
    arg: "{a,b}",
    about: "only the cases whose key lists one of these tags",
    per: { score: "grade only the trials of cases whose key lists one of these tags" },
  },
  {
    flag: "--failed",
    about:
      "only the cases whose newest verdict was failed, flaky or unclear, each with that run's trials unless --trials says",
  },
  {
    flag: "--holdout",
    about:
      "run only the cases dataset.json holds out: without it run leaves them out, and a loop tunes on none of them, so loop --final checks on cases nothing was tuned on",
  },
  {
    flag: "--trials",
    arg: "{n}",
    about: "trials per case; 1 by default",
    per: { loop: "trials per case in each try's run; 1 by default" },
  },
  {
    flag: "--against",
    arg: "{folder}",
    about:
      "also run the cases on the code in another checkout of the project, as a column beside yours; repeatable. Its env.ts and code run; its cases, keys and graders are never read",
  },
  {
    flag: "--param",
    arg: "{name}={value}",
    about: "a parameter for every trial, which env.ts reads as c.params; repeatable",
    per: {
      loop: "a parameter for every trial of the loop, which env.ts reads as c.params; repeatable. Its final check runs under the same",
    },
  },
  {
    flag: "--vary",
    arg: "{name}={a,b}",
    about:
      "a column for each value, each folder; repeatable, every combination run. The reference column is your checkout under each --vary's first value: the exit code, history and --failed are its",
  },
  {
    flag: "--fresh",
    about:
      "run every trial anew; without it, a trial kept from an earlier run stands in when nothing that shaped it changed (the code, env.ts, the parameters, the case, the trial settings), within the dataset's reuseDays, 14 by default",
  },
  {
    flag: "--case",
    arg: "{name}",
    about: "one case in full: each trial, its id, facts and grades",
  },
  {
    flag: "--grader",
    arg: "{name}",
    about: "grade with this grader alone, one marked onDemand included",
  },
  {
    flag: "--judge",
    arg: "{harness}/{model}",
    about:
      "grade the criteria again with another judge, repeatable, beside the one that decides: the report gives each judge's agreement with your labels and its cost, and only judgeAgent's grades are in the verdict",
  },
  { flag: "--voters", arg: "{n}", about: "the --judge's voters per criterion, odd; 3 by default" },
  {
    flag: "--good",
    about: "the trial or run went well",
    per: { label: "the trial went well" },
  },
  {
    flag: "--needs-work",
    arg: '"{note}"',
    about: "it needed work, and what",
    per: { label: "the trial needed work, and what" },
  },
  { flag: "--clear", about: "remove the trial's label" },
  {
    flag: "--dry-run",
    about: "print the plan of run or score, and run or grade nothing",
    per: { run: "print the plan, and run nothing", score: "print the plan, and grade nothing" },
  },
  {
    flag: "--budget",
    arg: "{usd}",
    about:
      "run stops starting trials, and score before a grader workflow, once their estimates reach it: exit 3. A loop needs it: its cap, and --final's",
    per: {
      run: "stop starting trials once their estimates reach it: exit 3",
      score: "stop before a grader workflow once the grades' estimates reach it: exit 3",
      loop: "needed: the cap on the estimates of the loop's tries, or of its final check; it stops there, exit 3, and a larger one goes on",
    },
  },
  {
    flag: "--yes",
    about: "no question before a run or a score",
    per: { run: "no question before the run", score: "no question before grading" },
  },
  {
    flag: "--program",
    arg: "{file}",
    about: "a loop's steering, the operator's, read by its proposer each try",
  },
  {
    flag: "--proposer",
    arg: "{harness}/{model}",
    about: "the loop's proposer; claude/claude-sonnet-5-5 by default",
  },
  { flag: "--rounds", arg: "{n}", about: "the loop's tries this time; 1 by default" },
  {
    flag: "--allowance",
    arg: "{pct|off}",
    about: "a loop waits while a plan window its agents draw on is this far used; 90 by default",
  },
  { flag: "--final", about: "the kept code against the start on the held-out cases, once" },
  { flag: "--patch", about: "the kept code against the start, as a patch" },
  {
    flag: "--json",
    about: "the report, or score's plan and report, as JSON",
    per: {
      run: "the report as JSON",
      report: "the report as JSON",
      score: "the plan and the report as JSON",
    },
  },
  { flag: "--md", about: "the report as Markdown, to paste into a pull request or an issue" },
];

/** Words that read as a command but are not one, and what to run instead. */
const NOT_COMMANDS: Record<string, string> = {
  compare:
    "compare is graders.ts's export, not a command: run --against {folder} or --vary {name}={a,b} makes the columns it compares",
};

/** Flags that are another flag's near miss, each naming the other. */
const NEAR: Record<string, string> = { "--case": "--cases", "--cases": "--case" };

const WIDTH = 100;
const ABOUT = 30;
const FLAG_ABOUT = 20;
const CONFIG = "awf-lab [--config {file}]";

/** Words in lines of at most WIDTH: the first line starts with `first`, the rest at `indent`. */
function wrap(words: readonly string[], first: string, indent: number): string[] {
  const lines: string[] = [];
  let line = first;
  let empty = true;
  for (const word of words) {
    const next = empty ? `${line}${word}` : `${line} ${word}`;
    if (!empty && next.length > WIDTH) {
      lines.push(line);
      line = `${" ".repeat(indent)}${word}`;
    } else line = next;
    empty = false;
  }
  lines.push(line);
  return lines;
}

/** A synopsis's words, a bracketed group kept whole. */
function synopsisWords(line: string): string[] {
  const words: string[] = [];
  let depth = 0;
  let word = "";
  for (const ch of line) {
    if (ch === " " && depth === 0) {
      if (word) words.push(word);
      word = "";
      continue;
    }
    if (ch === "[" || ch === "(") depth++;
    if (ch === "]" || ch === ")") depth--;
    word += ch;
  }
  if (word) words.push(word);
  return words;
}

/** A synopsis wrapped after `first`, going on under the word after the command's name. */
function synopsisLines(line: string, first: string): string[] {
  const words = synopsisWords(line);
  return wrap(words, first, first.length + words[0]!.length + 1);
}

function commandLines(command: Command): string[] {
  return command.synopses.flatMap(({ line, about }) => {
    const synopsis = synopsisLines(line, "  ");
    const fits = synopsis.length === 1 && synopsis[0]!.length < ABOUT - 1;
    const aboutWords = about.split(" ");
    if (fits) return wrap(aboutWords, synopsis[0]!.padEnd(ABOUT), ABOUT);
    return [...synopsis, ...wrap(aboutWords, " ".repeat(ABOUT), ABOUT)];
  });
}

function flagLines(flag: (typeof FLAGS)[number], command?: string): string[] {
  const head = `  ${flag.flag}${flag.arg ? ` ${flag.arg}` : ""}`;
  const about = (command !== undefined ? flag.per?.[command] : undefined) ?? flag.about;
  const words = about.split(" ");
  if (head.length < FLAG_ABOUT - 1) return wrap(words, head.padEnd(FLAG_ABOUT), FLAG_ABOUT);
  return [head, ...wrap(words, " ".repeat(FLAG_ABOUT), FLAG_ABOUT)];
}

const flagsOf = (line: string): string[] => line.match(/--[a-z-]+/g) ?? [];

/** Every flag the command takes, in any of its synopses. */
const flagsIn = (command: Command) =>
  new Set(command.synopses.flatMap(({ line }) => flagsOf(line)));

/** Flags every command takes. */
const EVERYWHERE = new Set(["--config", "--help"]);

const exitLines = (who: string, exit: string) => wrap(`${who} ${exit}`.split(" "), "", 2);

/** `awf-lab --help`: every command, every flag, the exit codes. */
export function fullUsage(): string {
  return [
    `usage: ${CONFIG} {command} …`,
    "",
    ...COMMANDS.flatMap(commandLines),
    "",
    ...FLAGS.flatMap((flag) => flagLines(flag)),
    "",
    ...exitLines("exit, run, report and score:", EXIT_VERDICT),
    ...exitLines("exit, loop:", EXIT_LOOP),
    ...exitLines("exit, the others:", EXIT_PLAIN),
  ].join("\n");
}

/** `awf-lab {command} --help`: its synopses, its flags and its exit codes; undefined if unknown. */
export function commandUsage(name: string): string | undefined {
  const command = COMMANDS.find((c) => c.name === name);
  if (!command) return undefined;
  const own = flagsIn(command);
  own.add("--config");
  const many = command.synopses.length > 1;
  return [
    ...command.synopses.flatMap(({ line }, i) =>
      synopsisLines(line, `${i === 0 ? "usage: " : "       "}${CONFIG} `),
    ),
    "",
    ...command.synopses.flatMap(({ line, about, mode }) => {
      if (!many) return wrap(about.split(" "), "", 0);
      const words = synopsisWords(line);
      const end = words.findIndex((w) => /^[-[(]/.test(w));
      const head = end === -1 ? words : words.slice(0, end);
      return wrap(about.split(" "), `${[...head, ...(mode ? [mode] : [])].join(" ")}: `, 2);
    }),
    "",
    ...FLAGS.filter((f) => own.has(f.flag)).flatMap((f) => flagLines(f, name)),
    "",
    ...exitLines("exit:", command.exit),
  ].join("\n");
}

/** The commands that take a flag, as `run's`, `run's and score's`. */
function owners(flag: string): string | undefined {
  const names = COMMANDS.filter((c) => flagsIn(c).has(flag)).map((c) => `${c.name}'s`);
  if (names.length === 0) return undefined;
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** How a flag is written in a synopsis: `--cases {a,b}`. */
const written = (flag: string) => {
  const found = FLAGS.find((f) => f.flag === flag);
  return found?.arg ? `${flag} ${found.arg}` : flag;
};

/**
 * Refuses a flag the command doesn't take where it is given, saying whose it is and, for a near
 * miss, the other. A command of several synopses takes the flags of the one its mode picks.
 */
export function refuseForeignFlags(name: string, given: readonly string[]): void {
  const command = COMMANDS.find((c) => c.name === name);
  if (!command) return;
  const modes = command.synopses.filter((s) => s.mode !== undefined && given.includes(s.mode));
  if (modes.length > 1) {
    throw new Refusal(`${modes.map((s) => s.mode).join(" and ")} do not go together`);
  }
  const synopsis = modes[0] ?? command.synopses.find((s) => s.mode === undefined)!;
  const own = new Set(flagsOf(synopsis.line));
  const where = synopsis.mode ? `${name} ${synopsis.mode}` : name;
  for (const flag of given) {
    if (EVERYWHERE.has(flag) || own.has(flag)) continue;
    if (flagsIn(command).has(flag)) {
      const other = command.synopses.find((s) => flagsOf(s.line).includes(flag))!;
      throw new Refusal(
        `${flag} is not an option of ${where}: it is ${name}'s ${other.mode ? `with ${other.mode}` : `without ${synopsis.mode}`}; ${where} is ${synopsis.line}`,
      );
    }
    const near = NEAR[flag];
    const whose = owners(flag);
    const hint =
      near && own.has(near)
        ? `${whose ? `${flag} is ${whose}; ` : ""}${name} takes ${written(near)}`
        : whose
          ? `it is ${whose}`
          : undefined;
    throw new Refusal(`${flag} is not an option of ${where}${hint ? `: ${hint}` : ""}`);
  }
}

/**
 * Refuses a flag no command takes, with the command's flag it is nearest, two edits or fewer
 * away.
 */
export function refuseUnknownFlag(flag: string, name: string | undefined): never {
  const command = name === undefined ? undefined : COMMANDS.find((c) => c.name === name);
  if (!command) throw new Refusal(`unknown option ${flag}; awf-lab --help lists the options`);
  const near = [...flagsIn(command), ...EVERYWHERE]
    .map((f) => [f, distance(flag, f)] as const)
    .filter(([, d]) => d <= 2)
    .sort((a, b) => a[1] - b[1])[0]?.[0];
  throw new Refusal(
    `unknown option ${flag} for ${name}${near ? `; did you mean ${near}?` : ";"} awf-lab ${name} --help lists its options`,
  );
}

/** The edits, inserting, removing or changing a character, that make `a` into `b`. */
function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(
        row[j]! + 1,
        next[j - 1]! + 1,
        row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    row = next;
  }
  return row[b.length]!;
}

/** Whether a word is one of the commands. */
export const isCommand = (name: string): name is CommandName =>
  COMMANDS.some((c) => c.name === name);

/** Refuses a word that is not a command, with what to run instead when there is something. */
export function refuseNotCommand(name: string): void {
  if (Object.hasOwn(NOT_COMMANDS, name)) throw new Refusal(NOT_COMMANDS[name]!);
}

/** Every flag a synopsis names has a line, and every line is some command's or everywhere's. */
export function usageProblems(): string[] {
  const named = new Set(COMMANDS.flatMap((c) => [...flagsIn(c)]));
  const lines = new Set(FLAGS.map((f) => f.flag));
  return [
    ...[...named].filter((f) => !lines.has(f)).map((f) => `${f} has no line`),
    ...[...lines]
      .filter((f) => !named.has(f) && !EVERYWHERE.has(f))
      .map((f) => `${f} is no command's`),
    ...FLAGS.flatMap((f) =>
      Object.keys(f.per ?? {})
        .filter((name) => !COMMANDS.some((c) => c.name === name && flagsIn(c).has(f.flag)))
        .map((name) => `${f.flag}'s words for ${name}, which doesn't take it`),
    ),
  ];
}
