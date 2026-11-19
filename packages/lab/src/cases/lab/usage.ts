import { Refusal } from "./refusal";

// The command line's one table: each command's synopses and what it does, each flag's line, and
// the exit codes. The full help, a command's own help and the flags a command accepts are all read
// from it, so none of them drifts from another.

type Command = {
  name: string;
  /** Each a synopsis, after `awf-lab`; the flags named in them are the ones the command takes. */
  synopses: { line: string; about: string }[];
  /** Whether its exit code is a run's verdict, as `run`'s is, or only done, refused or broke. */
  verdict: boolean;
};

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
    verdict: false,
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
    verdict: true,
  },
  {
    name: "report",
    synopses: [
      {
        line: "report [{run}] [--case {name}] [--json | --md]",
        about: "the last run again, or the run named by its id or last 4 characters",
      },
    ],
    verdict: true,
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
    verdict: true,
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
    verdict: false,
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
    verdict: false,
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
      },
      { line: "loop {name} --patch", about: "the kept code against the start, as a patch" },
    ],
    verdict: true,
  },
  {
    name: "runs",
    synopses: [{ line: "runs", about: "the runs kept, newest first" }],
    verdict: false,
  },
];

/** Each flag's line in the help, in its order. */
const FLAGS: { flag: string; arg?: string; about: string }[] = [
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
  },
  { flag: "--cases", arg: "{a,b}", about: "only these cases" },
  {
    flag: "--tags",
    arg: "{a,b}",
    about: "only the cases whose key lists one of these tags",
  },
  {
    flag: "--failed",
    about:
      "only the cases whose newest verdict was failed, flaky or unclear, each with that run's trials unless --trials says",
  },
  {
    flag: "--holdout",
    about:
      "run the cases dataset.json holds out, alone: every other command leaves them out, so a final check runs once on cases nothing was tuned on",
  },
  { flag: "--trials", arg: "{n}", about: "trials per case; 1 by default" },
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
    about: "score with this grader alone, one marked onDemand included",
  },
  {
    flag: "--judge",
    arg: "{harness}/{model}",
    about:
      "score's criteria again with another judge, repeatable, beside the one that decides: the report gives each judge's agreement with your labels and its cost, and only judgeAgent's grades are in the verdict",
  },
  { flag: "--voters", arg: "{n}", about: "the --judge's voters per criterion, odd; 3 by default" },
  { flag: "--good", about: "the trial or run went well" },
  { flag: "--needs-work", arg: '"{note}"', about: "it needed work, and what" },
  { flag: "--clear", about: "remove the trial's label" },
  { flag: "--dry-run", about: "print the plan of run or score, and run or grade nothing" },
  {
    flag: "--budget",
    arg: "{usd}",
    about:
      "run stops starting trials, and score before a grader workflow, once their estimates reach it: exit 3. A loop needs it: its cap, and --final's",
  },
  { flag: "--yes", about: "no question before a run or a score" },
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
  { flag: "--json", about: "the report, or score's plan and report, as JSON" },
  { flag: "--md", about: "the report as Markdown, to paste into a pull request or an issue" },
];

const EXIT_VERDICT =
  "exit: 0 every case that must pass passed, 1 a case that must pass failed, 2 refused before any trial, 3 a case flaky or unclear, a partial run, a budget stop, or nothing graded, 4 the lab broke, 5 a trial errored by the dataset or by grading, or leaked";
const EXIT_PLAIN = "exit: 0 done, 2 refused, 4 the lab broke";

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

function commandLines(command: Command): string[] {
  return command.synopses.flatMap(({ line, about }) => {
    const words = synopsisWords(line);
    // A synopsis too long for a line goes on under the word after the command's name.
    const synopsis = wrap(words, "  ", 2 + words[0]!.length + 1);
    const fits = synopsis.length === 1 && synopsis[0]!.length < ABOUT - 1;
    const aboutWords = about.split(" ");
    if (fits) return wrap(aboutWords, synopsis[0]!.padEnd(ABOUT), ABOUT);
    return [...synopsis, ...wrap(aboutWords, " ".repeat(ABOUT), ABOUT)];
  });
}

function flagLines(flag: (typeof FLAGS)[number]): string[] {
  const head = `  ${flag.flag}${flag.arg ? ` ${flag.arg}` : ""}`;
  const words = flag.about.split(" ");
  if (head.length < FLAG_ABOUT - 1) return wrap(words, head.padEnd(FLAG_ABOUT), FLAG_ABOUT);
  return [head, ...wrap(words, " ".repeat(FLAG_ABOUT), FLAG_ABOUT)];
}

const flagsIn = (command: Command) =>
  new Set(command.synopses.flatMap(({ line }) => line.match(/--[a-z-]+/g) ?? []));

/** Flags every command takes. */
const EVERYWHERE = new Set(["--config", "--help"]);

/** `awf-lab --help`: every command, every flag, the exit codes. */
export function fullUsage(): string {
  return [
    "usage: awf-lab [--config {file}] {command} …",
    "",
    ...COMMANDS.flatMap(commandLines),
    "",
    ...FLAGS.flatMap(flagLines),
    "",
    ...wrap(EXIT_VERDICT.split(" "), "", 0),
  ].join("\n");
}

/** `awf-lab {command} --help`: its synopses, its flags and its exit codes; undefined if unknown. */
export function commandUsage(name: string): string | undefined {
  const command = COMMANDS.find((c) => c.name === name);
  if (!command) return undefined;
  const own = flagsIn(command);
  own.add("--config");
  return [
    "usage: awf-lab [--config {file}]",
    ...commandLines(command),
    "",
    ...FLAGS.filter((f) => own.has(f.flag)).flatMap(flagLines),
    "",
    ...wrap((command.verdict ? EXIT_VERDICT : EXIT_PLAIN).split(" "), "", 0),
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

/** Refuses a flag the command doesn't take, saying whose it is and, for a near miss, the other. */
export function refuseForeignFlags(name: string, given: readonly string[]): void {
  const command = COMMANDS.find((c) => c.name === name);
  if (!command) return;
  const own = flagsIn(command);
  for (const flag of given) {
    if (EVERYWHERE.has(flag) || own.has(flag)) continue;
    const near = NEAR[flag];
    const whose = owners(flag);
    const hint =
      near && own.has(near)
        ? `${whose ? `${flag} is ${whose}; ` : ""}${name} takes ${written(near)}`
        : whose
          ? `it is ${whose}`
          : undefined;
    throw new Refusal(`${flag} is not an option of ${name}${hint ? `: ${hint}` : ""}`);
  }
}

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
  ];
}
