import { randomBytes } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  type AttemptRecord,
  type ClaimedAttempt,
  type EventLine,
  type FailedLaunch,
  type RefusalCode,
  RUN_FORMAT,
  type RunLogLine,
  type RunPanes,
  type RunRecord,
  type RunView,
  runLogLine,
  type StageLine,
  type TurnRecord,
} from "@agentswf/contract/records";
import { type AttemptOutcome, nameProblem } from "@agentswf/contract/workflow";
import { exists, isCode, linkNew, syncDir, writeJson, writeWhole } from "./files";
import { inFile } from "./in-lines";
import { appendLine, endTornLine } from "./jsonl";
import { MESSAGE_LIMITS } from "./messaging/limits";
import type { EarlierOps } from "./ops";
import { type RunLines, readRunLines } from "./run-lines";
import { liveHolder, runOpenFile } from "./run-lock";
import { upcomingStages } from "./run-policy/stages";

/**
 * Runs on disk: `{root}/{workflow}/{id}/`, holding `run.json`, `attempts/{attempt}.json`,
 * `run.jsonl` (`run-lines.ts`), `log.jsonl`, `ops/` (`ops.ts`), the last ended attempt's
 * `out.json` and `report.md`, and `work/`. With those two modules, the only one that knows where a
 * run's records are; what the harness keeps in `work/`, such as agents' bundles and skills, the
 * module doing that work places. Only the live attempt writes, and the two claims, a run's folder
 * renamed into place and an attempt's file linked into place, are the only locks.
 */

/** Where a project's runs are kept, unless `--run-root` says otherwise. */
export function runRootOf(cwd: string): string {
  return join(cwd, ".awf", "runs");
}

/**
 * Why awf will not start an attempt: the operator's to fix, so `awf run` exits 2. `code` is its
 * refusal's: `id`, an id the grammar refuses or one taken; `no-run`; `other-args`, a continue given
 * other arguments or options; `prepare`, a recorded argv that no longer parses; `unreachable`, a
 * record that can't be read; `not-started`, a run that can't take an attempt now.
 */
export class RunRefused extends Error {
  constructor(
    message: string,
    readonly code: Extract<
      RefusalCode,
      "id" | "no-run" | "other-args" | "prepare" | "unreachable" | "not-started"
    >,
  ) {
    super(message);
    this.name = "RunRefused";
  }
}

export type Run = { root: string; dir: string; record: RunRecord };

/** An attempt's file, claimed. */
export type AttemptFile = { run: Run; file: string; record: ClaimedAttempt };

/**
 * An attempt that holds its run: its file, the writer its claim on `run.jsonl` gave it, and what its
 * claim's listing of `ops/` found.
 */
export type Attempt = AttemptFile & { lines: RunLines; ops: EarlierOps };

/** The start time of process `pid` as an ISO time to the second, or undefined when it is gone. */
export type ProcessProbe = (pid: number) => string | undefined;

// Case is kept, as a ticket's key has it; `createRun` refuses an id differing only in case.
const ID = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/;

/** Why `id` can't name a run or a workflow, or undefined when it can. */
export function idProblem(id: string): string | undefined {
  return typeof id === "string" && ID.test(id)
    ? undefined
    : `${JSON.stringify(id)} is not a valid id: letters, digits, '.', '_', '@' and '-', starting with a letter or digit, up to 128`;
}

/** Why `name` can't name a stage; undefined when it can. */
export function stageNameProblem(name: string): string | undefined {
  const problem = typeof name === "string" ? nameProblem(name) : "a string";
  return problem && `${JSON.stringify(name)} is not a stage's name: ${problem}`;
}

function checkIds(...ids: string[]): void {
  for (const id of ids) {
    const problem = idProblem(id);
    if (problem) throw new RunRefused(problem, "id");
  }
}

/** Local time and four random hex digits: `20261004-1532-a7f3`, sortable and short. */
export function generateId(
  now: Date = new Date(),
  random = randomBytes(2).toString("hex"),
): string {
  const two = (value: number) => String(value).padStart(2, "0");
  const date = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}`;
  return `${date}-${two(now.getHours())}${two(now.getMinutes())}-${random}`;
}

/**
 * Claims `{root}/{workflow}/{id}` with its `run.json`: written into a folder of its own, which is
 * then renamed into place. A rename onto a folder that exists and isn't empty fails, so the first
 * holds the id, and a claimed folder always has its `run.json`. An id differing only in case is
 * refused first, as APFS would. Without an id, one is generated, and generated again if taken.
 */
export async function createRun(
  root: string,
  record: Omit<RunRecord, "format" | "created" | "id"> & { id?: string },
  now: Date = new Date(),
  /** The event that starts the run, in its `in.jsonl` before the run is in place. */
  first?: EventLine,
): Promise<Run> {
  checkIds(record.workflow);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeIgnore(root);
  const parent = join(root, record.workflow);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await sweep(parent);
  for (let tries = 1; ; tries += 1) {
    const id = record.id ?? generateId(now);
    try {
      return await claimRun(root, parent, { ...record, id }, now, first);
    } catch (error) {
      if (record.id !== undefined || !(error instanceof RunTaken) || tries >= 5) throw error;
    }
  }
}

/** The id is a run's already, maybe in another case. */
export class RunTaken extends RunRefused {
  constructor(message: string) {
    super(message, "id");
  }
}

async function claimRun(
  root: string,
  parent: string,
  record: Omit<RunRecord, "format" | "created">,
  now: Date,
  first: EventLine | undefined,
): Promise<Run> {
  checkIds(record.id);
  const other = await takenInCase(parent, record.id);
  if (other !== undefined) throw new RunTaken(takenMessage(other));
  const full: RunRecord = { format: RUN_FORMAT, ...record, created: now.toISOString() };
  const pending = join(parent, `.new-${randomBytes(6).toString("hex")}`);
  await mkdir(pending, { mode: 0o700 });
  const dir = join(parent, record.id);
  try {
    await writeJson(runFile(pending), full);
    if (first) await writeWhole(inFile(pending), `${JSON.stringify(first)}\n`);
    await syncDir(pending);
    await rename(pending, dir);
  } catch (error) {
    await rm(pending, { recursive: true, force: true });
    if (isCode(error, "ENOTEMPTY", "EEXIST", "EISDIR")) throw new RunTaken(takenMessage(record.id));
    throw error;
  }
  // The run is in place and readable; a failed sync risks its entry only on a machine crash, so it
  // must not refuse an id this call now holds.
  await syncDir(parent).catch(() => undefined);
  return { root, dir, record: full };
}

function takenMessage(id: string): string {
  return `${id} exists; --continue goes on with it, or --id another id starts over`;
}

/** Another run whose id differs from `id` only in case; the same id is the rename's to refuse. */
export async function takenInCase(parent: string, id: string): Promise<string | undefined> {
  return (await entries(parent)).find(
    (name) => name !== id && name.toLowerCase() === id.toLowerCase(),
  );
}

/** Refuses an id that is taken, as `createRun` would, without claiming it. */
export async function checkFree(root: string, workflow: string, id: string): Promise<void> {
  checkIds(workflow, id);
  const parent = join(root, workflow);
  const taken = (await exists(join(parent, id))) ? id : await takenInCase(parent, id);
  if (taken !== undefined) throw new RunRefused(takenMessage(taken), "id");
}

/**
 * Removes a run this process created and never ran, so it leaves nothing behind and the id is free
 * again: its first attempt was never claimed, or is `own`, which ended before it started. Whether
 * it did: not while another attempt is there.
 */
export async function discardRun(run: Run, own?: AttemptFile): Promise<boolean> {
  const dir = attemptsDir(run.dir);
  const others = (await entries(dir)).filter((name) => join(dir, name) !== own?.file);
  if (others.length > 0) return false;
  await rm(run.dir, { recursive: true, force: true });
  return true;
}

/** The run `id` of `workflow`, naming the workflow it is under when it is another's. */
export async function openRun(root: string, workflow: string, id: string): Promise<Run> {
  checkIds(workflow, id);
  const dir = join(root, workflow, id);
  const file = runFile(dir);
  if (!(await exists(file))) {
    for (const other of await entries(root)) {
      if (other !== workflow && (await exists(runFile(join(root, other, id))))) {
        throw new RunRefused(
          `${id} is a run of ${other}; move ${join(root, other, id)} to ${dir} to continue it here`,
          "no-run",
        );
      }
    }
    throw new RunRefused(
      `no run ${id} of ${workflow} in ${root}; a run is kept under the directory it works in, which --cwd names`,
      "no-run",
    );
  }
  const record = await readRecord<RunRecord>(file);
  if (record.format !== RUN_FORMAT || missingField(record)) {
    throw new RunUnreadable(`${workflow}/${id}`, record);
  }
  return { root, dir, record };
}

/**
 * A run this awf does not read: its `run.json` has no `format`, made by an awf before the record
 * had one, or one this awf doesn't know. Nothing else of it is read.
 */
export class RunUnreadable extends RunRefused {
  /** `run.json`'s `created`, when it has one: where `awf runs` lists it. */
  readonly created?: string;
  /** Whether it is a run with events, which `awf tick` would have woken. */
  readonly events: boolean;
  readonly why: string;
  constructor(
    readonly ref: string,
    record: { format?: unknown; created?: unknown; events?: unknown },
  ) {
    const why = unreadableWhy(record);
    super(`${ref} is unreadable: ${why}`, "unreachable");
    this.why = why;
    this.name = "RunUnreadable";
    if (typeof record.created === "string") this.created = record.created;
    this.events = record.events === true;
  }
}

function unreadableWhy(record: { format?: unknown }): string {
  const { format } = record;
  if (format === undefined) {
    return "an earlier awf made it, before run.json had a format; this awf does not read it";
  }
  if (format !== RUN_FORMAT) {
    return `its run.json is format ${said(format)}; this awf reads format ${RUN_FORMAT} only`;
  }
  return `its run.json has no ${missingField(record)} of the right type`;
}

/** The first field format 1 requires of `run.json` that `record` lacks, or has of another type. */
function missingField(record: object): string | undefined {
  const fields = record as Record<string, unknown>;
  const strings = ["id", "workflow", "cwd", "created"] as const;
  const string = strings.find((field) => typeof fields[field] !== "string");
  if (string) return string;
  const { argv } = fields;
  if (!Array.isArray(argv) || !argv.every((each) => typeof each === "string")) return "argv";
  if (!("sandbox" in fields)) return "sandbox";
  return undefined;
}

const said = (value: unknown) => JSON.stringify(value)?.slice(0, 40) ?? String(value);

/**
 * What a continue may be given: nothing that changes the run. argv is the run's, and its working
 * directory, sandbox and panes are those it was started with.
 */
export function checkContinue(
  run: Run,
  given: { argv: readonly string[]; cwd?: string; sandbox?: unknown; panes?: RunPanes },
): void {
  const { id, cwd, sandbox } = run.record;
  const panes = panesChanged(run.record, given.panes);
  if (panes) throw new RunRefused(panes, "other-args");
  if (given.argv.length > 0) {
    throw new RunRefused(
      `${id} keeps the arguments it was started with; a run with others is a new run (--id)`,
      "other-args",
    );
  }
  if (given.cwd !== undefined && given.cwd !== cwd) {
    throw new RunRefused(`${id} works in ${cwd}, not ${given.cwd}`, "other-args");
  }
  if (given.sandbox !== undefined && JSON.stringify(given.sandbox) !== JSON.stringify(sandbox)) {
    throw new RunRefused(
      `${id} runs in the sandbox it was started with; leave --sandbox out`,
      "other-args",
    );
  }
}

/**
 * Why `given` would change the panes `record`'s run was started with; a flag given again with its
 * value, or with its default where the run was started without it, changes nothing.
 */
export function panesChanged(record: RunRecord, given: RunPanes | undefined): string | undefined {
  const flags = [
    ["--workspace", "workspace", "run"],
    ["--keep-panes", "keep", "never"],
  ] as const;
  for (const [flag, field, byDefault] of flags) {
    const value = given?.[field];
    const recorded = record.panes?.[field];
    if (value === undefined || isDeepStrictEqual(value, recorded ?? byDefault)) continue;
    // A run an event or an older awf started has none, and keeps the defaults.
    return recorded === undefined
      ? `${record.id} was started without ${flag}, so with ${flag} ${byDefault}; leave it out`
      : `${record.id} keeps the ${flag} it was started with; leave ${flag} out`;
  }
  return undefined;
}

/**
 * The attempts that ran, in order: every attempt file but a background launch that never claimed
 * its number. What a run does next, and how it shows, is decided from these.
 */
export async function readAttempts(run: Pick<Run, "dir">): Promise<ClaimedAttempt[]> {
  return claimedOf(await readAttemptFiles(run));
}

/** Where background launch `launch` of a run writes its output. */
export function launchLog(runDir: string, launch: string): string {
  return join(runDir, "launches", `${launch}.log`);
}

/** Whether `attempt` claimed its number and ran, rather than being a launch that never did. */
export function isClaimed(attempt: AttemptRecord): attempt is ClaimedAttempt {
  return attempt.kind !== "failed-launch";
}

/** The attempts of `attempts` that claimed their number, in order. */
export function claimedOf(attempts: readonly AttemptRecord[]): ClaimedAttempt[] {
  return attempts.filter(isClaimed);
}

/**
 * Every attempt file, in order, a failed launch's included: what `stuck` counts and the next
 * number follows. One that doesn't parse refuses, and `run.json`'s `format` is their version; one
 * gone since the folder was listed was a refused attempt removing its own claim.
 */
export async function readAttemptFiles(run: Pick<Run, "dir">): Promise<AttemptRecord[]> {
  const dir = attemptsDir(run.dir);
  const numbered = await attemptNames(run);
  const records = await Promise.all(
    numbered.map(async (name) => {
      const file = join(dir, name);
      const record = await readRecord<AttemptRecord>(file, { missing: true });
      const problem = record && attemptProblem(record);
      if (problem) throw new RunRefused(`${file} could not be read: ${problem}`, "unreachable");
      return record;
    }),
  );
  return records.filter((record) => record !== undefined).sort((a, b) => a.attempt - b.attempt);
}

/** Why `record` isn't an attempt file this awf reads: its number and kind are what it relies on. */
function attemptProblem(record: AttemptRecord): string | undefined {
  const { attempt, kind } = record as { attempt?: unknown; kind?: unknown };
  if (!Number.isSafeInteger(attempt) || (attempt as number) < 1) return "no positive attempt";
  if (kind !== "attempt" && kind !== "failed-launch") return `kind ${said(kind)} is unknown`;
  return undefined;
}

/** No ending, and its process still the one that started it. */
export function isLive(attempt: ClaimedAttempt, probe: ProcessProbe = processStart): boolean {
  return attempt.ended === undefined && sameProcess(attempt.pid, attempt.processStart, probe);
}

/**
 * Process `pid` is there and still the one that started at `started`, which tells a reused pid
 * apart. A second apart is the same start: on Linux `ps` derives it from the boot time, which a
 * clock step can move.
 */
export function sameProcess(
  pid: number,
  started: string,
  probe: ProcessProbe = processStart,
): boolean {
  const now = probe(pid);
  return now !== undefined && sameStart(now, started);
}

/**
 * Two `ps` start times of one process: a second apart is the same start, as on Linux `ps` derives
 * it from the boot time, which a clock step can move.
 */
export function sameStart(now: string, started: string): boolean {
  return Math.abs(Date.parse(now) - Date.parse(started)) <= 1_000;
}

/**
 * Why a run takes no attempt now: one of its attempts is still running, `awf open --no-fork`
 * holds its session, or it completed.
 */
export type AttemptRefusal =
  | { kind: "running"; attempt: ClaimedAttempt }
  /** `events`: the run is woken once that exits; a plain run is continued by hand. */
  | { kind: "opened"; pid: number; events: boolean }
  /**
   * `stages`, each recorded stage's latest line in the order they started, but those the last
   * redo left behind, are what `--from-stage` redoes.
   */
  | { kind: "completed"; stages: StageLine[] };

/**
 * Why the run whose attempts and `run.jsonl` these are takes no attempt now, or undefined when it
 * takes one. A completed run takes one only to redo a stage, which `fromStage` says.
 */
export function attemptRefusal(
  attempts: readonly ClaimedAttempt[],
  run: Pick<RunView, "stages" | "redo">,
  options: { fromStage: boolean; probe?: ProcessProbe },
): AttemptRefusal | undefined {
  const live = attempts.find((attempt) => isLive(attempt, options.probe));
  if (live) return { kind: "running", attempt: live };
  const last = attempts.at(-1);
  if (last?.outcome !== "completed" || options.fromStage) return undefined;
  // A stage the code no longer has keeps its line, but the last redo left it behind.
  return { kind: "completed", stages: upcomingStages(run) };
}

/** Why `awf open --no-fork` holding the run refuses an attempt, or undefined when none holds it. */
export async function openedRefusal(run: Run): Promise<AttemptRefusal | undefined> {
  const holder = await liveHolder(runOpenFile(run.root, run.record.workflow, run.record.id));
  return holder
    ? { kind: "opened", pid: holder.pid, events: run.record.events === true }
    : undefined;
}

/**
 * Claims the next attempt by linking its file into place, which fails when the name exists, so a
 * failed link tries the next number. Having claimed `n`, it reads attempts `1 … n-1`: one still
 * live refuses it, and its own file goes, as it does when the last of them completed the run. Of
 * two racing attempts the later always sees the earlier, since it could only pick a higher number
 * once the earlier file existed. A refusal is returned, for the caller to say.
 */
export async function claimAttempt(
  run: Run,
  fields: Pick<ClaimedAttempt, "file" | "workflowVersion" | "flags" | "launch">,
  options: {
    now?: Date;
    pid?: number;
    probe?: ProcessProbe;
    /** `--from-stage`: a run that completed is continued only to redo a stage of it. */
    fromStage?: boolean;
  } = {},
): Promise<{ attempt: AttemptFile; interrupted: ClaimedAttempt[] } | { refused: AttemptRefusal }> {
  const probe = options.probe ?? processStart;
  const pid = options.pid ?? process.pid;
  const started = probe(pid);
  if (started === undefined) {
    throw new Error(`ps -o lstart= gave no start time for this process (${pid})`);
  }
  const dir = attemptsDir(run.dir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await sweep(dir);
  // Numbered past every file, a failed launch's included.
  const earlier = await readAttemptFiles(run);
  let n = (earlier.at(-1)?.attempt ?? 0) + 1;
  for (;;) {
    const record: ClaimedAttempt = {
      attempt: n,
      kind: "attempt",
      file: fields.file,
      ...(fields.workflowVersion === undefined ? {} : { workflowVersion: fields.workflowVersion }),
      flags: fields.flags,
      ...(fields.launch === undefined ? {} : { launch: fields.launch }),
      pid,
      processStart: started,
      started: (options.now ?? new Date()).toISOString(),
      messageLimits: MESSAGE_LIMITS,
    };
    const file = join(dir, `${n}.json`);
    if (await linkNew(file, record)) {
      // Unclaimed on any refusal or failure, so no attempt is left without an ending.
      const unclaim = () => unlink(file).catch(() => undefined);
      try {
        await syncDir(dir);
        const before = (await readAttempts(run)).filter((other) => other.attempt < n);
        // Linked first, then looked for: `awf open --no-fork` claims its file, then looks for a
        // live attempt, so of the two one always sees the other.
        const refused =
          attemptRefusal(before, (await readRunLines(run.dir)).view, {
            fromStage: options.fromStage ?? false,
            probe,
          }) ?? (await openedRefusal(run));
        if (refused) {
          await unclaim();
          return { refused };
        }
        const interrupted = before.filter((other) => other.ended === undefined);
        return { attempt: { run, file, record }, interrupted };
      } catch (error) {
        await unclaim();
        throw error;
      }
    }
    n += 1;
  }
}

/**
 * A background launch that ended without claiming attempt `attempt`, the number it would have
 * claimed: linked as that attempt's file, failed, with no process, so `stuck` counts it. False when
 * the launched attempt claimed the number after all, which then says what happened.
 */
export async function recordFailedLaunch(
  run: Run,
  failed: {
    attempt: number;
    launch: string;
    file: string;
    started: string;
    reason: string;
  },
  now: Date = new Date(),
): Promise<boolean> {
  const dir = attemptsDir(run.dir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const record: FailedLaunch = {
    attempt: failed.attempt,
    kind: "failed-launch",
    launch: failed.launch,
    file: failed.file,
    started: failed.started,
    ended: now.toISOString(),
    outcome: "failed",
    reason: failed.reason,
  };
  const linked = await linkNew(join(dir, `${failed.attempt}.json`), record);
  if (linked) await syncDir(dir);
  return linked;
}

/** Writes the attempt's ending into its file, whole. */
export async function endAttempt(
  attempt: AttemptFile,
  ending: Pick<ClaimedAttempt, "stage" | "reason" | "value"> & { outcome: AttemptOutcome },
  now: Date = new Date(),
): Promise<ClaimedAttempt> {
  const { stage, reason, value } = ending;
  const record: ClaimedAttempt = {
    ...attempt.record,
    ended: now.toISOString(),
    outcome: ending.outcome,
    ...(stage === undefined ? {} : { stage }),
    ...(reason === undefined ? {} : { reason }),
    ...(ending.outcome === "completed" && value !== undefined ? { value } : {}),
  };
  await writeJson(attempt.file, record);
  attempt.record = record;
  return record;
}

/** Appends a line to the run's event log, `log.jsonl`, which only the live attempt writes. */
export async function appendEvent(runDir: string, line: RunLogLine): Promise<void> {
  await appendLine(logFile(runDir), JSON.stringify(line));
}

/** Ends a line a crash left torn, so the next line appended starts a line of its own. */
export async function endLogLine(runDir: string): Promise<void> {
  await endTornLine(logFile(runDir));
}

/** The run's event log in the order written, less a line a crash tore and the kinds this awf does not know. */
export async function readEvents(runDir: string): Promise<RunLogLine[]> {
  return (await readNumberedEvents(runDir)).map(({ line }) => line);
}

/**
 * The same, each with its line number in the file, from 1: its position, which never changes, as
 * lines are only appended.
 */
export async function readNumberedEvents(
  runDir: string,
): Promise<{ number: number; line: RunLogLine }[]> {
  return (await readEventsFrom(runDir, { offset: 0, count: 0 })).lines;
}

/** Where a read of the event log stopped: the bytes up to its last ended line, and the lines in them. */
export type LogMark = { offset: number; count: number };

/**
 * The event log's lines past `from`, numbered on from it, and where this read stopped: what was
 * appended since a read that stopped at `from`.
 */
export async function readEventsFrom(
  runDir: string,
  from: LogMark,
): Promise<{ lines: { number: number; line: RunLogLine }[]; mark: LogMark }> {
  let bytes: Buffer;
  try {
    const file = await open(logFile(runDir), "r");
    try {
      const { size } = await file.stat();
      bytes = Buffer.alloc(Math.max(0, size - from.offset));
      let read = 0;
      while (read < bytes.length) {
        const { bytesRead } = await file.read(bytes, read, bytes.length - read, from.offset + read);
        if (bytesRead === 0) break;
        read += bytesRead;
      }
      bytes = bytes.subarray(0, read);
    } finally {
      await file.close();
    }
  } catch (error) {
    if (!isCode(error, "ENOENT")) throw error;
    bytes = Buffer.alloc(0);
  }
  // A last line not yet ended is still being written.
  const end = bytes.lastIndexOf(0x0a) + 1;
  const texts =
    end === 0
      ? []
      : bytes
          .subarray(0, end - 1)
          .toString("utf8")
          .split("\n");
  const lines = texts.flatMap((json, index) => {
    try {
      const value: unknown = JSON.parse(json);
      const line = typeof value === "object" && value !== null ? runLogLine(value) : undefined;
      return line ? [{ number: from.count + index + 1, line }] : [];
    } catch {
      return [];
    }
  });
  return { lines, mark: { offset: from.offset + end, count: from.count + texts.length } };
}

/** The event log's size in bytes, 0 before it is written. */
export async function logSize(runDir: string): Promise<number> {
  return (await stat(logFile(runDir)).catch(() => undefined))?.size ?? 0;
}

async function attemptNames(run: Pick<Run, "dir">): Promise<string[]> {
  return (await entries(attemptsDir(run.dir))).filter((name) => /^[1-9]\d*\.json$/.test(name));
}

/**
 * A token that changes when the run's attempt records do: one added, removed, or rewritten, as an
 * attempt's end is.
 */
export async function attemptsToken(run: Run): Promise<string> {
  const dir = attemptsDir(run.dir);
  const names = await attemptNames(run);
  const stats = await Promise.all(
    names.map((name) => stat(join(dir, name)).catch(() => undefined)),
  );
  return names
    .map((name, index) => {
      const info = stats[index];
      return info ? `${name}:${info.ino}:${info.size}:${info.mtimeMs}` : `${name}:-`;
    })
    .join(",");
}

/** Every turn of the run, in the order they settled. */
export async function readTurns(runDir: string): Promise<TurnRecord[]> {
  return (await readEvents(runDir)).filter(
    (line): line is TurnRecord => line.kind === "turn" || line.kind === "compact",
  );
}

/** The last ended attempt's `out.json`, a view: what `awf run --json` printed. */
export function outFile(runDir: string): string {
  return join(runDir, "out.json");
}

/** Harness scratch: `skills/`, `agents/`, `staging/` and `forks/`. Only the attempt that made it uses it. */
export function workDir(runDir: string): string {
  return join(runDir, "work");
}

/** The last ended attempt's `report.md`. */
export function reportFile(runDir: string): string {
  return join(runDir, "report.md");
}

function runFile(runDir: string): string {
  return join(runDir, "run.json");
}

function attemptsDir(runDir: string): string {
  return join(runDir, "attempts");
}

/** The run's event log, `log.jsonl`: read, never acted on. */
export function logFile(runDir: string): string {
  return join(runDir, "log.jsonl");
}

async function readRecord<T>(file: string): Promise<T>;
async function readRecord<T>(file: string, options: { missing: true }): Promise<T | undefined>;
async function readRecord<T>(
  file: string,
  options: { missing?: true } = {},
): Promise<T | undefined> {
  let record: unknown;
  try {
    record = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (options.missing && isCode(error, "ENOENT")) return undefined;
    throw new RunRefused(`${file} could not be read: ${(error as Error).message}`, "unreachable");
  }
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    throw new RunRefused(`${file} could not be read: not a JSON object`, "unreachable");
  }
  return record as T;
}

/** So no run is committed by accident, as pytest and ruff keep their caches. */
async function writeIgnore(root: string): Promise<void> {
  try {
    const handle = await open(join(root, ".gitignore"), "wx", 0o644);
    try {
      await handle.writeFile("*\n");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (!isCode(error, "EEXIST")) throw error;
  }
}

const DAY_MS = 24 * 60 * 60_000;

/** Removes temp files and folders a crash left, once they are a day old: no writer is still on them. */
async function sweep(dir: string, now = Date.now()): Promise<void> {
  const names = await readdir(dir).catch(() => [] as string[]);
  for (const name of names) {
    if (!name.startsWith(".tmp-") && !name.startsWith(".new-")) continue;
    const path = join(dir, name);
    const info = await stat(path).catch(() => undefined);
    if (info && now - info.mtimeMs > DAY_MS) await rm(path, { recursive: true, force: true });
  }
}

/** A folder's entries, sorted, without hidden ones (temp files, `.gitignore`); none when it is not there. */
export async function entries(dir: string): Promise<string[]> {
  const names = await readdir(dir).catch((error) => {
    if (isCode(error, "ENOENT")) return [] as string[];
    throw error;
  });
  return names.filter((name) => !name.startsWith(".")).sort();
}

/**
 * `ps -o lstart=` in UTC, as an ISO time to the second: the same on macOS and Linux, and whatever
 * time zone the attempt that wrote it and the one checking it each run in.
 */
export function processStart(pid: number): string | undefined {
  const found = probeProcess(pid);
  return found === "gone" || found === "unknown" ? undefined : found;
}

/**
 * What `ps` says of process `pid`: when it started, as `processStart` gives it, `gone`, or
 * `unknown` where `ps` could not be asked, as in a sandbox that forbids it.
 */
export function probeProcess(pid: number, ps: Ps = runPs): string | "gone" | "unknown" {
  if (!Number.isSafeInteger(pid) || pid <= 0) return "gone";
  let done: ReturnType<Ps>;
  try {
    done = ps(pid);
  } catch {
    return "unknown";
  }
  const text = done.stdout.trim();
  // `ps` exits 1 and prints nothing at all for a pid that is not there; one that cannot take these
  // options, as BusyBox's, says so on stderr.
  if (text === "") return done.exitCode === 1 && done.stderr.trim() === "" ? "gone" : "unknown";
  const time = new Date(`${text} UTC`);
  return Number.isNaN(time.getTime()) ? "unknown" : time.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** `ps -o lstart= -p {pid}`, as it answered. */
export type Ps = (pid: number) => { stdout: string; stderr: string; exitCode: number | null };

const runPs: Ps = (pid) => {
  const done = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, LC_ALL: "C", TZ: "UTC0" },
  });
  return {
    stdout: done.stdout?.toString() ?? "",
    stderr: done.stderr?.toString() ?? "",
    exitCode: done.exitCode,
  };
};

/** How long a continue waits for the attempt before it to exit before it stops that process. */
const PREVIOUS_GONE_MS = 5 * 60_000;

/**
 * Waits until the last attempt before `n` that ran, a parked one closing its agents or one that crashed with
 * its process left, is gone; past five minutes, cancels it, then kills it if it ignores that.
 * Its agents' sessions are then this attempt's.
 */
export async function previousGone(
  run: Run,
  n: number,
  notice: (text: string) => void,
): Promise<void> {
  // The last attempt before `n` that ran: a launch that never claimed its number had no process.
  const previous = (await readAttempts(run)).filter((each) => each.attempt < n).at(-1);
  // One that ran in this process, as a workflow's tests run attempts, has ended: waiting for it
  // would be waiting for ourselves.
  if (!previous || previous.pid === process.pid) return;
  const { pid } = previous;
  const alive = () => sameProcess(pid, previous.processStart, processStart);
  const started = Date.now();
  const giveUp = started + PREVIOUS_GONE_MS;
  let said = false;
  while (alive()) {
    if (!said && Date.now() > started + 10_000) {
      said = true;
      notice(
        `awf: waiting for attempt ${previous.attempt} (pid ${previous.pid}) to finish closing`,
      );
    }
    if (Date.now() > giveUp) {
      notice(
        `awf: attempt ${previous.attempt} (pid ${previous.pid}) is still running; stopping it`,
      );
      // A cancel first, which closes its agents and sandboxes; only a process that ignores it is killed.
      const signal = (name: NodeJS.Signals) => {
        try {
          process.kill(pid, name);
        } catch {
          // Gone between the look and the signal.
        }
      };
      signal("SIGTERM");
      const killAt = Date.now() + 30_000;
      while (alive() && Date.now() < killAt) await Bun.sleep(200);
      if (alive()) signal("SIGKILL");
      return;
    }
    await Bun.sleep(100);
  }
}
