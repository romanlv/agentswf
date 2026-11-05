import { afterAll, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SpendRecord, TokenUsage } from "@agentswf/contract/records";
import type { JsonValue, OutputSchema, WorkflowContext } from "@agentswf/contract/workflow";
import {
  createSessionAccounting,
  createSingleSessionHostFactory,
  type SessionAccounting,
  type UsageRecord,
} from "@agentswf/harness";
import type { AgentSessionAdapter } from "@agentswf/harness/adapter";
import { createFakeAdapter } from "@agentswf/harness/testing";
import { PUBLISHED_PRICES } from "./accounting/prices";
import { attemptsSpent, earlierSpent, runEstimate } from "./accounting/spent";
import { writeJson } from "./files";
import { listOps, OpIds, spendFile } from "./ops";
import { claimRunLines, readRunLines } from "./run-lines";
import { createRun, openRun, readAttempts } from "./runs";
import { keepSpend, readSpent, settleEarlier, writeSpend } from "./spend";
import { claimLines, createTempRunDirs, future, startNew, submit, writeAttempt } from "./testing";
import { runWorkflow } from "./workflow-runner";

const runDirs = createTempRunDirs();
afterAll(() => runDirs.cleanup());

const ANSWER: OutputSchema<{ answer: string }> = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
  additionalProperties: false,
};
const ALIASES = { review: { harness: "fake", model: "claude-sonnet-5" } };
const tokens = (output: number): TokenUsage => ({ input: 0, cacheRead: 0, cacheWrite: 0, output });

/** Session files, as a fake: what each session logged, and every read of them. */
function sessionFiles() {
  const logged = new Map<string, UsageRecord[]>();
  let requests = 0;
  const accounting = {
    reads: 0,
    pollMs: 5,
    stalledMs: 1_000,
    statusMs: 50,
    /** Called as a read begins: a test's stop lands here. */
    onRead: (): void => undefined,
    async read(_execution: unknown, sessions: readonly string[]) {
      accounting.reads += 1;
      accounting.onRead();
      const found = sessions.filter((session) => logged.has(session));
      return found.length === 0
        ? undefined
        : { records: found.flatMap((session) => logged.get(session)!), open: false };
    },
    async billing() {
      return "subscription" as const;
    },
  } satisfies SessionAccounting & { reads: number; onRead(): void };
  return {
    accounting,
    log(session: string, output: number, at = new Date().toISOString()) {
      requests += 1;
      const record = {
        key: `req_${requests}`,
        at,
        model: "claude-sonnet-5",
        delegated: false,
        tokens: tokens(output),
      };
      logged.set(session, [...(logged.get(session) ?? []), record]);
    },
  };
}

function answering(files: ReturnType<typeof sessionFiles>, output: number): AgentSessionAdapter {
  return createFakeAdapter({
    script: (context) => ({
      sessionRef: "s-worker",
      act: async () => {
        files.log("s-worker", output);
        await submit(context.binding!, { answer: "ok" });
      },
    }),
  });
}

const workflow = (body: (context: WorkflowContext) => Promise<JsonValue>) => ({
  meta: { name: "spent", description: "fixture" },
  run: body,
});

async function spendOf(runDir: string, op: string): Promise<SpendRecord> {
  return JSON.parse(await readFile(spendFile(runDir, op), "utf8"));
}

test("an attempt that ends writes each agent operation's spend.json, once and unpriced", async () => {
  const files = sessionFiles();
  const runRoot = runDirs.tempRunDir();
  const result = await (
    await startNew(
      workflow(async (context) => {
        const worker = await context.agents.open({ key: "worker", runtime: "review" });
        await worker.run({ prompt: "Go.", schema: ANSWER });
        return null;
      }),
      null,
      {
        runRoot,
        deadline: future(),
        runtime: {
          aliases: ALIASES,
          host: createSingleSessionHostFactory(answering(files, 1_000), files.accounting),
        },
      },
    )
  ).result;
  const { dir } = await openRun(runRoot, "spent", result.runId);
  const spend = await spendOf(dir, "worker.1");
  expect(spend).toMatchObject({
    billing: "subscription",
    spend: [{ model: "claude-sonnet-5", delegated: false, tokens: tokens(1_000) }],
    deliveredAt: expect.any(String),
    settledAt: expect.any(String),
  });
  // A measurement, not a price: nothing in it names a table or an amount.
  expect(JSON.stringify(spend)).not.toContain("estimate");
  expect(spend).not.toHaveProperty("settledBy");
  // Linked into place: a second write never lands.
  expect(await writeSpend(dir, "worker.1", { billing: "unknown" })).toBe(false);
  expect(await spendOf(dir, "worker.1")).toEqual(spend);
  // Priced as it is read: 1,000 output tokens of claude-sonnet-5 at $10/M.
  const attempt = { attempt: 1, started: result.startedAt, ended: result.finishedAt };
  expect(runEstimate(await readSpent(dir, [attempt as never]))).toBeCloseTo(0.01, 6);
});

test("an interrupted attempt's spend is settled by the next one, from its session lines", async () => {
  const files = sessionFiles();
  const runRoot = runDirs.tempRunDir();
  const run = await createRun(runRoot, {
    id: "r1",
    workflow: "spent",
    argv: [],
    cwd: runRoot,
    sandbox: null,
  });
  // Attempt 1 drew two turns of its agent, named its session, and died: no ending, no spend.
  const started = Date.now() - 60_000;
  await writeAttempt(run, { started: new Date(started).toISOString() });
  const one = await claimRunLines(run.dir, 1, new Date(started).toISOString());
  const where = { agent: "worker", execution: { harness: "codex", model: "claude-sonnet-5" } };
  const ids = new OpIds(run.dir, 1, await listOps(run.dir));
  ids.draw("worker", { kind: "turn", question: "First.", ...where, cwd: runRoot });
  const before = new Date().toISOString();
  await Bun.sleep(5);
  ids.draw("worker", { kind: "turn", question: "Second.", ...where, cwd: runRoot });
  await one.append({
    kind: "session",
    attempt: 1,
    at: new Date().toISOString(),
    agent: "worker",
    harness: "codex",
    session: "s-worker",
    operation: "worker.1",
  });
  // A request from before attempt 1 began is another attempt's; the rest are shared by start.
  files.log("s-worker", 7, new Date(started - 1_000).toISOString());
  files.log("s-worker", 100, before);
  files.log("s-worker", 200);

  const handle = await runWorkflow(
    workflow(async () => null),
    null,
    {
      runRoot,
      run: { dir: run.dir, id: "r1", ...(await claimLines(run.dir, 2)) },
      runtime: {
        aliases: ALIASES,
        host: createSingleSessionHostFactory(answering(files, 0), files.accounting),
      },
      deadline: future(),
    },
  );
  expect(handle.value).toBeNull();
  expect(await spendOf(run.dir, "worker.1")).toEqual({
    billing: "subscription",
    spend: [{ model: "claude-sonnet-5", delegated: false, tokens: tokens(100) }],
    settledBy: 2,
  });
  expect(await spendOf(run.dir, "worker.2")).toMatchObject({
    spend: [{ tokens: tokens(200) }],
    settledBy: 2,
  });
  // Attempt 1's cost is known now: its 300 output tokens, priced as they are read.
  const attempts = [...(await readAttempts(run)), { attempt: 2, started: before }];
  const spent = await readSpent(run.dir, attempts as never);
  expect(spent[0]).toMatchObject({ attempt: 1, unsettled: 0 });
  expect(spent[0]!.accounting.totals.estimate).toBeCloseTo(0.003, 6);
  expect(earlierSpent(spent, attempts, 2)).toMatchObject({ interrupted: 0, ended: 0 });
  // Settled once: a later attempt reads nothing again.
  const reads = files.accounting.reads;
  await runWorkflow(
    workflow(async () => null),
    null,
    {
      runRoot,
      run: { dir: run.dir, id: "r1", ...(await claimLines(run.dir, 3)) },
      runtime: {
        aliases: ALIASES,
        host: createSingleSessionHostFactory(answering(files, 0), files.accounting),
      },
      deadline: future(),
    },
  );
  expect(files.accounting.reads).toBe(reads);
});

test("a read a stop cut short writes no spend.json, and the next attempt reads it", async () => {
  const files = sessionFiles();
  const runRoot = runDirs.tempRunDir();
  const handle = await startNew(
    workflow(async (context) => {
      const worker = await context.agents.open({ key: "worker", runtime: "review" });
      await worker.run({ prompt: "Go.", schema: ANSWER });
      return null;
    }),
    null,
    {
      runRoot,
      deadline: future(),
      runtime: {
        aliases: ALIASES,
        host: createSingleSessionHostFactory(answering(files, 40), files.accounting),
      },
    },
  );
  // Ctrl-C as the run reads what its agent spent.
  let stopped: Promise<void> | undefined;
  files.accounting.onRead = () => {
    stopped ??= handle.stop("operator");
  };
  const first = await handle.result.catch(
    (error: { settled?: { runId: string } }) => error.settled,
  );
  const { dir } = await openRun(runRoot, "spent", first!.runId);
  await stopped;
  expect((await listOps(dir)).get("worker")?.last).toBe(1);
  expect(await Bun.file(spendFile(dir, "worker.1")).exists()).toBe(false);
  await writeAttempt(await openRun(runRoot, "spent", first!.runId), {
    started: new Date(Date.now() - 60_000).toISOString(),
    ended: new Date().toISOString(),
    outcome: "cancelled",
  });

  files.accounting.onRead = () => undefined;
  await runWorkflow(
    workflow(async () => null),
    null,
    {
      runRoot,
      run: { dir, id: first!.runId, ...(await claimLines(dir, 2)) },
      runtime: {
        aliases: ALIASES,
        host: createSingleSessionHostFactory(answering(files, 0), files.accounting),
      },
      deadline: future(),
    },
  );
  expect(await spendOf(dir, "worker.1")).toMatchObject({
    billing: "subscription",
    spend: [{ tokens: tokens(40) }],
    settledBy: 2,
  });
});

/** A run with attempt 1 claimed and ended at `ended`, and a writer for its lines and ops. */
async function earlierRun(started: number, ended?: number) {
  const runRoot = runDirs.tempRunDir();
  const run = await createRun(runRoot, {
    id: "r1",
    workflow: "spent",
    argv: [],
    cwd: runRoot,
    sandbox: null,
  });
  await writeAttempt(run, {
    started: new Date(started).toISOString(),
    ...(ended === undefined ? {} : { ended: new Date(ended).toISOString(), outcome: "failed" }),
  });
  const lines = await claimRunLines(run.dir, 1, new Date(started).toISOString());
  const ids = new OpIds(run.dir, 1, await listOps(run.dir));
  const draw = (agent: string, execution: Record<string, unknown> = {}) =>
    ids.draw(agent, {
      kind: "turn",
      question: "Go.",
      agent,
      execution: { harness: "codex", model: "gpt-6-sol", ...execution },
      cwd: runRoot,
    }).id;
  const session = (agent: string, id: string) =>
    lines.append({
      kind: "session",
      attempt: 1,
      at: new Date().toISOString(),
      agent,
      harness: "codex",
      session: id,
    });
  const settle = async (accounting: SessionAccounting | undefined, signal?: AbortSignal) =>
    settleEarlier(run.dir, {
      attempt: 2,
      attempts: await readAttempts(run),
      lines: (await readRunLines(run.dir)).lines,
      accounting,
      now: Date.now(),
      ...(signal ? { signal } : {}),
    });
  return { run, draw, session, settle };
}

const iso = (at: number) => new Date(at).toISOString();

test("a fork's copy of its parent's rows stays the parent's, the parent settled already", async () => {
  const files = sessionFiles();
  const start = Date.now() - 60_000;
  const { run, draw, session, settle } = await earlierRun(start);
  const parent = draw("worker");
  // The parent's row, from before the fork was made.
  files.log("s-worker", 10, iso(Date.now()));
  await Bun.sleep(5);
  const fork = draw("tests");
  await session("worker", "s-worker");
  await session("tests", "s-fork");
  // The parent ended with its spend read, and isn't read again; the fork's attempt died.
  await writeSpend(run.dir, parent, { billing: "subscription", spend: [] });
  // The fork's file: its parent's row under the same key, then its own.
  const copied = files.accounting;
  const read: SessionAccounting["read"] = async (execution, sessions) => {
    const found = await copied.read(execution, ["s-worker"]);
    const own = await copied.read(execution, sessions);
    return sessions.includes("s-fork")
      ? { records: [...(found?.records ?? []), ...(own?.records ?? [])], open: false }
      : own;
  };
  files.log("s-fork", 20);
  await settle({ ...files.accounting, read });
  expect(await spendOf(run.dir, fork)).toMatchObject({ spend: [{ tokens: tokens(20) }] });
});

test("the session reader says which harnesses it can ever read", () => {
  const reader = createSessionAccounting();
  expect(reader.canRead?.({ harness: "claude", model: "claude-sonnet-5" })).toBe(true);
  expect(reader.canRead?.({ harness: "fake", model: "m" })).toBe(false);
});

test("a calling session isn't read; its spend is written unknown", async () => {
  const files = sessionFiles();
  const { run, draw, session, settle } = await earlierRun(Date.now() - 60_000);
  const op = draw("caller", { caller: true, model: "" });
  await session("caller", "s-caller");
  files.log("s-caller", 50);
  await settle(files.accounting);
  expect(files.accounting.reads).toBe(0);
  expect(await spendOf(run.dir, op)).toEqual({ billing: "unknown", settledBy: 2 });
});

test("the window: from the agent's first operation to the attempt's end, shared by start", async () => {
  const files = sessionFiles();
  const { run, draw, session, settle } = await earlierRun(Date.now() - 60_000);
  const first = draw("worker");
  const { at: firstAt } = JSON.parse(
    await readFile(join(run.dir, "ops", first, "op.json"), "utf8"),
  );
  await Bun.sleep(5);
  const second = draw("worker");
  await session("worker", "s-worker");
  const end = Date.now() + 5;
  const [attempt] = await readAttempts(run);
  await writeJson(join(run.dir, "attempts", "1.json"), { ...attempt, ended: iso(end) });
  await Bun.sleep(20);
  files.log("s-worker", 1, iso(Date.parse(firstAt) - 1));
  files.log("s-worker", 2, firstAt);
  files.log("s-worker", 4, iso(end));
  files.log("s-worker", 8, iso(end + 1));
  await settle(files.accounting);
  // Before its first operation: another attempt's; at it, the first's; at the end, the second's.
  expect(await spendOf(run.dir, first)).toMatchObject({ spend: [{ tokens: tokens(2) }] });
  expect(await spendOf(run.dir, second)).toMatchObject({ spend: [{ tokens: tokens(4) }] });
});

test("a settling stopped writes nothing, and leaves it for a later attempt", async () => {
  const files = sessionFiles();
  const { run, draw, session, settle } = await earlierRun(Date.now() - 60_000);
  const op = draw("worker");
  await session("worker", "s-worker");
  files.log("s-worker", 3);
  const stopped = new AbortController();
  stopped.abort();
  expect(await settle(files.accounting, stopped.signal)).toEqual({ settled: 0, failed: [] });
  expect(await Bun.file(spendFile(run.dir, op)).exists()).toBe(false);
  await settle(files.accounting);
  expect(await spendOf(run.dir, op)).toMatchObject({ spend: [{ tokens: tokens(3) }] });
});

test("a metered operation the next attempt read has an unknown charge: not billed", async () => {
  const op = (id: string) =>
    ({
      id,
      attempt: 1,
      at: iso(Date.now()),
      kind: "turn",
      question: "Go.",
      agent: id,
      execution: { harness: "claude", model: "claude-sonnet-5", placement: "headless" },
      cwd: "/w",
    }) as const;
  const spend = [{ model: "claude-sonnet-5", delegated: false, tokens: tokens(10) }];
  const [figures] = attemptsSpent(
    [
      {
        op: op("a"),
        spend: { billing: "metered", spend, charged: { amount: 1, currency: "USD" } },
      },
      { op: op("b"), spend: { billing: "metered", spend, settledBy: 2 } },
    ],
    [{ attempt: 1, started: iso(Date.now() - 1_000), ended: iso(Date.now()) }],
    PUBLISHED_PRICES,
  );
  expect(figures!.accounting.totals).toMatchObject({ agents: 2, billed: 1, charged: 1 });
});

test("an ending attempt whose read failed leaves it to the next, and a withdrawn message spent nothing", async () => {
  const { run, draw } = await earlierRun(Date.now() - 60_000);
  const unread = draw("worker");
  const withdrawn = draw("peer");
  const usage = {
    callPath: [],
    agent: "worker",
    operationId: unread,
    execution: { harness: "codex", model: "gpt-6-sol" },
    sessions: [],
    billing: "unknown" as const,
  };
  expect(await keepSpend(run.dir, 1, [usage], { reads: () => true })).toEqual([]);
  expect(await Bun.file(spendFile(run.dir, unread)).exists()).toBe(false);
  expect(await spendOf(run.dir, withdrawn)).toEqual({ billing: "unknown", spend: [] });
  // Where nothing could ever read its harness's sessions, unknown is final at once.
  await keepSpend(run.dir, 1, [usage], { reads: () => false });
  expect(await spendOf(run.dir, unread)).toEqual({ billing: "unknown" });
});
