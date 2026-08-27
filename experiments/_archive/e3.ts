/**
 * E3 — what does a call cost?
 *
 * The same trivial task through three shapes: a pane per call, one pooled pane reset between
 * calls, and a headless subprocess per call. Wall clock is split into getting an agent ready
 * and the turn itself, because that split is the whole argument for pooling.
 *
 * The return method is `delimited-line` throughout. It is the only one of the three that needs
 * nothing from the environment, and a pooled pane cannot carry a per-call `WF_CALL`: the
 * environment is fixed when the workspace is created and the calls come later. That is a real
 * consequence of pooling, not a convenience — see the findings.
 *
 *   bun run e3.ts --shape pane-per-call --harness claude --reps 5
 */
import { join } from "node:path";
import { createHeadlessBackend } from "./backends/headless";
import { createPaneBackend } from "./backends/pane";
import { runProcess, type ProcessInput, type ProcessResult } from "./deps";
import { collect, instructions, type MethodContext , writeE2Call } from "./return-method"
import { appendTrial, createRunDir } from "./deps";
import { resultFilePath } from "./trial";
import { poolDriver, type PooledPane } from "./e3/pool";
import type { TurnUsage } from "./deps";
import type { Harness, SettledState } from "./deps";

const HERE = import.meta.dir;

export type Shape = "pane-per-call" | "pooled-pane" | "headless";

const ALL_SHAPES: Shape[] = ["pane-per-call", "pooled-pane", "headless"];
const ALL_HARNESSES: Harness[] = ["claude", "codex", "pi", "cursor"];

/** The E2 task, plus a per-rep tag. Identical work every rep, and a unique answer every rep,
 * so a pooled pane handing back the previous call's value is visible rather than plausible. */
const SCHEMA = {
  type: "object" as const,
  properties: {
    count: { type: "integer" as const, minimum: 0 },
    even: { type: "boolean" as const },
    tag: { type: "string" as const },
  },
  required: ["count", "even", "tag"],
  additionalProperties: false,
};
const QUESTION =
  "how many times does the letter e appear in 'agent terminal', is that count even, and what tag was given";
const promptFor = (tag: string) =>
  "Count how many times the letter e appears in the string 'agent terminal', " +
  "and say whether that count is even. Do not use any tools for the counting. " +
  `Report the tag exactly as ${tag}.`;

export type E3Record = {
  runId: string;
  shape: Shape;
  harness: Harness;
  rep: number;
  callId: string;
  tag: string;
  /** Getting an agent ready: pane create plus start, the pool's reset, or nothing headless. */
  setupMs: number;
  /** Submitting the prompt until the wait says the turn settled. */
  turnMs: number;
  teardownMs: number;
  totalMs: number;
  /** Pane create and agent start, split, for the shapes that pay them. */
  createMs: number | null;
  startMs: number | null;
  /** Paid once for the whole pool, recorded on every rep so a row stands alone. */
  poolSetupMs: number | null;
  settled: SettledState;
  delivered: boolean;
  /** The tag came back as issued: this call's answer, not the previous call's. */
  tagMatched: boolean | null;
  countCorrect: boolean | null;
  value: unknown;
  sessionRef: string | null;
  /** Which turn of that session this call was, for reading a pooled pane's log afterwards. */
  sessionTurn: number;
  usage: TurnUsage | null;
  usageSource: "stdout" | null;
  /** The end of what the agent's terminal or stdout held, kept when nothing came back. */
  transcriptTail: string | null;
  error: string | null;
};

type Timing = { createMs: number | null; startMs: number | null };

/** Wraps `runProcess` so the pane backend's own herdr calls can be timed from outside it. */
function timedRun(sink: Timing): typeof runProcess {
  return async (input: ProcessInput): Promise<ProcessResult> => {
    const started = Date.now();
    const result = await runProcess(input);
    const ms = Date.now() - started;
    const verb = `${input.argv[3] ?? ""} ${input.argv[4] ?? ""}`;
    if (verb === "workspace create") sink.createMs = (sink.createMs ?? 0) + ms;
    if (verb === "agent start") sink.startMs = (sink.startMs ?? 0) + ms;
    return result;
  };
}

/** Kept only for a call that produced nothing, which is the only case it explains. */
function tail(transcript: string | null): string | null {
  if (!transcript) return null;
  return transcript
    .split("\n")
    .filter((line) => line.trim() !== "")
    .slice(-25)
    .join("\n")
    .slice(-2_000);
}

function flag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
}

function list<T extends string>(value: string | undefined, fallback: T[]): T[] {
  return value ? (value.split(",").map((entry) => entry.trim()) as T[]) : fallback;
}

async function main(argv: string[]): Promise<void> {
  const shapes = list<Shape>(flag(argv, "shape"), ALL_SHAPES);
  const harnesses = list<Harness>(flag(argv, "harness"), ALL_HARNESSES);
  const reps = Number(flag(argv, "reps") ?? 5);
  const runId = flag(argv, "run") ?? "e3";
  const runDir = await createRunDir(flag(argv, "root") ?? join(HERE, "e3", "results"), runId);
  const binDir = join(HERE, "bin");
  const session = flag(argv, "session") ?? "wf-lab";
  const resetMode = flag(argv, "reset") as "settle" | "wait" | undefined;

  console.log(`run ${runId} -> ${runDir}`);

  for (const shape of shapes) {
    for (const harness of harnesses) {
      const records = await runCell(shape, harness, {
        runId,
        runDir,
        reps,
        binDir,
        session,
        ...(resetMode ? { resetMode } : {}),
      });
      for (const record of records) {
        await appendTrial(runDir, record);
        console.log(
          `${record.shape} ${record.harness} #${record.rep}: setup ${record.setupMs}ms turn ${record.turnMs}ms total ${record.totalMs}ms delivered=${record.delivered}`,
        );
      }
    }
  }
}

type CellConfig = {
  runId: string;
  runDir: string;
  reps: number;
  binDir: string;
  session: string;
  resetMode?: "settle" | "wait";
};

async function runCell(
  shape: Shape,
  harness: Harness,
  config: CellConfig,
): Promise<E3Record[]> {
  const records: E3Record[] = [];
  let pool: PooledPane | null = null;
  let poolSetupMs: number | null = null;
  const turnsPerSession = new Map<string, number>();

  if (shape === "pooled-pane") {
    pool = await poolDriver({
      session: config.session,
      workspaceLabel: "e3-pool",
      commandTimeoutMs: 30_000,
      settleTimeoutMs: 180_000,
      binDir: config.binDir,
      cwd: HERE,
      ...(config.resetMode ? { resetMode: config.resetMode } : {}),
    }).open(harness, `${harness}-${config.runId}`);
    poolSetupMs = pool.setupMs;
  }

  try {
    for (let rep = 1; rep <= config.reps; rep += 1) {
      const tag = `R${rep}-${harness.slice(0, 2).toUpperCase()}`;
      const callId = `${shape}-${harness}-${rep}`;
      const context: MethodContext = {
        runDir: config.runDir,
        callId,
        filePath: resultFilePath(config.runDir, callId),
        schema: SCHEMA,
      };
      await writeE2Call(config.runDir, {
        callId,
        question: QUESTION,
        method: "delimited-line",
        schema: SCHEMA,
      });
      const text = `${promptFor(tag)}\n\n${instructions("delimited-line", context)}`;

      const base = {
        runId: config.runId,
        shape,
        harness,
        rep,
        callId,
        tag,
        poolSetupMs,
      };

      const timing: Timing = { createMs: null, startMs: null };
      let setupMs = 0;
      let turnMs = 0;
      let teardownMs = 0;
      let settled: SettledState = "unknown";
      let sessionRef: string | null = null;
      let usage: TurnUsage | null = null;
      let usageSource: "stdout" | null = null;
      let transcript: string | null = null;
      let error: string | null = null;

      try {
        if (shape === "headless") {
          const backend = createHeadlessBackend(
            { turnTimeoutMs: 180_000, binDir: config.binDir },
            runProcess,
          );
          const session = await backend.open(
            { prompt: text, harness, backend: "headless", cwd: HERE, schema: SCHEMA },
            { runDir: config.runDir, callId },
          );
          const started = Date.now();
          const turn = await session.prompt(text);
          turnMs = Date.now() - started;
          settled = turn.state;
          sessionRef = turn.sessionRef ?? null;
          usage = turn.usage ?? null;
          usageSource = turn.usage ? "stdout" : null;
          transcript = await session.transcript();
          await session.close();
        } else if (shape === "pane-per-call") {
          const backend = createPaneBackend(
            {
              session: config.session,
              workspaceLabel: "e3-per-call",
              commandTimeoutMs: 30_000,
              settleTimeoutMs: 180_000,
              binDir: config.binDir,
            },
            timedRun(timing),
          );
          const setupStarted = Date.now();
          const paneSession = await backend.open(
            { prompt: text, harness, backend: "pane", cwd: HERE, schema: SCHEMA },
            { runDir: config.runDir, callId },
          );
          setupMs = Date.now() - setupStarted;
          const started = Date.now();
          const turn = await paneSession.prompt(text);
          turnMs = Date.now() - started;
          settled = turn.state;
          sessionRef = turn.sessionRef ?? null;
          transcript = await paneSession.transcript();
          const closeStarted = Date.now();
          await paneSession.close();
          teardownMs = Date.now() - closeStarted;
        } else {
          // The first call of a pool pays no reset: the pane is already fresh.
          if (rep > 1) {
            const reset = await pool!.reset();
            setupMs = reset.ms;
            if (!reset.ok) error = `reset failed: ${reset.detail ?? "unknown"}`;
          }
          const started = Date.now();
          const turn = await pool!.prompt(text);
          turnMs = Date.now() - started;
          settled = turn.state;
          sessionRef = turn.sessionRef ?? null;
          transcript = await pool!.read();
        }
      } catch (thrown) {
        error = thrown instanceof Error ? thrown.message : String(thrown);
      }

      const collected = await collect("delimited-line", context, transcript);
      const value = collected.kind === "value" ? collected.value : null;
      const object = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
      const turnIndex = sessionRef ? (turnsPerSession.get(sessionRef) ?? 0) : 0;
      if (sessionRef) turnsPerSession.set(sessionRef, turnIndex + 1);

      records.push({
        ...base,
        setupMs,
        turnMs,
        teardownMs,
        totalMs: setupMs + turnMs + teardownMs,
        createMs: timing.createMs,
        startMs: timing.startMs,
        settled,
        delivered: collected.kind === "value",
        tagMatched: object ? object.tag === tag : null,
        countCorrect: object ? object.count === 2 : null,
        value,
        sessionRef,
        sessionTurn: turnIndex,
        usage,
        usageSource,
        transcriptTail: collected.kind === "value" ? null : tail(transcript),
        error,
      });
    }
  } finally {
    await pool?.close().catch(() => {});
  }

  return records;
}

if (import.meta.main) await main(process.argv.slice(2));
