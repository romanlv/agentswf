import { mkdirSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type Candidate,
  isKnownOpFile,
  OP_FILE_VERSIONS,
  type OpFile,
  type OpRecord,
  type ResultRecord,
} from "@agentswf/contract/records";
import { nameProblem } from "@agentswf/contract/workflow";
import { messageOf } from "./errors";
import { isCode, linkNew, writeWholeSync } from "./files";
import { appendLine, readLines } from "./jsonl";

/**
 * A run's `ops/`: one folder per operation, `ops/{key}.{n}/`, the `n`th turn, message operation or
 * compaction of the agent keyed `{key}`, or the `n`th asking of the decision keyed `{key}`. It holds
 * `op.json`, `answers.jsonl`, `result.json`, `decision.json`, `spend.json`, `live.jsonl` and
 * `screen.txt`. The only module that knows where they are.
 */

/** An operation's folder. */
function opDir(runDir: string, op: string): string {
  return join(runDir, "ops", op);
}

/** What the operation is: `OpRecord`. */
export function opFile(runDir: string, op: string): string {
  return join(opDir(runDir, op), "op.json");
}

/** Its settled usage: billing, spend per model, reported cost. */
export function spendFile(runDir: string, op: string): string {
  return join(opDir(runDir, op), "spend.json");
}

/** Its delivery and nudge diagnostics, `OperationLivenessRecord` lines. */
export function liveFile(runDir: string, op: string): string {
  return join(opDir(runDir, op), "live.jsonl");
}

/** A decision's `DecisionArtifact`, relative to the run's folder, as `DecisionRecord.artifact` names it. */
export function decisionArtifact(op: string): string {
  return join("ops", op, "decision.json");
}

/**
 * The keys earlier attempts numbered operations under: each one's last `n`, and whose it is when its
 * `op.json` says.
 */
export type EarlierOps = ReadonlyMap<string, { last: number; of?: "agent" | "decision" }>;

/**
 * Lists `ops/` once, as an attempt claims its run: `n` is the digits after a folder's last `.`.
 * Whose a key is is read from its highest-numbered `op.json` that can be read.
 */
export async function listOps(runDir: string): Promise<EarlierOps> {
  let names: string[];
  try {
    names = await readdir(join(runDir, "ops"));
  } catch (error) {
    if (isCode(error, "ENOENT")) return new Map();
    throw error;
  }
  const numbers = new Map<string, number[]>();
  for (const name of names) {
    const match = /^(.+)\.(\d+)$/.exec(name);
    if (!match) continue;
    const list = numbers.get(match[1]!) ?? [];
    list.push(Number(match[2]));
    numbers.set(match[1]!, list);
  }
  const earlier = new Map<string, { last: number; of?: "agent" | "decision" }>();
  await Promise.all(
    [...numbers].map(async ([key, list]) => {
      const descending = list.sort((a, b) => b - a);
      let kind: OpRecord["kind"] | undefined;
      for (const n of descending) {
        kind = (await readOpFile<OpRecord>(opFile(runDir, `${key}.${n}`), "op"))?.kind;
        if (kind !== undefined) break;
      }
      earlier.set(key, {
        last: descending[0]!,
        ...(kind === undefined ? {} : { of: kind === "decision" ? "decision" : "agent" }),
      });
    }),
  );
  return earlier;
}

/**
 * Why `key` can't be an agent's or a decision's: it names folders, so it is a name, as an event's
 * or stage's is, and has no colon, which awf's own event names, `{key}:ended`, split at.
 */
function keyProblem(key: string): string | undefined {
  if (key.includes(":"))
    return `a colon is kept for awf's own event names, such as {key}:ended; take another key, such as ${key.replaceAll(":", "-")}`;
  return nameProblem(key);
}

/**
 * An attempt's operation ids, `{key}.{n}`, numbered on from the last `n` its claim listed, so no
 * id is reused across attempts. Agents and decisions share the keys: `{key}.{n}` is one operation.
 */
export class OpIds {
  readonly #last = new Map<string, number>();
  readonly #agents = new Set<string>();
  readonly #decisions = new Set<string>();

  constructor(
    readonly runDir: string,
    readonly attempt: number,
    earlier: EarlierOps,
  ) {
    for (const [key, { last, of }] of earlier) {
      this.#last.set(key, last);
      if (of) (of === "decision" ? this.#decisions : this.#agents).add(key);
    }
  }

  /** Refuses a key that isn't a name, or that the other kind already holds in the run. */
  claim(key: string, as: "agent" | "decision"): void {
    const problem = keyProblem(key);
    if (problem) throw new Error(`${as} key ${key} is not a name: ${problem}`);
    const [mine, other] =
      as === "agent" ? [this.#agents, this.#decisions] : [this.#decisions, this.#agents];
    if (other.has(key))
      throw new Error(
        `${key} is ${as === "agent" ? "a decision's" : "an agent's"} key: agents and decisions share one set of names, as each operation's folder is ops/{key}.{n}; ${as === "agent" ? "an agent" : "a decision"} takes another key`,
      );
    mine.add(key);
  }

  /**
   * The key's next operation id, its folder and `op.json` written at once, before any line names it,
   * so a later claim numbers past it however the operation ends. Synchronous, so nothing waits
   * between an operation's start and its cancellation being registered. `lost` says why `op.json`
   * wasn't written, which fails the operation.
   */
  draw(key: string, what: OpStart): { id: string; lost?: string } {
    const n = (this.#last.get(key) ?? 0) + 1;
    this.#last.set(key, n);
    const id = `${key}.${n}`;
    const record = {
      version: OP_FILE_VERSIONS.op,
      id,
      attempt: this.attempt,
      at: new Date().toISOString(),
      ...what,
    } as OpRecord;
    try {
      mkdirSync(opDir(this.runDir, id), { recursive: true });
      writeWholeSync(opFile(this.runDir, id), `${JSON.stringify(record, null, 2)}\n`);
      return { id };
    } catch (error) {
      return { id, lost: `op.json not written: ${messageOf(error)}` };
    }
  }
}

/** What an operation is, as it is drawn: its `op.json` but its version, id, attempt and time. */
type OpStart = OpRecord extends infer Each
  ? Each extends OpRecord
    ? Omit<Each, "version" | "id" | "attempt" | "at">
    : never
  : never;

/** Appends an answer offered, accepted or not, to its operation's `answers.jsonl`. */
export async function recordAnswer(runDir: string, op: string, answer: Candidate): Promise<void> {
  await mkdir(opDir(runDir, op), { recursive: true });
  await appendLine(answersFile(runDir, op), JSON.stringify(answer));
}

/** An operation's answers, as tests check them; a run never reads them back. */
export async function readAnswers(runDir: string, op: string): Promise<Candidate[]> {
  return readLines<Candidate>(answersFile(runDir, op));
}

/** Claims an operation's one accepted result with `value`; false when another holds it. */
export async function writeAcceptedExclusive(
  runDir: string,
  op: string,
  value: unknown,
): Promise<boolean> {
  await mkdir(opDir(runDir, op), { recursive: true });
  const record = {
    version: OP_FILE_VERSIONS.result,
    value,
    at: new Date().toISOString(),
  } as ResultRecord;
  return linkNew(join(opDir(runDir, op), "result.json"), record);
}

/**
 * An operation's accepted result, as tests check it; a run never reads it back. Null
 * distinguishes "no value yet" from an operation whose accepted value happens to be null. A
 * result.json of another version throws: unlike a cost, an answer has no unknown to fall back on.
 */
export async function readAccepted(runDir: string, op: string): Promise<{ value: unknown } | null> {
  let text: string;
  try {
    text = await readFile(join(opDir(runDir, op), "result.json"), "utf8");
  } catch (error) {
    if (isCode(error, "ENOENT")) return null;
    throw error;
  }
  const record: unknown = JSON.parse(text);
  if (!isKnownOpFile("result", record))
    throw new Error(`${op}'s result.json is not version ${OP_FILE_VERSIONS.result}`);
  return { value: (record as ResultRecord).value };
}

/**
 * An operation's JSON `file` at `path`, or undefined when it is missing, can't be parsed, or has no
 * version or one this reader doesn't know: each is read as a file that isn't there. With `refuse`,
 * a file that parses at another version throws instead, for a reader whose figures it would
 * otherwise leave looking complete.
 */
export async function readOpFile<T>(
  path: string,
  file: OpFile,
  options: { refuse?: boolean } = {},
): Promise<T | undefined> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
  if (isKnownOpFile(file, value)) return value as T;
  if (options.refuse && typeof value === "object" && value !== null) {
    const version = (value as { version?: unknown }).version;
    throw new Error(
      `${path} is ${version === undefined ? "of no version" : `version ${JSON.stringify(version)}`}; this awf reads version ${OP_FILE_VERSIONS[file]}`,
    );
  }
  return undefined;
}

/** The most of a screen kept: its last lines, where a pane's scrollback came with it. */
const SCREEN_BYTES = 64 * 1024;

/** An operation's `screen.txt`: what its pane showed as it ended without an answer. */
export function screenFile(runDir: string, op: string): string {
  return join(opDir(runDir, op), "screen.txt");
}

export async function writeScreen(runDir: string, op: string, screen: string): Promise<void> {
  const bytes = Buffer.from(screen);
  const kept = bytes.length <= SCREEN_BYTES ? screen : tailOf(bytes);
  await mkdir(opDir(runDir, op), { recursive: true });
  await writeFile(screenFile(runDir, op), kept, { mode: 0o600 });
}

/** Its last whole lines within the bound, or its last bytes where one line is longer. */
function tailOf(bytes: Buffer): string {
  const tail = bytes.subarray(bytes.length - SCREEN_BYTES);
  const line = tail.indexOf(10);
  const whole = line === -1 || line === tail.length - 1 ? tail : tail.subarray(line + 1);
  // A cut inside a character drops its continuation bytes.
  let start = 0;
  while (start < whole.length && (whole[start]! & 0xc0) === 0x80) start += 1;
  return whole.subarray(start).toString();
}

function answersFile(runDir: string, op: string): string {
  return join(opDir(runDir, op), "answers.jsonl");
}
