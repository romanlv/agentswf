import { describe, expect, test } from "bun:test";
import {
  createFakeBackend,
  createManualClock,
  printsDelimited,
  printsRawDelimited,
  reportsRawViaCli,
  reportsViaCli,
  saysNothing,
  writesFile,
} from "./backends/fake";
import { readAttempts } from "./deps";
import { runTrial, toCallResult, type TrialSpec } from "./trial";
import { COUNT_SCHEMA, tempRunDir } from "./deps";
import type { ReturnMethod } from "./deps";

const ANSWER = { count: 3, even: false };

function spec(method: ReturnMethod, runDir: string): TrialSpec {
  return {
    runId: "run-1",
    runDir,
    callId: `claude-headless-${method}-1`,
    harness: "claude",
    backend: "headless",
    method,
    index: 1,
    task: {
      question: "how many e's in 'agent terminal', and is that even",
      prompt: "Count the letter e in 'agent terminal'.",
      schema: COUNT_SCHEMA,
    },
  };
}

describe("a turn that reports", () => {
  test("the callback value arrives unprompted and the agent is never nudged", async () => {
    const runDir = tempRunDir();
    const backend = createFakeBackend({ script: () => ({ act: reportsViaCli(ANSWER) }) });

    const record = await runTrial(spec("cli-callback", runDir), backend);

    expect(record.outcome).toBe("unprompted");
    expect(record.wellFormed).toBe(true);
    expect(record.nudged).toBe(false);
    expect(record.value).toEqual(ANSWER);
    expect(backend.prompts).toHaveLength(1);
  });

  test("a file at the named path counts the same way", async () => {
    const runDir = tempRunDir();
    const backend = createFakeBackend({ script: () => ({ act: writesFile(ANSWER) }) });

    const record = await runTrial(spec("write-a-file", runDir), backend);

    expect(record.outcome).toBe("unprompted");
    expect(record.value).toEqual(ANSWER);
  });

  test("a delimited line counts the same way", async () => {
    const runDir = tempRunDir();
    const backend = createFakeBackend({ script: () => ({ act: printsDelimited(ANSWER) }) });

    const record = await runTrial(spec("delimited-line", runDir), backend);

    expect(record.outcome).toBe("unprompted");
    expect(record.value).toEqual(ANSWER);
  });

  test("the instructions for the chosen channel ride with the task prompt", async () => {
    const runDir = tempRunDir();
    const backend = createFakeBackend({ script: () => ({ act: reportsViaCli(ANSWER) }) });

    await runTrial(spec("cli-callback", runDir), backend);

    expect(backend.prompts[0]?.text).toContain("Count the letter e");
    expect(backend.prompts[0]?.text).toContain("wf result");
  });

  test("the pane environment, not the prompt, carries the call id", async () => {
    const runDir = tempRunDir();
    const backend = createFakeBackend({ script: () => ({ act: reportsViaCli(ANSWER) }) });
    const trial = spec("cli-callback", runDir);

    await runTrial(trial, backend);

    expect(backend.opened[0]?.callId).toBe(trial.callId);
    expect(backend.prompts[0]?.text).not.toContain(trial.callId);
  });
});

describe("a turn that settles without reporting", () => {
  test("one nudge recovers it, and that is recorded as recovered rather than clean", async () => {
    const runDir = tempRunDir();
    const backend = createFakeBackend({
      script: ({ turn }) =>
        turn === 1 ? { act: saysNothing() } : { act: reportsViaCli(ANSWER) },
    });

    const record = await runTrial(spec("cli-callback", runDir), backend);

    expect(record.outcome).toBe("nudged");
    expect(record.firstAttempt).toBe("absent");
    expect(record.nudged).toBe(true);
    expect(record.value).toEqual(ANSWER);
    expect(backend.prompts[1]?.text).toContain("finished without reporting");
  });

  test("an agent that ignores the nudge too is lost, not an empty answer", async () => {
    const runDir = tempRunDir();
    const backend = createFakeBackend({ script: () => ({ act: saysNothing() }) });

    const record = await runTrial(spec("cli-callback", runDir), backend);

    expect(record.outcome).toBe("lost");
    expect(record.wellFormed).toBe(false);
    expect(record.value).toBeNull();
    expect(toCallResult(record)).toEqual({
      kind: "finished",
      reason: "the turn ended without a value on the return channel",
    });
  });

  test("only one nudge is ever sent", async () => {
    const runDir = tempRunDir();
    const backend = createFakeBackend({ script: () => ({ act: saysNothing() }) });

    await runTrial(spec("cli-callback", runDir), backend);

    expect(backend.prompts).toHaveLength(2);
  });
});

describe("a turn that reports something invalid", () => {
  /**
   * The two failures the tally must never merge: an agent refused by `wf` that fixes itself
   * before the turn ends has delivered, and belongs to E5; an agent that says nothing has not.
   */
  test("a rejection the agent fixes inside its own turn is delivery, but not a clean one", async () => {
    const runDir = tempRunDir();
    const backend = createFakeBackend({
      script: () => ({
        act: async (context) => {
          await reportsRawViaCli('{"count":"3","even":false}')!(context);
          await reportsViaCli(ANSWER)!(context);
        },
      }),
    });

    const record = await runTrial(spec("cli-callback", runDir), backend);

    expect(record.outcome).toBe("unprompted");
    expect(record.firstAttempt).toBe("corrected");
    expect(record.nudged).toBe(false);
    expect(record.rejection).toContain("value.count");
    expect(record.value).toEqual(ANSWER);
  });

  test("a value accepted the first time is not filed as a correction", async () => {
    const runDir = tempRunDir();
    const backend = createFakeBackend({ script: () => ({ act: reportsViaCli(ANSWER) }) });

    const record = await runTrial(spec("cli-callback", runDir), backend);

    expect(record.firstAttempt).toBe("accepted");
    expect(record.rejection).toBeNull();
  });

  test("the rejection is a distinct first attempt from silence", async () => {
    const runDir = tempRunDir();
    const backend = createFakeBackend({
      script: ({ turn }) =>
        turn === 1
          ? { act: reportsRawViaCli('{"count":"3","even":false}') }
          : { act: reportsViaCli(ANSWER) },
    });

    const record = await runTrial(spec("cli-callback", runDir), backend);

    expect(record.firstAttempt).toBe("malformed");
    expect(record.outcome).toBe("nudged");
    expect(record.rejection).toContain("value.count");
  });

  test("the nudge repeats the validation error so the agent has something to act on", async () => {
    const runDir = tempRunDir();
    const backend = createFakeBackend({
      script: ({ turn }) =>
        turn === 1 ? { act: printsRawDelimited('{"count":-1,"even":false}') } : {},
    });

    await runTrial(spec("delimited-line", runDir), backend);

    expect(backend.prompts[1]?.text).toContain("expected at least 0");
  });

  test("an invalid value is never accepted, however many turns it takes", async () => {
    const runDir = tempRunDir();
    const backend = createFakeBackend({
      script: () => ({ act: reportsRawViaCli('{"count":"3","even":false}') }),
    });

    const record = await runTrial(spec("cli-callback", runDir), backend);

    expect(record.outcome).toBe("lost");
    expect(record.value).toBeNull();
    expect(await readAttempts(runDir, record.callId)).toHaveLength(2);
  });
});

describe("what the backend reports about the turn", () => {
  test("a pane that cannot be read loses a delimited value that was printed", async () => {
    const runDir = tempRunDir();
    const backend = createFakeBackend({
      kind: "pane",
      blind: true,
      script: () => ({ act: printsDelimited(ANSWER) }),
    });

    const record = await runTrial(spec("delimited-line", runDir), backend);

    expect(record.outcome).toBe("lost");
  });

  test("a blocked agent is blocked, not finished", async () => {
    const runDir = tempRunDir();
    const backend = createFakeBackend({
      script: () => ({ act: saysNothing(), state: "blocked", detail: "waiting on approval" }),
    });

    const record = await runTrial(spec("cli-callback", runDir), backend);

    expect(record.settled).toBe("blocked");
    expect(toCallResult(record)).toEqual({
      kind: "blocked",
      reason: "waiting on approval",
    });
  });

  test("a backend that cannot open a session is a failure, not a silent agent", async () => {
    const runDir = tempRunDir();
    const backend = createFakeBackend({
      script: () => ({}),
      openError: "herdr: server_not_running",
    });

    const record = await runTrial(spec("cli-callback", runDir), backend);

    expect(record.outcome).toBe("lost");
    expect(record.error).toContain("server_not_running");
    expect(toCallResult(record).kind).toBe("failed");
  });

  test("wall clock covers both turns and the nudge is timed on its own", async () => {
    const runDir = tempRunDir();
    const clock = createManualClock();
    const backend = createFakeBackend({
      clock,
      script: ({ turn }) =>
        turn === 1
          ? { act: saysNothing(), durationMs: 4_000 }
          : { act: reportsViaCli(ANSWER), durationMs: 900 },
    });

    const record = await runTrial(spec("cli-callback", runDir), backend, { now: clock.now });

    expect(record.firstTurnMs).toBe(4_000);
    expect(record.nudgeTurnMs).toBe(900);
    expect(record.wallClockMs).toBe(4_900);
  });

  test("the session is closed even when the agent never reports", async () => {
    const runDir = tempRunDir();
    const backend = createFakeBackend({ script: () => ({ act: saysNothing() }) });
    const trial = spec("cli-callback", runDir);

    await runTrial(trial, backend);

    expect(backend.closed).toEqual([trial.callId]);
  });
});
