import { randomBytes } from "node:crypto";
import { link, mkdir, open, readdir, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  ATTEMPT_RECORD_VERSION,
  type AttemptOutcome,
  type AttemptRecord,
  RUN_RECORD_VERSION,
  type RunRecord,
  STAGE_RECORD_VERSION,
  type StageRecord,
  type TurnRecord,
} from "@agentswf/contract/records";
import { appendLine } from "./jsonl";

/**
 * Runs on disk: `{root}/{workflow}/{id}/`, holding `run.json`, `attempts/{n}.json`,
 * `stages/{stage}.json`, `replaced/{stage}.{attempt}.json` and `turns.jsonl`. The only
 * module that knows the layout. Only the live attempt writes, and the two claims, a run's folder
 * renamed into place and an attempt's file linked into place, are the only locks.
 */

/** Where a project's runs are kept, unless `--run-root` says otherwise. */
export function runRootOf(cwd: string): string {
  return join(cwd, ".awf", "runs");
}

/**
 * What awf keeps per machine, under `~/.awf`, whatever a run's root: the marks of sessions runs
 * drive, and each sandbox's homes, kept outside the project, whose run root a provider denies.
 */
export function machinePaths(home: string): { root: string; callers: string; sandboxes: string } {
  const root = join(home, ".awf");
  return { root, callers: join(root, "callers"), sandboxes: join(root, "sandboxes") };
}

/** Where a run's sandboxes keep their homes: found by the run, though outside it. */
export function sandboxesOf(home: string, run: Run): string {
  return join(machinePaths(home).sandboxes, run.record.workflow, run.record.id);
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

const ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;

/** Why `id` can't name a run or a workflow, or undefined when it can. */
export function idProblem(id: string): string | undefined {
  return ID.test(id)
    ? undefined
    : `${JSON.stringify(id)} is not a valid id: letters, digits, '.', '_' and '-', up to 128, not starting with '.'`;
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
  const workflowProblem = idProblem(record.workflow);
  if (workflowProblem) throw new RunRefused(workflowProblem);
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
  const problem = idProblem(record.id);
  if (problem) throw new RunRefused(problem);
  const other = await takenInCase(parent, record.id);
  if (other !== undefined) throw new RunTaken(takenMessage(other));
  const full: RunRecord = { version: RUN_RECORD_VERSION, ...record, created: now.toISOString() };
  const pending = join(parent, `.new-${randomBytes(6).toString("hex")}`);
  await mkdir(pending, { mode: 0o700 });
  const dir = join(parent, record.id);
  try {
    await writeJson(join(pending, "run.json"), full);
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
  for (const name of [workflow, id]) {
    const problem = idProblem(name);
    if (problem) throw new RunRefused(problem);
  }
  const parent = join(root, workflow);
  const taken = (await exists(join(parent, id))) ? id : await takenInCase(parent, id);
  if (taken !== undefined) throw new RunRefused(takenMessage(taken));
}

/**
 * Removes a run this process created whose first attempt was never claimed, so a refusal leaves
 * nothing behind and the id is free again.
 */
export async function discardRun(run: Run): Promise<void> {
  if ((await entries(join(run.dir, "attempts"))).length > 0) return;
  await rm(run.dir, { recursive: true, force: true });
}

/** The run `id` of `workflow`, naming the workflow it is under when it is another's. */
export async function openRun(root: string, workflow: string, id: string): Promise<Run> {
  for (const name of [workflow, id]) {
    const problem = idProblem(name);
    if (problem) throw new RunRefused(problem);
  }
  const dir = join(root, workflow, id);
  const file = join(dir, "run.json");
  if (!(await exists(file))) {
    for (const other of await entries(root)) {
      if (other !== workflow && (await exists(join(root, other, id, "run.json")))) {
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
  const dir = join(run.dir, "attempts");
  const numbered = (await entries(dir)).filter((name) => /^[1-9]\d*\.json$/.test(name));
  const records = await Promise.all(
    numbered.map((name) =>
      readRecord<AttemptRecord>(join(dir, name), ATTEMPT_RECORD_VERSION, { missing: true }),
    ),
  );
  return records.filter((record) => record !== undefined).sort((a, b) => a.n - b.n);
}

export type RunStatus = "running" | AttemptOutcome | "interrupted";

/** The highest attempt's: live, ended, or neither, which is interrupted. */
export function runStatus(
  attempts: readonly AttemptRecord[],
  probe: ProcessProbe = processStart,
): RunStatus {
  const last = attempts.at(-1);
  if (!last) return "interrupted";
  if (isLive(last, probe)) return "running";
  return last.outcome ?? "interrupted";
}

/**
 * No ending, and its process still the one that started it. A second apart is the same start: on
 * Linux `ps` derives it from the boot time, which a clock step can move.
 */
export function isLive(attempt: AttemptRecord, probe: ProcessProbe = processStart): boolean {
  if (attempt.ended !== undefined) return false;
  const started = probe(attempt.pid);
  if (started === undefined) return false;
  return Math.abs(Date.parse(started) - Date.parse(attempt.processStart)) <= 1_000;
}

/**
 * Claims the next attempt by linking its file into place, which fails when the name exists, so a
 * failed link tries the next number. Having claimed `n`, it reads attempts `1 … n-1`: one still
 * live refuses it, and its own file goes, as it does when the last of them completed the run. Of
 * two racing attempts the later always sees the earlier, since it could only pick a higher number
 * once the earlier file existed.
 */
export async function claimAttempt(
  run: Run,
  fields: Pick<AttemptRecord, "file" | "workflowVersion" | "flags">,
  options: {
    now?: Date;
    pid?: number;
    probe?: ProcessProbe;
    /** A run that completed is continued only to redo a stage of it. */
    redo?: boolean;
  } = {},
): Promise<{ attempt: Attempt; interrupted: AttemptRecord[] }> {
  const probe = options.probe ?? processStart;
  const pid = options.pid ?? process.pid;
  const started = probe(pid);
  if (started === undefined) {
    throw new Error(`ps -o lstart= gave no start time for this process (${pid})`);
  }
  const dir = join(run.dir, "attempts");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await sweep(dir);
  const earlier = await readAttempts(run);
  let n = (earlier.at(-1)?.n ?? 0) + 1;
  for (;;) {
    const record: AttemptRecord = {
      version: ATTEMPT_RECORD_VERSION,
      n,
      file: fields.file,
      ...(fields.workflowVersion === undefined ? {} : { workflowVersion: fields.workflowVersion }),
      flags: fields.flags,
      pid,
      processStart: started,
      started: (options.now ?? new Date()).toISOString(),
    };
    const file = join(dir, `${n}.json`);
    if (await linkNew(file, record)) {
      const before = (await readAttempts(run)).filter((other) => other.n < n);
      const live = before.find((other) => isLive(other, probe));
      if (live) {
        await unlink(file);
        throw new RunRefused(
          `attempt ${live.n} of ${run.record.id} is still running, as process ${live.pid}`,
        );
      }
      if (before.at(-1)?.outcome === "completed" && !options.redo) {
        await unlink(file);
        throw new RunRefused(`${run.record.id} completed; --from-stage redoes one of its stages`);
      }
      const interrupted = before.filter((other) => other.ended === undefined);
      return { attempt: { run, file, record }, interrupted };
    }
    n += 1;
  }
}

/** Writes the attempt's ending into its file, whole. */
export async function endAttempt(
  attempt: Attempt,
  ending: { outcome: AttemptOutcome; reason?: string; stage?: string },
  now: Date = new Date(),
): Promise<AttemptRecord> {
  const record: AttemptRecord = {
    ...attempt.record,
    ended: now.toISOString(),
    outcome: ending.outcome,
    ...(ending.stage === undefined ? {} : { stage: ending.stage }),
    ...(ending.reason === undefined ? {} : { reason: ending.reason }),
  };
  await writeJson(attempt.file, record);
  attempt.record = record;
  return record;
}

/** Writes a stage's record into the run's `stages/`, whole, replacing the one before. */
export async function writeStageRecord(runDir: string, record: StageRecord): Promise<void> {
  const dir = join(runDir, "stages");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeJson(join(dir, `${record.stage}.json`), record);
}

/** The run's current stage records, by stage. One that doesn't parse, or is newer, refuses. */
export async function readStageRecords(runDir: string): Promise<Map<string, StageRecord>> {
  const dir = join(runDir, "stages");
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
  const dir = join(runDir, "stages");
  const recorded = (await entries(dir))
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length));
  const stale = [start, ...recorded.filter((name) => name !== start)].filter(
    (name) => recorded.includes(name) && !reused.has(name),
  );
  if (stale.length === 0) return [];
  const replaced = join(runDir, "replaced");
  await mkdir(replaced, { recursive: true, mode: 0o700 });
  for (const name of stale) {
    const file = join(dir, `${name}.json`);
    const record = await readRecord<StageRecord>(file, STAGE_RECORD_VERSION);
    await rename(file, join(replaced, `${name}.${record.attempt}.json`));
  }
  return stale;
}

/** Appends a settled turn to the run's `turns.jsonl`, which only the live attempt writes. */
export async function appendTurn(runDir: string, record: TurnRecord): Promise<void> {
  await appendLine(join(runDir, "turns.jsonl"), JSON.stringify(record));
}

/** Ends a line a crash left torn, so the next turn appended starts a line of its own. */
export async function endTurnsLine(runDir: string): Promise<void> {
  const file = join(runDir, "turns.jsonl");
  const handle = await open(file, "r").catch((error) => {
    if (isCode(error, "ENOENT")) return undefined;
    throw error;
  });
  if (!handle) return;
  let torn: boolean;
  try {
    const { size } = await handle.stat();
    const last = Buffer.alloc(1);
    torn = size > 0 && (await handle.read(last, 0, 1, size - 1)).bytesRead === 1 && last[0] !== 10;
  } finally {
    await handle.close();
  }
  if (torn) await appendLine(file, "");
}

/**
 * Every turn of the run, in the order they settled. A line that doesn't parse is skipped wherever
 * it is: a crash can tear the last one, and the next attempt appends after it.
 */
export async function readTurns(runDir: string): Promise<TurnRecord[]> {
  const text = await readFile(join(runDir, "turns.jsonl"), "utf8").catch((error) => {
    if (isCode(error, "ENOENT")) return "";
    throw error;
  });
  return text.split("\n").flatMap((line) => {
    try {
      const record = JSON.parse(line) as TurnRecord;
      return typeof record === "object" && record !== null ? [record] : [];
    } catch {
      return [];
    }
  });
}

/**
 * Writes `value` to `path` whole: a temp file beside it, synced, then renamed into place. A crash
 * leaves the old file or the new one, never half of either.
 */
export async function writeJson(path: string, value: object): Promise<void> {
  await writeWhole(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** As `writeJson`, for text. */
export async function writeWhole(path: string, text: string): Promise<void> {
  const temporary = join(dirname(path), `.tmp-${randomBytes(6).toString("hex")}`);
  try {
    await writeSynced(temporary, text);
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

/** Links a complete file holding `value` to `path`; false when `path` exists. */
async function linkNew(path: string, value: object): Promise<boolean> {
  const temporary = join(dirname(path), `.tmp-${randomBytes(6).toString("hex")}`);
  try {
    await writeSynced(temporary, `${JSON.stringify(value, null, 2)}\n`);
    await link(temporary, path);
    return true;
  } catch (error) {
    if (isCode(error, "EEXIST")) return false;
    throw error;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function writeSynced(path: string, text: string): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
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

/** A folder's entries, without hidden ones: temp files, `.gitignore`. */
async function entries(dir: string): Promise<string[]> {
  const names = await readdir(dir).catch((error) => {
    if (isCode(error, "ENOENT")) return [] as string[];
    throw error;
  });
  return names.filter((name) => !name.startsWith(".")).sort();
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

function isCode(error: unknown, ...codes: string[]): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    codes.includes(String((error as { code: unknown }).code))
  );
}

/**
 * `ps -o lstart=` in UTC, as an ISO time to the second: the same on macOS and Linux, and whatever
 * time zone the attempt that wrote it and the one checking it each run in.
 */
export function processStart(pid: number): string | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  const done = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], {
    stdout: "pipe",
    stderr: "ignore",
    env: { ...process.env, LC_ALL: "C", TZ: "UTC0" },
  });
  const text = done.stdout.toString().trim();
  if (!done.success || text === "") return undefined;
  const time = new Date(`${text} UTC`);
  return Number.isNaN(time.getTime()) ? undefined : time.toISOString().replace(/\.\d{3}Z$/, "Z");
}
