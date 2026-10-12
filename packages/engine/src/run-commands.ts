import { resolve } from "node:path";
import type { AttemptRecord, RunLogLine } from "@agentswf/contract/records";
import { continueCommand, shellWord } from "./attempt-view";
import type { RunCommand } from "./run-command";
import { type Cursor, encodeCursor } from "./run-read";
import { RunNotFound, type RunStatus } from "./run-state";
import { runRootOf } from "./runs";

/** What `awf runs` and `awf logs` share: where they look, and how they say a run. */

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

/** Says a run that is not there, and exits 1; anything else is the run's files, exit 3. */
export function failed(error: unknown, place: ReadPlace, out: Out, message: string): number {
  if (error instanceof RunNotFound) {
    out.stderr(`${error.message}; runs here: ${command(place, "awf", "runs").join(" ")}`);
    return 1;
  }
  out.stderr(`awf: ${message}`);
  return 3;
}

/**
 * What `awf run` says first where no person watches its progress: the run's reference, the one
 * route a calling agent has to its own run. Its prefix, `awf: {workflow}/{id} started`, is stable.
 */
export function startedLine(
  workflow: string,
  id: string,
  run: Pick<RunCommand, "cwd" | "cwdGiven" | "runRoot" | "runRootGiven">,
): string {
  const ref = `${workflow}/${id}`;
  const repeat = [
    ...(run.cwdGiven ? ["--cwd", shellWord(run.cwd)] : []),
    ...(run.runRootGiven ? ["--run-root", shellWord(run.runRoot)] : []),
  ];
  return `awf: ${ref} started · watch: ${["awf", "logs", ref, ...repeat, "--wait", "90"].join(" ")}`;
}

/** `awf logs` from `cursor`: with `--wait` unless the page stopped short of the newest. */
export function nextLogs(
  status: RunStatus,
  place: ReadPlace,
  cursor: Cursor,
  filters: string[] = [],
  wait = true,
): string[] {
  return [
    ...command(place, "awf", "logs", status.ref),
    ...filters,
    "--after",
    encodeCursor(cursor),
    ...(wait ? ["--wait", "90"] : []),
  ];
}

/** The command an interrupted run goes on with, as `awf run` would print it. */
export function continueOf(
  status: RunStatus,
  lines: readonly { line: RunLogLine }[],
  place: ReadPlace,
): string | undefined {
  const { run } = status;
  const last = status.attempts.at(-1);
  if (!last) return undefined;
  const entered = lines.flatMap(({ line }) =>
    line.attempt === last.attempt &&
    (line.kind === "stage-started" || (line.kind === "stage-ended" && line.source))
      ? [{ stage: line.stage }]
      : [],
  );
  return continueCommand(
    {
      shellCwd: place.shellCwd,
      cwd: run.record.cwd,
      cwdGiven: resolve(run.record.cwd) !== resolve(place.shellCwd),
      runRoot: run.root,
      runRootGiven: resolve(run.root) !== resolve(runRootOf(run.record.cwd)),
      workflowFile: last.file,
      ...(last.flags.fromStage === undefined ? {} : { fromStage: last.flags.fromStage }),
    },
    run.record.id,
    undefined,
    entered,
  );
}

/** The stage the last attempt is in: open, or the one it ended in. */
export function currentStage(
  status: RunStatus,
  lines: readonly { line: RunLogLine }[],
): string | undefined {
  const last = status.attempts.at(-1);
  if (!last) return undefined;
  const open = new Set<string>();
  for (const { line } of lines) {
    if (line.attempt !== last.attempt) continue;
    if (line.kind === "stage-started") open.add(line.stage);
    if (line.kind === "stage-ended") open.delete(line.stage);
  }
  return [...open].at(-1) ?? last.stage;
}

/** `running`, or `running (unchecked, last event 09:41:07)` where its process could not be asked. */
export function stateWord(status: RunStatus, lastEventAt?: number): string {
  if (status.state !== "running" || status.checked) return status.state;
  return `running (unchecked${lastEventAt === undefined ? "" : `, last event ${clockTime(lastEventAt)}`})`;
}

/** From the first attempt's start to the last's end, or to now while it runs. */
export function span(
  status: RunStatus,
  now: number,
): { started: number; ended?: number; ms: number } {
  const started = Date.parse(status.attempts[0]?.started ?? status.run.record.created);
  const last = status.attempts.at(-1);
  const ended = last?.ended ? Date.parse(last.ended) : undefined;
  return { started, ...(ended === undefined ? {} : { ended }), ms: (ended ?? now) - started };
}

/** At list prices, over the attempts that kept one: never what was billed. */
export function estimateOf(attempts: readonly AttemptRecord[]): number | undefined {
  const known = attempts.flatMap((each) =>
    each.accounting?.totals.estimate === undefined ? [] : [each.accounting.totals.estimate],
  );
  return known.length > 0 ? known.reduce((sum, each) => sum + each, 0) : undefined;
}

export function clockTime(at: number | string): string {
  const date = new Date(at);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}
