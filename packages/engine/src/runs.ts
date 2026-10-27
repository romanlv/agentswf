import { randomBytes } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  ATTEMPT_RECORD_VERSION,
  type AttemptRecord,
  type CallSpec,
  type Candidate,
  RUN_RECORD_VERSION,
  type RunLogLine,
  type RunRecord,
  runLogLine,
  STAGE_RECORD_VERSION,
  type StageRecord,
  type TurnRecord,
} from "@agentswf/contract/records";
import { type AttemptOutcome, nameProblem } from "@agentswf/contract/workflow";
import { exists, isCode, linkNew, writeJson } from "./files";
import { appendLine, endTornLine, readLines } from "./jsonl";
import { MESSAGE_LIMITS } from "./messaging/limits";

/**
 * Runs on disk: `{root}/{workflow}/{id}/`, holding `run.json`, `attempts/{attempt}.json`,
 * `stages/{stage}.json`, `replaced/{stage}.{attempt}.json`, `turns.jsonl`, each operation's
 * `calls/{id}/` with its `call.json`, `candidates.jsonl` and `result.json`, and the last ended
 * attempt's `output.json` and `report.md`. The only module that knows where a run's records are;
 * what its work keeps beside them, such as agents' bundles, skills and decisions, the module doing
 * that work places. Only the live attempt writes, and the two claims, a run's folder renamed into
 * place and an attempt's file linked into place, are the only locks.
 */

/** Where a project's runs are kept, unless `--run-root` says otherwise. */
export function runRootOf(cwd: string): string {
  return join(cwd, ".awf", "runs");
}

/** Why awf will not start an attempt: the operator's to fix, so `awf run` exits 2. */
export class RunRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunRefused";
  }
}

export type Run = { root: string; dir: string; record: RunRecord };

export type Attempt = { run: Run; file: string; record: AttemptRecord };

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

/** Why `name` can't name a stage, which is a file in the run's `stages/`; undefined when it can. */
export function stageNameProblem(name: string): string | undefined {
  const problem = typeof name === "string" ? nameProblem(name) : "a string";
  return problem && `${JSON.stringify(name)} is not a stage's name: ${problem}`;
}

function checkIds(...ids: string[]): void {
  for (const id of ids) {
    const problem = idProblem(id);
    if (problem) throw new RunRefused(problem);
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
  record: Omit<RunRecord, "version" | "created" | "id"> & { id?: string },
  now: Date = new Date(),
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
      return await claimRun(root, parent, { ...record, id }, now);
    } catch (error) {
      if (record.id !== undefined || !(error instanceof RunTaken) || tries >= 5) throw error;
    }
  }
}

class RunTaken extends RunRefused {}

async function claimRun(
  root: string,
  parent: string,
  record: Omit<RunRecord, "version" | "created">,
  now: Date,
): Promise<Run> {
  checkIds(record.id);
  const other = await takenInCase(parent, record.id);
  if (other !== undefined) throw new RunTaken(takenMessage(other));
  const full: RunRecord = { version: RUN_RECORD_VERSION, ...record, created: now.toISOString() };
  const pending = join(parent, `.new-${randomBytes(6).toString("hex")}`);
  await mkdir(pending, { mode: 0o700 });
  const dir = join(parent, record.id);
  try {
    await writeJson(runFile(pending), full);
    await rename(pending, dir);
  } catch (error) {
    await rm(pending, { recursive: true, force: true });
    if (isCode(error, "ENOTEMPTY", "EEXIST", "EISDIR")) throw new RunTaken(takenMessage(record.id));
    throw error;
  }
  return { root, dir, record: full };
}

function takenMessage(id: string): string {
  return `${id} exists; --continue it, or --id another to start over`;
}

/** Another run whose id differs from `id` only in case; the same id is the rename's to refuse. */
async function takenInCase(parent: string, id: string): Promise<string | undefined> {
  return (await entries(parent)).find(
    (name) => name !== id && name.toLowerCase() === id.toLowerCase(),
  );
}

/** Refuses an id that is taken, as `createRun` would, without claiming it. */
export async function checkFree(root: string, workflow: string, id: string): Promise<void> {
  checkIds(workflow, id);
  const parent = join(root, workflow);
  const taken = (await exists(join(parent, id))) ? id : await takenInCase(parent, id);
  if (taken !== undefined) throw new RunRefused(takenMessage(taken));
}

/**
 * Removes a run this process created and never ran, so it leaves nothing behind and the id is free
 * again: its first attempt was never claimed, or is `own`, which ended before it started. Whether
 * it did: not while another attempt is there.
 */
export async function discardRun(run: Run, own?: Attempt): Promise<boolean> {
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
        );
      }
    }
    throw new RunRefused(
      `no run ${id} of ${workflow} in ${root}; a run is kept under the directory it works in, which --cwd names`,
    );
  }
  const record = await readRecord<RunRecord>(file, RUN_RECORD_VERSION);
  return { root, dir, record };
}

/**
 * What a continue may be given: nothing that changes the run. argv is the run's, and its working
 * directory and sandbox are those it was started with.
 */
export function checkContinue(
  run: Run,
  given: { argv: readonly string[]; cwd?: string; sandbox?: unknown },
): void {
  const { id, cwd, sandbox } = run.record;
  if (given.argv.length > 0) {
    throw new RunRefused(
      `${id} keeps the arguments it was started with; a run with others is a new run (--id)`,
    );
  }
  if (given.cwd !== undefined && given.cwd !== cwd) {
    throw new RunRefused(`${id} works in ${cwd}, not ${given.cwd}`);
  }
  if (given.sandbox !== undefined && JSON.stringify(given.sandbox) !== JSON.stringify(sandbox)) {
    throw new RunRefused(`${id} runs in the sandbox it was started with; leave --sandbox out`);
  }
}

/**
 * The run's attempts, in order. One that doesn't parse, or is newer than this awf, refuses; one
 * gone since the folder was listed was a refused attempt removing its own claim.
 */
export async function readAttempts(run: Run): Promise<AttemptRecord[]> {
  const dir = attemptsDir(run.dir);
  const numbered = await attemptNames(run);
  const records = await Promise.all(
    numbered.map((name) =>
      readRecord<AttemptRecord>(join(dir, name), ATTEMPT_RECORD_VERSION, { missing: true }),
    ),
  );
  return records.filter((record) => record !== undefined).sort((a, b) => a.attempt - b.attempt);
}

/** No ending, and its process still the one that started it. */
export function isLive(attempt: AttemptRecord, probe: ProcessProbe = processStart): boolean {
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

/** Why a run takes no attempt now: one of its attempts is still running, or it completed. */
export type AttemptRefusal =
  | { kind: "running"; attempt: AttemptRecord }
  /** `stages` are the run's records, in the order they began, from which `--from-stage` redoes. */
  | { kind: "completed"; stages: StageRecord[] };

/**
 * Why the run whose attempts and stage records these are takes no attempt now, or undefined when
 * it takes one. A completed run takes one only to redo a stage, which `fromStage` says.
 */
export function attemptRefusal(
  attempts: readonly AttemptRecord[],
  records: ReadonlyMap<string, StageRecord>,
  options: { fromStage: boolean; probe?: ProcessProbe },
): AttemptRefusal | undefined {
  const live = attempts.find((attempt) => isLive(attempt, options.probe));
  if (live) return { kind: "running", attempt: live };
  if (attempts.at(-1)?.outcome !== "completed" || options.fromStage) return undefined;
  const stages = [...records.values()].sort((a, b) => a.started.localeCompare(b.started));
  return { kind: "completed", stages };
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
  fields: Pick<AttemptRecord, "file" | "workflowVersion" | "flags">,
  options: {
    now?: Date;
    pid?: number;
    probe?: ProcessProbe;
    /** `--from-stage`: a run that completed is continued only to redo a stage of it. */
    fromStage?: boolean;
  } = {},
): Promise<{ attempt: Attempt; interrupted: AttemptRecord[] } | { refused: AttemptRefusal }> {
  const probe = options.probe ?? processStart;
  const pid = options.pid ?? process.pid;
  const started = probe(pid);
  if (started === undefined) {
    throw new Error(`ps -o lstart= gave no start time for this process (${pid})`);
  }
  const dir = attemptsDir(run.dir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await sweep(dir);
  const earlier = await readAttempts(run);
  let n = (earlier.at(-1)?.attempt ?? 0) + 1;
  for (;;) {
    const record: AttemptRecord = {
      version: ATTEMPT_RECORD_VERSION,
      attempt: n,
      file: fields.file,
      ...(fields.workflowVersion === undefined ? {} : { workflowVersion: fields.workflowVersion }),
      flags: fields.flags,
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
        const before = (await readAttempts(run)).filter((other) => other.attempt < n);
        const refused = attemptRefusal(before, await readStageRecords(run.dir), {
          fromStage: options.fromStage ?? false,
          probe,
        });
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

/** Writes the attempt's ending into its file, whole. */
export async function endAttempt(
  attempt: Attempt,
  ending: Pick<AttemptRecord, "stage" | "reason" | "stages" | "accounting" | "unacknowledged"> & {
    outcome: AttemptOutcome;
  },
  now: Date = new Date(),
): Promise<AttemptRecord> {
  const { stage, reason, stages, accounting, unacknowledged } = ending;
  const record: AttemptRecord = {
    ...attempt.record,
    ended: now.toISOString(),
    outcome: ending.outcome,
    ...(stage === undefined ? {} : { stage }),
    ...(reason === undefined ? {} : { reason }),
    ...(stages === undefined ? {} : { stages }),
    ...(accounting === undefined ? {} : { accounting }),
    ...(unacknowledged === undefined ? {} : { unacknowledged }),
  };
  await writeJson(attempt.file, record);
  attempt.record = record;
  return record;
}

/** Writes a stage's record into the run's `stages/`, whole, replacing the one before. */
export async function writeStageRecord(runDir: string, record: StageRecord): Promise<void> {
  const dir = stagesDir(runDir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeJson(join(dir, `${record.stage}.json`), record);
}

/** The run's current stage records, by stage. One that doesn't parse, or is newer, refuses. */
export async function readStageRecords(runDir: string): Promise<Map<string, StageRecord>> {
  const dir = stagesDir(runDir);
  const names = (await entries(dir)).filter((name) => name.endsWith(".json"));
  const records = await Promise.all(
    names.map((name) => readRecord<StageRecord>(join(dir, name), STAGE_RECORD_VERSION)),
  );
  return new Map(records.map((record) => [record.stage, record]));
}

/**
 * At an attempt's start point: moves every record in `stages/` it hasn't reused to `replaced/`, as
 * `{stage}.{attempt}.json`, the start stage's own first. Each is one rename, so a crash part way
 * leaves the start stage without a record, and the next continue starts there and moves the rest.
 */
export async function replaceStale(
  runDir: string,
  start: string,
  reused: ReadonlySet<string>,
): Promise<string[]> {
  const dir = stagesDir(runDir);
  const recorded = (await entries(dir))
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length));
  const stale = [start, ...recorded.filter((name) => name !== start)].filter(
    (name) => recorded.includes(name) && !reused.has(name),
  );
  for (const name of stale) await replaceRecord(runDir, name);
  return stale;
}

/**
 * Moves a stage's record, unchanged, to `replaced/{stage}.{attempt}.json`, or, for a stage by
 * content replaced again in the same attempt, `{stage}.{attempt}+{n}.json` from 2: no name has a
 * `+`, so neither reads as another stage's.
 */
export async function replaceRecord(runDir: string, stage: string): Promise<void> {
  const file = join(stagesDir(runDir), `${stage}.json`);
  const record = await readRecord<StageRecord>(file, STAGE_RECORD_VERSION);
  const replaced = join(runDir, "replaced");
  await mkdir(replaced, { recursive: true, mode: 0o700 });
  let target = join(replaced, `${stage}.${record.attempt}.json`);
  for (let n = 2; await exists(target); n++) {
    target = join(replaced, `${stage}.${record.attempt}+${n}.json`);
  }
  await rename(file, target);
}

/** Appends a line to the run's event log, `turns.jsonl`, which only the live attempt writes. */
export async function appendEvent(runDir: string, line: RunLogLine): Promise<void> {
  await appendLine(turnsFile(runDir), JSON.stringify(line));
}

/** Ends a line a crash left torn, so the next line appended starts a line of its own. */
export async function endTurnsLine(runDir: string): Promise<void> {
  await endTornLine(turnsFile(runDir));
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
    const file = await open(turnsFile(runDir), "r");
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
  return (await stat(turnsFile(runDir)).catch(() => undefined))?.size ?? 0;
}

async function attemptNames(run: Run): Promise<string[]> {
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

/** The last ended attempt's `output.json`. */
export function outputFile(runDir: string): string {
  return join(runDir, "output.json");
}

/** The last ended attempt's `report.md`. */
export function reportFile(runDir: string): string {
  return join(runDir, "report.md");
}

/** Writes an operation's call, whole, before its result slot opens. */
export async function writeCall(runDir: string, spec: CallSpec): Promise<void> {
  const dir = callDir(runDir, spec.callId);
  await mkdir(dir, { recursive: true });
  await writeJson(join(dir, "call.json"), spec);
}

export async function recordCandidate(
  runDir: string,
  callId: string,
  candidate: Candidate,
): Promise<void> {
  const dir = callDir(runDir, callId);
  await mkdir(dir, { recursive: true });
  await appendLine(join(dir, "candidates.jsonl"), JSON.stringify(candidate));
}

/** A call's candidates, as tests check them; a run never reads them back. */
export async function readCandidates(runDir: string, callId: string): Promise<Candidate[]> {
  return readLines<Candidate>(join(callDir(runDir, callId), "candidates.jsonl"));
}

/** Claims an operation's one accepted result with `value`; false when another holds it. */
export async function writeAcceptedExclusive(
  runDir: string,
  callId: string,
  value: unknown,
): Promise<boolean> {
  const dir = callDir(runDir, callId);
  await mkdir(dir, { recursive: true });
  return linkNew(join(dir, "result.json"), { value, at: new Date().toISOString() });
}

/** Null distinguishes "no value yet" from a call whose accepted value happens to be null. */
export async function readAccepted(
  runDir: string,
  callId: string,
): Promise<{ value: unknown } | null> {
  let text: string;
  try {
    text = await readFile(join(callDir(runDir, callId), "result.json"), "utf8");
  } catch (error) {
    if (isCode(error, "ENOENT")) return null;
    throw error;
  }
  const { value } = JSON.parse(text) as { value: unknown };
  return { value };
}

function runFile(runDir: string): string {
  return join(runDir, "run.json");
}

function attemptsDir(runDir: string): string {
  return join(runDir, "attempts");
}

function stagesDir(runDir: string): string {
  return join(runDir, "stages");
}

function turnsFile(runDir: string): string {
  return join(runDir, "turns.jsonl");
}

function callDir(runDir: string, callId: string): string {
  return join(runDir, "calls", callId);
}

async function readRecord<T extends { version: number }>(file: string, known: number): Promise<T>;
async function readRecord<T extends { version: number }>(
  file: string,
  known: number,
  options: { missing: true },
): Promise<T | undefined>;
async function readRecord<T extends { version: number }>(
  file: string,
  known: number,
  options: { missing?: true } = {},
): Promise<T | undefined> {
  let record: T;
  try {
    record = JSON.parse(await readFile(file, "utf8")) as T;
  } catch (error) {
    if (options.missing && isCode(error, "ENOENT")) return undefined;
    throw new RunRefused(`${file} could not be read: ${(error as Error).message}`);
  }
  if (typeof record?.version !== "number") throw new RunRefused(`${file} has no version`);
  if (record.version > known) {
    throw new RunRefused(`${file} is version ${record.version}, newer than this awf reads`);
  }
  return record;
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
 * Waits until the attempt before `n`, a parked one closing its agents or one that crashed with
 * its process left, is gone; past five minutes, cancels it, then kills it if it ignores that.
 * Its agents' sessions are then this attempt's.
 */
export async function previousGone(
  run: Run,
  n: number,
  notice: (text: string) => void,
): Promise<void> {
  const previous = (await readAttempts(run)).find((each) => each.attempt === n - 1);
  if (!previous) return;
  const alive = () => sameProcess(previous.pid, previous.processStart, processStart);
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
          process.kill(previous.pid, name);
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
