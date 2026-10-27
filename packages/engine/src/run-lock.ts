import { mkdir, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isCode, linkNew } from "./files";
import { probeProcess, processStart, sameStart } from "./runs";

/**
 * `{root}/{workflow}/{run id}.lock`: the lock on a run, beside its run's folder so it exists before
 * the run does. Every append to the run's mailbox, and each decision made from it, holds it.
 */
export function runLockFile(runRoot: string, workflow: string, runId: string): string {
  return join(runRoot, workflow, `${runId}.lock`);
}

type Holder = { pid: number; processStart: string; at: string };

let own: string | undefined;
/** This process's start, asked of `ps` once. */
function ownStart(): string | undefined {
  own ??= processStart(process.pid);
  return own;
}

/** Callers in this process queue for a lock here before any of them links the file. */
const queues = new Map<string, Promise<void>>();

/** How long a caller tries before it gives up: a holder that never lets go is gone or wedged. */
const GIVE_UP_MILLISECONDS = 120_000;

/**
 * Runs `work` holding the run's lock: claimed by linking its file into place, which fails while
 * another holds it, and taken over when the process that holds it is gone. Callers in one process
 * take it in turn. A lock is not reentrant: `work` that takes the same lock again waits on itself.
 */
export async function withRunLock<T>(file: string, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(file) ?? Promise.resolve();
  const turn = Promise.withResolvers<void>();
  const mine = previous.then(() => turn.promise);
  queues.set(file, mine);
  try {
    await previous;
    const held = await claim(file);
    try {
      return await work();
    } finally {
      // Ours to remove only while it is still ours: one taken over meanwhile is its taker's.
      if (JSON.stringify(await readHolder(file)) === JSON.stringify(held))
        await unlink(file).catch(() => undefined);
    }
  } finally {
    turn.resolve();
    if (queues.get(file) === mine) queues.delete(file);
  }
}

async function claim(file: string): Promise<Holder> {
  const started = ownStart();
  if (started === undefined) throw new Error(`no start time for this process (${process.pid})`);
  const mine: Holder = { pid: process.pid, processStart: started, at: new Date().toISOString() };
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const giveUp = Date.now() + GIVE_UP_MILLISECONDS;
  let wait = 5;
  let lastLook = 0;
  for (;;) {
    if (await linkNew(file, mine)) return mine;
    // Asking `ps` costs a process: whether the holder is gone is asked now and then, not each try.
    if (Date.now() - lastLook > 250) {
      lastLook = Date.now();
      const holder = await readHolder(file);
      if (holder === "gone") continue;
      if (!holder || gone(holder)) {
        await takeOver(file, holder);
        continue;
      }
    }
    if (Date.now() > giveUp)
      throw new Error(`${file} is still held after ${GIVE_UP_MILLISECONDS / 1000} s`);
    await Bun.sleep(wait);
    wait = Math.min(wait * 2, 100);
  }
}

/**
 * Whether a holder's process is gone. Where `ps` can't be asked, it is taken as alive: taking a
 * live holder's lock over would let two writers in.
 */
function gone(holder: Holder): boolean {
  const now = probeProcess(holder.pid);
  if (now === "unknown") return false;
  return now === "gone" || !sameStart(now, holder.processStart);
}

/** The holder as its file says, `gone` when the file went meanwhile, undefined when it is torn. */
async function readHolder(file: string): Promise<Holder | "gone" | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (isCode(error, "ENOENT")) return "gone";
    throw error;
  }
  try {
    const value = JSON.parse(text) as Partial<Holder>;
    return typeof value.pid === "number" && typeof value.processStart === "string"
      ? (value as Holder)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Removes a lock its holder left behind, if it is still the one read: another taker may have
 * replaced it since. The window between the second read and the unlink is the one race left; a
 * holder that died is rare, and two takers at that instant rarer.
 */
async function takeOver(file: string, stale: Holder | undefined): Promise<void> {
  const now = await readHolder(file);
  if (now === "gone") return;
  if (JSON.stringify(now) !== JSON.stringify(stale)) return;
  await unlink(file).catch((error: unknown) => {
    if (!isCode(error, "ENOENT")) throw error;
  });
}
