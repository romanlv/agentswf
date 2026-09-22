import { describe, expect, test } from "bun:test";
import type { ProcessInput, RunProcess } from "../command";
import { HARNESSES } from "../spec";
import type { Step } from "../types";
import {
  createDirectProcessAdapter,
  createHeadlessAdapter,
  type DirectProcessConfig,
} from "./direct-process";

const CALL = { runDir: "/runs/r", callId: "c1" };
const STEP: Step = { prompt: "count the e's", harness: "claude", backend: "headless" };

function stub(stdouts: string[]): { run: RunProcess; calls: ProcessInput[] } {
  const calls: ProcessInput[] = [];
  let turn = 0;
  const run: RunProcess = async (input) => {
    calls.push(input);
    const stdout = stdouts[turn] ?? "";
    turn += 1;
    return { stdout, stderr: "", exitCode: 0, timedOut: false };
  };
  return { run, calls };
}

const claudeOut = (result: string, sessionId = "sess-1") =>
  JSON.stringify({ session_id: sessionId, result });

describe("createDirectProcessAdapter", () => {
  test("the call reaches the agent through the subprocess environment", async () => {
    const { run, calls } = stub([claudeOut("done")]);
    const session = await createDirectProcessAdapter(
      { turnTimeoutMs: 1_000, binDir: "/wf/bin" },
      run,
    ).open(STEP, CALL);

    await session.prompt("go");

    expect(calls[0]?.env?.WF_RUN).toBe("/runs/r");
    expect(calls[0]?.env?.WF_CALL).toBe("c1");
    expect(calls[0]?.env?.PATH?.startsWith("/wf/bin:")).toBe(true);
  });

  test("the transcript is what the agent said, not the harness envelope", async () => {
    const { run } = stub([claudeOut("the count is 3")]);
    const session = await createDirectProcessAdapter({ turnTimeoutMs: 1_000 }, run).open(STEP, CALL);

    await session.prompt("go");

    expect(await session.transcript()).toBe("the count is 3");
  });

  test("a second prompt resumes the first turn's session and carries its usage", async () => {
    const { run, calls } = stub([
      claudeOut("done"),
      JSON.stringify({
        session_id: "sess-1",
        result: "ok",
        total_cost_usd: 0.042,
        usage: { input_tokens: 2, output_tokens: 7 },
      }),
    ]);
    const session = await createDirectProcessAdapter({ turnTimeoutMs: 1_000 }, run).open(STEP, CALL);

    await session.prompt("go");
    const second = await session.prompt("again");

    expect(calls[0]?.argv).not.toContain("--resume");
    expect(calls[1]?.argv[calls[1].argv.indexOf("--resume") + 1]).toBe("sess-1");
    expect(second.usage).toMatchObject({ costUsd: 0.042, outputTokens: 7 });
    expect(await session.transcript()).toBe("doneok");
  });

  test("a nonzero exit is unknown, not a completed turn", async () => {
    const run: RunProcess = async () => ({
      stdout: "",
      stderr: "credit balance too low",
      exitCode: 1,
      timedOut: false,
    });
    const session = await createDirectProcessAdapter({ turnTimeoutMs: 1_000 }, run).open(STEP, CALL);

    expect(await session.prompt("go")).toMatchObject({
      state: "unknown",
      detail: expect.stringContaining("credit balance too low"),
    });
  });

  test("a timeout is reported as such rather than as an empty answer", async () => {
    const run: RunProcess = async () => ({
      stdout: "",
      stderr: "",
      exitCode: 137,
      timedOut: true,
    });
    const session = await createDirectProcessAdapter({ turnTimeoutMs: 1_000 }, run).open(STEP, CALL);

    expect(await session.prompt("go")).toMatchObject({
      state: "unknown",
      detail: "timed out after 1000ms",
    });
  });
});

describe("createHeadlessAdapter", () => {
  const activation = {
    key: "reviewer",
    deadline: { unixMilliseconds: Date.now() + 60_000 },
    cwd: "/repo",
    instructions: "Follow repository instructions.",
    execution: {
      harness: "claude",
      model: "opus",
    },
  };
  const firstBinding = {
    endpoint: "/private/engine.sock",
    operationId: "op-1",
  };
  const turnSpec = { id: "turn-1", prompt: "review", deadline: activation.deadline };
  const nudgeSpec = { id: "turn-1:nudge", prompt: "report", deadline: activation.deadline };

  const headless = (
    run: RunProcess,
    config: Partial<DirectProcessConfig> = {},
    request: typeof activation = activation,
  ) => createHeadlessAdapter({ turnTimeoutMs: 10_000, ...config }, run).activate(request);

  test("a nudge resumes the native session in a fresh process environment", async () => {
    const { run, calls } = stub([claudeOut("first"), claudeOut("second")]);
    const session = await headless(run, { newSessionId: () => "chosen" });
    const first = await session.start(turnSpec, firstBinding);
    await expect(first.settled).resolves.toMatchObject({
      state: "completed",
      resultEvidence: { kind: "transcript", text: "first" },
    });
    const nudge = await first.nudge(nudgeSpec);
    await nudge.settled;

    // Nothing about the operation: the agent is told the launcher's path in the prompt, so a
    // turn that carried an environment would be carrying something the next turn must not reuse.
    expect(calls[0]?.env).toEqual({});
    expect(calls[1]?.env).toEqual({});
    expect(calls[0]?.argv).not.toContain("--resume");
    expect(calls[1]?.argv[calls[1].argv.indexOf("--resume") + 1]).toBe("sess-1");
  });

  test("compaction resumes without result authority", async () => {
    const { run, calls } = stub([claudeOut("first"), claudeOut("summary")]);
    const session = await headless(run, { newSessionId: () => "chosen" });
    const turn = await session.start(turnSpec, firstBinding);
    await turn.settled;
    const compact = await session.compact("compact-1", "summarize", activation.deadline);
    await compact.settled;

    expect(calls[1]?.env).toEqual({});
    expect(calls[1]?.argv).toContain("--resume");
  });

  test("the prompt rides on stdin, where no CLI reinterprets it", async () => {
    const { run, calls } = stub([claudeOut("done")]);
    const prompt = "count the e's in 'agent terminal'";
    const session = await headless(run);
    await (await session.start({ ...turnSpec, prompt }, firstBinding)).settled;

    expect(calls[0]?.stdin).toBe(`${activation.instructions}\n\n${prompt}`);
    expect(calls[0]?.argv).not.toContain(prompt);
  });

  test("the session id pi is given up front is the one its nudge resumes", async () => {
    const { run, calls } = stub(["{}", "{}"]);
    const session = await headless(
      run,
      { newSessionId: () => "chosen-id" },
      { ...activation, execution: { harness: "pi", model: "opus" } },
    );
    const turn = await session.start(turnSpec, firstBinding);
    await turn.settled;
    await (await turn.nudge(nudgeSpec)).settled;

    expect(calls[0]?.argv[calls[0].argv.indexOf("--session-id") + 1]).toBe("chosen-id");
    expect(calls[1]?.argv[calls[1].argv.indexOf("--session-id") + 1]).toBe("chosen-id");
  });

  test("what the turn cost is carried out of the harness envelope", async () => {
    const { run } = stub([
      JSON.stringify({
        session_id: "s",
        result: "done",
        total_cost_usd: 0.042,
        usage: { input_tokens: 2, output_tokens: 7, cache_read_input_tokens: 900 },
      }),
    ]);
    const session = await headless(run);
    const turn = await session.start(turnSpec, firstBinding);

    expect((await turn.settled).nativeUsage[0]).toMatchObject({
      costUsd: 0.042,
      outputTokens: 7,
      cachedInputTokens: 900,
    });
  });

  test("a harness with no confirmed resume cannot be nudged, and says so", async () => {
    const { run, calls } = stub(["first turn", "second turn"]);
    const { resumeTurn } = HARNESSES.codex;
    delete HARNESSES.codex.resumeTurn;
    try {
      const session = await headless(
        run,
        {},
        { ...activation, execution: { harness: "codex", model: "gpt-5.6-sol" } },
      );
      const turn = await session.start(turnSpec, firstBinding);
      await turn.settled;
      const nudge = await turn.nudge(nudgeSpec);

      await expect(nudge.settled).resolves.toMatchObject({
        state: "failed",
        detail: expect.stringContaining("no confirmed headless resume"),
      });
      expect(calls).toHaveLength(1);
    } finally {
      HARNESSES.codex.resumeTurn = resumeTurn;
    }
  });

  test("a nonzero exit fails the turn instead of passing off an empty answer", async () => {
    const run: RunProcess = async () => ({
      stdout: "",
      stderr: "credit balance too low",
      exitCode: 1,
      timedOut: false,
    });
    const session = await headless(run);
    const turn = await session.start(turnSpec, firstBinding);

    await expect(turn.settled).resolves.toMatchObject({
      state: "failed",
      detail: expect.stringContaining("credit balance too low"),
    });
  });

  test("reports lifecycle status and closes idempotently", async () => {
    let release!: () => void;
    const run: RunProcess = async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { stdout: claudeOut("done"), stderr: "", exitCode: 0, timedOut: false };
    };
    const session = await headless(run);
    const turn = await session.start(turnSpec, firstBinding);
    expect(await session.status()).toEqual({ state: "working" });
    release();
    await turn.settled;
    expect(await session.status()).toEqual({ state: "idle" });
    await session.close();
    await session.close();
    expect(await session.status()).toEqual({ state: "missing" });
  });

  test("cancellation reaches the active child process", async () => {
    const run: RunProcess = async (input) =>
      new Promise((resolve) => {
        input.signal?.addEventListener(
          "abort",
          () =>
            resolve({
              stdout: "",
              stderr: "",
              exitCode: 137,
              timedOut: false,
              cancelled: true,
            }),
          { once: true },
        );
      });
    const session = await headless(run);
    const turn = await session.start(turnSpec, firstBinding);

    await expect(turn.release("stop", activation.deadline)).resolves.toMatchObject({
      kind: "released",
    });
    await expect(turn.settled).resolves.toMatchObject({ state: "cancelled" });
  });

  test("distinguishes the adapter's native timeout from the operation deadline", async () => {
    const run: RunProcess = async () => ({
      stdout: "",
      stderr: "",
      exitCode: 137,
      timedOut: true,
    });
    const session = await headless(run, { turnTimeoutMs: 250 });
    const turn = await session.start(turnSpec, firstBinding);

    await expect(turn.settled).resolves.toMatchObject({
      state: "timed-out",
      detail: "native turn timed out after 250ms",
    });
  });

  test("close aborts and waits for the active child", async () => {
    let aborted = false;
    const run: RunProcess = async (input) =>
      new Promise((resolve) =>
        input.signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            resolve({
              stdout: "",
              stderr: "",
              exitCode: 137,
              timedOut: false,
              cancelled: true,
            });
          },
          { once: true },
        ),
      );
    const session = await headless(run);
    const turn = await session.start(turnSpec, firstBinding);

    await session.close();

    expect(aborted).toBe(true);
    await expect(turn.settled).resolves.toMatchObject({ state: "cancelled" });
    await expect(session.status()).resolves.toEqual({ state: "missing" });
  });
});
