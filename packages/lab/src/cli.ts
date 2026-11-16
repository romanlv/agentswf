#!/usr/bin/env -S bun --no-env-file
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DATASET_KIND } from "./cases/format/settings";
import { type CasesEnvironment, runCases } from "./cases/lab/cli";
import { type LabEnvironment, runLab } from "./review/lab/cli";
import { locateConfigFile } from "./shared/config-file";

/** Commands only the case kind has. */
const CASE_COMMANDS = new Set(["case", "runs"]);

/** Flags of either kind that take a value, so the value is never read as the command. */
const VALUED = new Set([
  "--config",
  "--dataset",
  "--cases",
  "--trials",
  "--case",
  "--only",
  "--where",
  "--scorer",
  "--rest-from",
  "--baseline",
  "--comparison",
  "--budget",
  "--allowance",
  "--jobs",
  "--program",
  "--source",
  "--rounds",
  "--proposer",
  "--rescore",
  "--categories",
]);

/** The value of `flag` in `argv`, if given. */
function flagValue(argv: readonly string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  return at === -1 ? undefined : argv[at + 1];
}

/**
 * Which kind a command is for: `case` and `runs` are the case kind's; otherwise `--dataset` names
 * a folder beside `awf-lab.json` holding a `dataset.json` of the case kind, or, without it, the
 * case kind when `awf-lab.json` names no review `datasets`, and the review kind as before when it
 * does. An `awf-lab.json` found only in an `evals/` is the case kind's: the review kind never
 * looks there, so it would find another file, or none.
 */
export function kindOf(argv: readonly string[], cwd: string): "cases" | "review" {
  const command = argv.find((arg, i) => !arg.startsWith("-") && !VALUED.has(argv[i - 1] ?? ""));
  if (command && CASE_COMMANDS.has(command)) return "cases";
  const located = locateConfigFile(cwd, flagValue(argv, "--config"));
  if (!located || located.inEvals || !existsSync(located.file)) return "cases";
  const config = located.file;
  let raw: { datasets?: unknown } = {};
  try {
    raw = JSON.parse(readFileSync(config, "utf8"));
  } catch {
    return "cases";
  }
  const dataset = flagValue(argv, "--dataset");
  if (dataset !== undefined) {
    try {
      const file = join(dirname(config), dataset, "dataset.json");
      const kind = (JSON.parse(readFileSync(file, "utf8")) as { kind?: unknown }).kind;
      if (kind === DATASET_KIND) return "cases";
    } catch {}
  }
  return raw?.datasets === undefined ? "cases" : "review";
}

export async function runAwfLab(
  argv: readonly string[],
  environment: LabEnvironment & CasesEnvironment = {},
): Promise<number> {
  return kindOf(argv, environment.cwd ?? process.cwd()) === "cases"
    ? runCases(argv, environment)
    : runLab(argv, environment);
}

if (import.meta.main) process.exit(await runAwfLab(Bun.argv.slice(2)));
