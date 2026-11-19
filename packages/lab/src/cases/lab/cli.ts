import { homedir } from "node:os";
import { basename, join, relative } from "node:path";
import { findConfigFile } from "../../shared/config-file";
import { captureCommand, label } from "./capture-command";
import {
  type CasesEnvironment,
  type Context,
  type Options,
  relativePaths,
} from "./command-context";
import { ENV_FILE } from "./dataset";
import { gitTop } from "./git";
import { loopCommand } from "./loop-command";
import { Refusal } from "./refusal";
import { report } from "./report-command";
import { refuseRetiredCommand, refuseRetiredFlag } from "./retired";
import { run } from "./run-command";
import { runs } from "./runs-command";
import { newCase } from "./scaffold";
import { score } from "./score-command";
import {
  commandUsage,
  fullUsage,
  isCommand,
  refuseForeignFlags,
  refuseNotCommand,
  refuseUnknownFlag,
} from "./usage";

function parse(argv: readonly string[]): {
  command?: string;
  names: string[];
  options: Options;
  /** The flags given, each once, as written; `-h` as `--help`. */
  flags: string[];
  /** Flags no command takes, in the order given. */
  unknown: string[];
} {
  const options: Options = {
    failed: false,
    yes: false,
    dryRun: false,
    json: false,
    help: false,
    against: [],
    param: [],
    vary: [],
    fresh: false,
    holdout: false,
    clear: false,
    md: false,
    judges: [],
    good: false,
    final: false,
    patch: false,
  };
  const positional: string[] = [];
  const flags = new Set<string>();
  const unknown: string[] = [];
  const rest = [...argv];
  const value = (flag: string) => {
    const next = rest.shift();
    if (next === undefined || next.startsWith("--")) throw new Refusal(`${flag} needs a value`);
    return next;
  };
  while (rest.length > 0) {
    const arg = rest.shift()!;
    if (arg.startsWith("-")) flags.add(arg === "-h" ? "--help" : arg);
    switch (arg) {
      case "--config":
        options.config = value(arg);
        break;
      case "--dataset":
        options.dataset = value(arg);
        break;
      case "--cases":
        options.cases = value(arg)
          .split(",")
          .map((c) => c.trim())
          .filter(Boolean);
        break;
      case "--failed":
        options.failed = true;
        break;
      case "--trials": {
        const text = value(arg);
        if (!/^[1-9][0-9]*$/.test(text)) throw new Refusal("--trials is a whole number from 1");
        options.trials = Number(text);
        break;
      }
      case "--against":
        options.against.push(value(arg));
        break;
      case "--tags":
        options.tags = value(arg)
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);
        break;
      case "--judge":
        options.judges.push(value(arg));
        break;
      case "--voters": {
        const text = value(arg);
        if (!/^[13579]$/.test(text)) throw new Refusal("--voters is odd, from 1 to 9");
        options.voters = Number(text);
        break;
      }
      case "--md":
        options.md = true;
        break;
      case "--holdout":
        options.holdout = true;
        break;
      case "--clear":
        options.clear = true;
        break;
      case "--fresh":
        options.fresh = true;
        break;
      case "--param":
        options.param.push(value(arg));
        break;
      case "--vary":
        options.vary.push(value(arg));
        break;
      case "--case":
        options.case = value(arg);
        break;
      case "--yes":
        options.yes = true;
        break;
      case "--good":
        options.good = true;
        break;
      case "--needs-work":
        options.needsWork = value(arg);
        break;
      case "--grader":
        options.grader = value(arg);
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--budget": {
        const text = value(arg);
        const usd = Number(text);
        if (!/^[0-9]+(\.[0-9]+)?$/.test(text) || !(usd > 0)) {
          throw new Refusal("--budget is US dollars, more than 0, such as 5 or 2.50");
        }
        options.budget = usd;
        break;
      }
      case "--program":
        options.program = value(arg);
        break;
      case "--proposer":
        options.proposer = value(arg);
        break;
      case "--rounds": {
        const text = value(arg);
        if (!/^[1-9][0-9]*$/.test(text)) throw new Refusal("--rounds is a whole number from 1");
        options.rounds = Number(text);
        break;
      }
      case "--allowance": {
        const text = value(arg);
        if (text === "off") options.allowance = "off";
        else if (/^[0-9]+$/.test(text) && Number(text) >= 1 && Number(text) <= 100) {
          options.allowance = Number(text);
        } else throw new Refusal("--allowance is a percent from 1 to 100, or off");
        break;
      }
      case "--final":
        options.final = true;
        break;
      case "--patch":
        options.patch = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        if (arg.startsWith("-")) {
          refuseRetiredFlag(arg);
          unknown.push(arg);
        } else positional.push(arg);
    }
  }
  const [command, ...names] = positional;
  return { ...(command ? { command } : {}), names, options, flags: [...flags], unknown };
}

/** The command line: the commands in `usage.ts`. */
export async function runCases(
  argv: readonly string[],
  environment: CasesEnvironment = {},
): Promise<number> {
  const stdout = environment.stdout ?? ((text) => console.log(text));
  const stderr = environment.stderr ?? ((text) => void process.stderr.write(`${text}\n`));
  try {
    const { command, names, options, flags, unknown } = parse(argv);
    if (command === "help" || (!command && options.help && unknown.length === 0)) {
      stdout(fullUsage());
      return 0;
    }
    if (!command) {
      if (unknown.length > 0) refuseUnknownFlag(unknown[0]!, undefined);
      stderr(`awf-lab needs a command:\n${fullUsage()}`);
      return 2;
    }
    refuseNotCommand(command);
    refuseRetiredCommand(command);
    if (!isCommand(command)) {
      throw new Refusal(`unknown command ${command}; awf-lab --help lists them`);
    }
    if (unknown.length > 0) refuseUnknownFlag(unknown[0]!, command);
    if (options.help) {
      stdout(commandUsage(command)!);
      return 0;
    }
    refuseForeignFlags(command, flags);
    const context: Context = {
      cwd: environment.cwd ?? process.cwd(),
      home: environment.home ?? homedir(),
      options,
      environment,
      stdout,
      stderr,
    };
    switch (command) {
      case "case":
        return caseCommand(context, names);
      case "run":
        if (names.length > 0) {
          throw new Refusal(
            `run takes no words, only flags; got ${names.join(" ")}: --cases {a,b} picks cases, --dataset {name} a dataset`,
          );
        }
        return (await run(context)).exit;
      case "report":
        return await report(context, names);
      case "score":
        return await score(context, names);
      case "capture":
        return await captureCommand(context, names);
      case "runs":
        if (names.length > 0) throw new Refusal(`runs takes nothing; got ${names.join(" ")}`);
        return runs(context);
      case "label":
        return label(context, names);
      case "loop":
        return await loopCommand(context, names);
    }
  } catch (error) {
    if (error instanceof Refusal) {
      stderr(`awf-lab: ${relativePaths(environment.cwd ?? process.cwd(), error.message)}`);
      return 2;
    }
    stderr(`awf-lab: ${(error as Error).message}`);
    return 4;
  }
}

function caseCommand(context: Context, names: readonly string[]): number {
  const [verb, address, ...extra] = names;
  if (verb !== "new") {
    throw new Refusal(`case takes new${verb ? `, not ${verb}` : ""}: case new {dataset}/{case}`);
  }
  if (!address) throw new Refusal("case new needs a {dataset}/{case}");
  if (extra.length > 0) {
    throw new Refusal(
      `case new takes one {dataset}/{case}; got ${extra.length + 1} words: ${[address, ...extra].join(" ")}`,
    );
  }
  const config = findConfigFile(context.cwd, context.options.config);
  const evals = config ? join(config, "..") : join(gitTop(context.cwd) ?? context.cwd, "evals");
  const made = newCase(evals, address);
  const shown = (file: string) => relative(context.cwd, file) || file;
  for (const file of made.written) context.stdout(`wrote ${shown(file)}`);
  const envFile = made.written.find((file) => basename(file) === ENV_FILE);
  context.stdout(
    envFile
      ? `next: fill ${shown(envFile)} and delete its first line, then the case's input.json and its key's expect`
      : `case ${shown(made.caseDir)}: write its key.md and files/`,
  );
  return 0;
}
