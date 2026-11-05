#!/usr/bin/env bun
/**
 * Moves runs made before `run.json` had a `format` to format 1 (story 041's layout), so `awf runs`
 * reads them again and a parked event run takes its next event. Not part of awf: the record's
 * readers never read the old layout.
 *
 *   bun scripts/migrate-runs.ts [--dry-run] [dir…]
 *
 * Each dir, the current one by default, is searched for `.awf/runs/{workflow}/{id}/` folders whose
 * `run.json` has no `format`. What converts:
 *
 * - `run.json` gets `format: 1` and loses `version`;
 * - `mailbox.jsonl`'s events are `in.jsonl`, except the ones awf derived (`timer:due`, `at:due`,
 *   `agent:ended`), which are now what a `took` or `turn-ended` line says;
 * - its wait, took, timer and turn lines, `stages/`, and the sessions `turns.jsonl` names are
 *   `run.jsonl`, each attempt's after its `claimed`; a wait acknowledges what the `took` before it
 *   held, as the mailbox's rule had it;
 * - `attempts/{n}.json` lose `version`, `stages`, `accounting` and `unacknowledged`, and a completed
 *   one gets its `value` from `output.json`;
 * - `output.json` is `out.json`, `turns.jsonl` is `log.jsonl`, and `agents/`, `staging/`, `forks/`
 *   and `skills/` move under `work/`.
 *
 * What doesn't: `calls/` and `decisions/` (no `ops/`, so `awf logs` shows less and an unsettled
 * spend stays unread), `replaced/` (earlier records of stages a `--from-stage` reran), a
 * `launch-failed` line, and `process.log`. Every file the run had before is kept under
 * `pre-format/`. A run with an attempt that may still be running is skipped.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  type EventLine,
  RUN_FORMAT,
  type RunLine,
  type Taken,
} from "../packages/contract/src/records";
import { readRun } from "../packages/contract/src/run-lines";

type Json = Record<string, unknown>;
type Line = RunLine & { seq: number };

const ARCHIVE = "pre-format";
/** Files and folders the old layout had, moved to `pre-format/` once the new ones are written. */
const OLD = [
  "mailbox.jsonl",
  "turns.jsonl",
  "output.json",
  "stages",
  "replaced",
  "calls",
  "decisions",
  "process.log",
];
const WORK = ["agents", "staging", "forks", "skills"];

const hash = (text: string) =>
  new Bun.CryptoHasher("sha256").update(text).digest("hex").slice(0, 16);
const timerId = (name: string) => `awf.timer.${hash(name)}`;
const endId = (agent: string, turn: string, attempt: number) =>
  `awf.end.${hash(`${agent}\0${turn}\0${attempt}`)}`;

async function readJson(path: string): Promise<Json | undefined> {
  if (!existsSync(path)) return undefined;
  return JSON.parse(await readFile(path, "utf8")) as Json;
}

async function readJsonl(path: string): Promise<Json[]> {
  if (!existsSync(path)) return [];
  const lines: Json[] = [];
  for (const text of (await readFile(path, "utf8")).split("\n")) {
    if (text.trim() === "") continue;
    try {
      lines.push(JSON.parse(text) as Json);
    } catch {
      // A torn last line: the old readers skipped it too.
    }
  }
  return lines;
}

const jsonl = (lines: readonly object[]) =>
  lines.map((line) => `${JSON.stringify(line)}\n`).join("");

function without<T extends Json>(record: T, ...keys: string[]): Json {
  const copy: Json = { ...record };
  for (const key of keys) delete copy[key];
  return copy;
}

/** Whether the attempt's process is still the one it recorded: a pid alone may be reused. */
function alive(pid: unknown, processStart: unknown): boolean {
  if (typeof pid !== "number") return false;
  const ps = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], { env: { LC_ALL: "C" } });
  const started = ps.stdout.toString().trim();
  if (ps.exitCode !== 0 || started === "") return false;
  const at = new Date(started);
  if (Number.isNaN(at.getTime()) || typeof processStart !== "string") return true;
  return at.toISOString().slice(0, 19) === processStart.slice(0, 19);
}

/** Every run folder under `dir` whose `run.json` has no `format`. */
function findOldRuns(dir: string): string[] {
  const found: string[] = [];
  const walk = (at: string) => {
    let entries: string[];
    try {
      entries = readdirSync(at);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === "node_modules" || name === ".git") continue;
      const path = join(at, name);
      if (!statSync(path, { throwIfNoEntry: false })?.isDirectory()) continue;
      if (name === "runs" && at.endsWith(".awf")) {
        for (const workflow of readdirSync(path)) {
          const runs = join(path, workflow);
          if (!statSync(runs).isDirectory()) continue;
          for (const id of readdirSync(runs)) {
            const run = join(runs, id);
            if (id.startsWith(".") || !existsSync(join(run, "run.json"))) continue;
            found.push(run);
          }
        }
      } else walk(path);
    }
  };
  walk(dir);
  return found;
}

type Plan = {
  record: Json;
  events: EventLine[];
  lines: RunLine[];
  attempts: Map<string, Json>;
  dropped: string[];
};

async function plan(dir: string): Promise<Plan | string> {
  const record = (await readJson(join(dir, "run.json"))) as Json;
  if (record.format !== undefined) return "already has a format";

  const attemptFiles = existsSync(join(dir, "attempts"))
    ? readdirSync(join(dir, "attempts")).filter((name) => /^\d+\.json$/.test(name))
    : [];
  const attempts = new Map<number, Json>();
  for (const name of attemptFiles) {
    const attempt = (await readJson(join(dir, "attempts", name))) as Json;
    attempts.set(attempt.attempt as number, attempt);
  }
  for (const attempt of attempts.values()) {
    if (attempt.ended === undefined && alive(attempt.pid, attempt.processStart)) {
      return `attempt ${attempt.attempt} may still be running (pid ${attempt.pid})`;
    }
  }
  const output = await readJson(join(dir, "output.json"));
  const mailbox = await readJsonl(join(dir, "mailbox.jsonl"));
  const log = await readJsonl(join(dir, "turns.jsonl"));
  const dropped: string[] = [];

  const lines: Line[] = [];
  let seq = 0;
  const push = (line: RunLine) => lines.push({ ...line, seq: seq++ } as Line);

  // The mailbox: events to in.jsonl, the rest to run.jsonl.
  const derived = new Map<string, Json>();
  const events: EventLine[] = [];
  const timers = new Map<string, Json>();
  const turnLines: Json[] = [];
  let held: string[] | undefined;
  let lastAttempt = 1;
  const takenOf = (ids: string[]): Taken[] =>
    ids.map((id) => {
      const event = derived.get(id);
      if (event?.name === "timer:due") return { id, timer: event.from as string };
      if (event?.name === "at:due")
        return { id, branch: event.from as string, due: event.at as string };
      if (id.startsWith("awf.timer.")) {
        const name = [...timers.keys()].find((each) => timerId(each) === id);
        if (name !== undefined) return { id, timer: name };
      }
      return { id };
    });
  for (const line of mailbox) {
    const at = line.at as string;
    switch (line.kind) {
      case "event": {
        const name = line.name as string;
        if (name === "timer:due" || name === "at:due") {
          derived.set(line.id as string, line);
          break;
        }
        if (name === "agent:ended") {
          const agent = line.from as string;
          const data = line.data as { turn: string; outcome: { kind: string; answered?: boolean } };
          const began =
            turnLines.findLast(
              (turn) =>
                turn.agent === agent &&
                turn.turn === data.turn &&
                endId(agent, data.turn, turn.attempt as number) === line.id,
            )?.attempt ?? lastAttempt;
          const outcome =
            data.outcome.answered === undefined
              ? { ...data.outcome, answered: data.outcome.kind === "answered" }
              : data.outcome;
          push({
            kind: "turn-ended",
            attempt: Math.max(lastAttempt, began as number),
            at,
            id: line.id as string,
            agent,
            turn: data.turn,
            began: began as number,
            end: { ...data, outcome } as never,
          });
          break;
        }
        events.push(without(line, "version", "kind") as EventLine);
        break;
      }
      case "wait": {
        lastAttempt = line.attempt as number;
        const inLoop = line.stage === undefined && line.race === undefined;
        const acks = inLoop && !line.returns && held ? held : undefined;
        if (inLoop) held = undefined;
        push({
          ...(without(line, "version") as RunLine),
          ...(acks ? { acks } : {}),
        } as RunLine);
        break;
      }
      case "took": {
        lastAttempt = line.attempt as number;
        const ids = line.ids as string[];
        const took = takenOf(ids);
        if (line.race !== undefined) {
          push({
            kind: "race",
            attempt: lastAttempt,
            at,
            name: line.race as string,
            branch: (line.branch as string) ?? "",
            took,
          });
        } else {
          push({
            kind: "took",
            attempt: lastAttempt,
            at,
            took,
            ...(line.stage === undefined ? {} : { stage: line.stage as string }),
          });
          if (line.stage === undefined) held = ids.length > 0 ? ids : undefined;
        }
        break;
      }
      case "timer": {
        lastAttempt = line.attempt as number;
        if (!timers.has(line.name as string)) timers.set(line.name as string, line);
        push(without(line, "version") as RunLine);
        break;
      }
      case "timer-cancelled": {
        lastAttempt = line.attempt as number;
        const timer = timers.get(line.name as string);
        if (!timer) {
          dropped.push(`timer-cancelled for unknown timer ${line.name}`);
          break;
        }
        push({
          kind: "timer",
          attempt: lastAttempt,
          at,
          name: timer.name as string,
          due: timer.due as string,
          when: timer.when as string,
          cancelled: true,
        });
        break;
      }
      case "turn": {
        lastAttempt = line.attempt as number;
        turnLines.push(line);
        push({ ...without(line, "version", "kind"), kind: "turn-started" } as RunLine);
        break;
      }
      case "launch-failed":
        dropped.push(`a failed launch at ${at}`);
        break;
      default:
        dropped.push(`mailbox line of kind ${String(line.kind)}`);
    }
  }

  // The stages' current records.
  const stageDir = join(dir, "stages");
  if (existsSync(stageDir)) {
    for (const name of readdirSync(stageDir).filter((each) => each.endsWith(".json"))) {
      const stage = (await readJson(join(stageDir, name))) as Json;
      push({
        kind: "stage",
        attempt: stage.attempt as number,
        at: stage.ended as string,
        name: stage.stage as string,
        outcome: stage.outcome as never,
        started: stage.started as string,
        ...(stage.reason === undefined ? {} : { reason: stage.reason as string }),
        ...(stage.summary === undefined ? {} : { summary: stage.summary as string }),
        ...(stage.value === undefined ? {} : { value: stage.value as never }),
        ...(stage.provided ? { provided: true as const } : {}),
      });
    }
  }
  if (existsSync(join(dir, "replaced"))) dropped.push("replaced/, earlier records of rerun stages");

  // Sessions: each agent's, once per attempt, in the order the log first names them.
  const agentOf = new Map<string, string>();
  const homeOf = new Map<string, string>();
  const seen = new Set<string>();
  const session = (attempt: number, at: string, agent: string, ref: unknown) => {
    const { harness, id } = (ref ?? {}) as { harness?: string; id?: string };
    if (typeof harness !== "string" || typeof id !== "string") return;
    const key = `${attempt}\0${agent}\0${id}`;
    if (seen.has(key)) return;
    seen.add(key);
    const home = homeOf.get(agent);
    push({
      kind: "session",
      attempt,
      at,
      agent,
      harness,
      session: id,
      ...(home === undefined ? {} : { home }),
    });
  };
  for (const line of log) {
    const attempt = line.attempt as number;
    const at = (line.at ?? line.settledAt ?? line.deliveredAt) as string | undefined;
    if (at === undefined) continue;
    if (line.kind === "agent-opened" && typeof line.home === "string") {
      homeOf.set(line.agent as string, line.home);
    }
    if (typeof line.operationId === "string" && typeof line.agent === "string") {
      agentOf.set(line.operationId, line.agent);
    }
    if (Array.isArray(line.sessions) && typeof line.agent === "string") {
      for (const ref of line.sessions) session(attempt, at, line.agent, ref);
    }
    if (line.kind === "session-known") {
      const agent = (line.agent as string | undefined) ?? agentOf.get(line.operationId as string);
      if (agent !== undefined) session(attempt, at, agent, line.session);
    }
  }

  // Each attempt's lines after its claim, in time order, the attempts in order.
  const numbers = [...new Set([...attempts.keys(), ...lines.map((line) => line.attempt)])].sort(
    (a, b) => a - b,
  );
  const ordered: RunLine[] = [];
  for (const attempt of numbers) {
    const started = attempts.get(attempt)?.started as string | undefined;
    const own = lines
      .filter((line) => line.attempt === attempt)
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.seq - b.seq);
    const claimedAt = started ?? own[0]?.at;
    if (claimedAt === undefined) continue;
    ordered.push({ kind: "claimed", attempt, at: claimedAt });
    for (const { seq: _, ...line } of own) ordered.push(line as RunLine);
  }

  // The attempt files.
  const newAttempts = new Map<string, Json>();
  for (const [n, attempt] of attempts) {
    const next = without(attempt, "version", "stages", "accounting", "unacknowledged");
    next.kind = "attempt";
    if (
      attempt.outcome === "completed" &&
      output?.attempt === n &&
      output.outcome === "completed" &&
      output.value !== undefined
    ) {
      next.value = output.value;
    }
    newAttempts.set(`${n}.json`, {
      attempt: n,
      kind: "attempt",
      ...without(next, "attempt", "kind"),
    });
  }

  const nextRecord = { format: RUN_FORMAT, ...without(record, "version", "format") };
  return { record: nextRecord, events, lines: ordered, attempts: newAttempts, dropped };
}

async function migrate(dir: string, planned: Plan): Promise<void> {
  const archive = join(dir, ARCHIVE);
  await mkdir(join(archive, "attempts"), { recursive: true });
  const write = async (name: string, text: string) => {
    const path = join(dir, name);
    await writeFile(`${path}.migrating`, text);
    await rename(`${path}.migrating`, path);
  };
  await write("run.jsonl", jsonl(planned.lines));
  if (planned.events.length > 0 || planned.record.events === true) {
    await write("in.jsonl", jsonl(planned.events));
  }
  for (const [name, attempt] of planned.attempts) {
    const path = join(dir, "attempts", name);
    await writeFile(join(archive, "attempts", name), await readFile(path));
    await write(join("attempts", name), `${JSON.stringify(attempt, null, 2)}\n`);
  }
  if (existsSync(join(dir, "output.json"))) {
    await writeFile(join(dir, "out.json"), await readFile(join(dir, "output.json")));
  }
  if (existsSync(join(dir, "turns.jsonl"))) {
    await writeFile(join(dir, "log.jsonl"), await readFile(join(dir, "turns.jsonl")));
  }
  for (const name of WORK) {
    if (!existsSync(join(dir, name))) continue;
    await mkdir(join(dir, "work"), { recursive: true });
    await rename(join(dir, name), join(dir, "work", name));
  }
  for (const name of OLD) {
    if (existsSync(join(dir, name))) await rename(join(dir, name), join(archive, name));
  }
  await writeFile(join(archive, "run.json"), await readFile(join(dir, "run.json")));
  // Last: until run.json has its format, the run stays unreadable rather than half read.
  await write("run.json", `${JSON.stringify(planned.record, null, 2)}\n`);
}

async function main(argv: string[]): Promise<number> {
  const dryRun = argv.includes("--dry-run");
  const dirs = argv.filter((arg) => arg !== "--dry-run");
  const roots = (dirs.length > 0 ? dirs : [process.cwd()]).map((dir) => resolve(dir));
  let migrated = 0;
  let skipped = 0;
  let failed = 0;
  for (const root of roots) {
    for (const dir of findOldRuns(root)) {
      let planned: Plan | string;
      try {
        planned = await plan(dir);
      } catch (error) {
        failed++;
        console.log(`failed   ${dir}: ${(error as Error).message}`);
        continue;
      }
      if (typeof planned === "string") {
        if (planned !== "already has a format") {
          skipped++;
          console.log(`skipped  ${dir}: ${planned}`);
        }
        continue;
      }
      try {
        // Checked before anything is written: a line the reader would refuse stops this run.
        readRun(planned.lines);
        if (!dryRun) await migrate(dir, planned);
        migrated++;
        const note =
          planned.dropped.length > 0 ? ` (not carried: ${planned.dropped.join("; ")})` : "";
        console.log(`${dryRun ? "would migrate" : "migrated"} ${dir}${note}`);
      } catch (error) {
        failed++;
        console.log(`failed   ${dir}: ${(error as Error).message}`);
      }
    }
  }
  console.log(
    `\n${migrated} ${dryRun ? "to migrate" : "migrated"}, ${skipped} skipped, ${failed} failed`,
  );
  return failed > 0 ? 1 : 0;
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)));

export { main as migrateRuns };
