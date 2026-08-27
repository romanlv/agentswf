import { describe, expect, test } from "bun:test";
import { createFakeBackend, reportsViaCli, saysNothing, type FakeBackend } from "./backends/fake";
import { openJournal, runWorkflow, type Agent, type RunCall } from "./journal";
import { readJournal } from "./deps";
import { toCallResult, runTrial } from "./trial";
import { tempRunDir } from "./deps";
import type { CallResult, Step } from "./deps";

function step(prompt: string): Step {
  return { prompt, harness: "claude", backend: "headless" };
}

/** The journal over the real call path: fake agent, real `wf result`, real result layer. */
function viaTrial(runDir: string, backend: FakeBackend): RunCall {
  let index = 0;
  return async (spec, callId) => {
    index += 1;
    const record = await runTrial(
      {
        runId: "e6",
        runDir,
        callId,
        harness: spec.harness,
        backend: spec.backend ?? "headless",
        method: "cli-callback",
        index,
        task: { question: spec.prompt, prompt: spec.prompt },
      },
      backend,
    );
    return toCallResult(record);
  };
}

/** Answers with the prompt echoed back, so a replayed value names the call it came from. */
function echoes(): FakeBackend {
  return createFakeBackend({
    script: (context) => ({ act: reportsViaCli({ answer: `answer to ${context.step.prompt}` }) }),
  });
}

const sequence = (prompts: readonly string[]) => async (agent: Agent) => {
  const results: CallResult[] = [];
  for (const prompt of prompts) results.push(await agent(step(prompt)));
  return results;
};

const values = (results: readonly CallResult[]) =>
  results.map((result) => (result.kind === "answered" ? result.value : result.kind));

const promptsSeen = (backend: FakeBackend) =>
  backend.opened.map((opened) => opened.step.prompt);

describe("the journal replays", () => {
  test("a second identical run is all cache and opens no agent", async () => {
    const runDir = tempRunDir();
    const first = echoes();
    const one = await runWorkflow(runDir, viaTrial(runDir, first), sequence(["a", "b", "c"]));

    const second = echoes();
    const two = await runWorkflow(runDir, viaTrial(runDir, second), sequence(["a", "b", "c"]));

    expect(one.stats).toEqual({ hits: 0, misses: 3 });
    expect(two.stats).toEqual({ hits: 3, misses: 0 });
    expect(second.opened).toHaveLength(0);
    expect(values(two.value)).toEqual(values(one.value));
  });

  test("an edited step re-runs itself and everything after it, and nothing before it", async () => {
    const runDir = tempRunDir();
    await runWorkflow(runDir, viaTrial(runDir, echoes()), sequence(["a", "b", "c", "d"]));

    const second = echoes();
    const two = await runWorkflow(
      runDir,
      viaTrial(runDir, second),
      sequence(["a", "b-edited", "c", "d"]),
    );

    expect(two.stats).toEqual({ hits: 1, misses: 3 });
    expect(promptsSeen(second)).toEqual(["b-edited", "c", "d"]);
  });

  test("a run killed mid-call keeps what finished and re-runs the rest", async () => {
    const runDir = tempRunDir();
    const first = echoes();
    const dies: RunCall = async (spec, callId) => {
      if (spec.prompt === "c") throw new Error("the process was killed");
      return viaTrial(runDir, first)(spec, callId);
    };

    await expect(
      runWorkflow(runDir, dies, sequence(["a", "b", "c", "d"])),
    ).rejects.toThrow("the process was killed");
    expect(await readJournal(runDir)).toHaveLength(2);

    const second = echoes();
    const two = await runWorkflow(
      runDir,
      viaTrial(runDir, second),
      sequence(["a", "b", "c", "d"]),
    );

    expect(two.stats).toEqual({ hits: 2, misses: 2 });
    expect(promptsSeen(second)).toEqual(["c", "d"]);
  });

  test("a failed call is not cached and runs again on resume", async () => {
    const runDir = tempRunDir();
    const breaks = createFakeBackend({
      script: (context) => {
        if (context.step.prompt === "b") throw new Error("herdr lost the pane");
        return { act: reportsViaCli({ answer: `answer to ${context.step.prompt}` }) };
      },
    });
    const one = await runWorkflow(
      runDir,
      viaTrial(runDir, breaks),
      sequence(["a", "b", "c"]),
    );

    expect(one.value[1]!.kind).toBe("failed");
    expect((await readJournal(runDir)).map((entry) => entry.index)).toEqual([0, 2]);

    const second = echoes();
    const two = await runWorkflow(runDir, viaTrial(runDir, second), sequence(["a", "b", "c"]));

    expect(two.stats).toEqual({ hits: 2, misses: 1 });
    expect(promptsSeen(second)).toEqual(["b"]);
    expect(values(two.value)).toEqual([
      { answer: "answer to a" },
      { answer: "answer to b" },
      { answer: "answer to c" },
    ]);
  });

  test("a turn that settled without a value is not cached either", async () => {
    const runDir = tempRunDir();
    const silent = createFakeBackend({ script: () => ({ act: saysNothing() }) });
    const one = await runWorkflow(runDir, viaTrial(runDir, silent), sequence(["a"]));

    expect(one.value[0]!.kind).toBe("finished");
    expect(await readJournal(runDir)).toHaveLength(0);
  });

  test("two identical calls in one run keep their own answers", async () => {
    const runDir = tempRunDir();
    let turn = 0;
    const counts = createFakeBackend({
      script: () => {
        turn += 1;
        return { act: reportsViaCli({ answer: turn === 1 ? "first" : "second" }) };
      },
    });
    const one = await runWorkflow(runDir, viaTrial(runDir, counts), sequence(["same", "same"]));

    const entries = await readJournal(runDir);
    expect(new Set(entries.map((entry) => entry.key)).size).toBe(2);
    expect(values(one.value)).toEqual([{ answer: "first" }, { answer: "second" }]);

    const second = echoes();
    const two = await runWorkflow(runDir, viaTrial(runDir, second), sequence(["same", "same"]));

    expect(two.stats).toEqual({ hits: 2, misses: 0 });
    expect(values(two.value)).toEqual([{ answer: "first" }, { answer: "second" }]);
  });

  test("a concurrent fan-out loses no entries", async () => {
    const runDir = tempRunDir();
    const lenses = Array.from({ length: 12 }, (_, index) => `lens ${index}`);
    // Finishing in the reverse of the order they started interleaves the appends, which is
    // where a read-modify-write journal drops one.
    const slow = createFakeBackend({
      script: async (context) => {
        const lens = Number(context.step.prompt.split(" ")[1]);
        await Bun.sleep(12 - lens);
        return { act: reportsViaCli({ answer: context.step.prompt }) };
      },
    });
    const fanOut = (agent: Agent) => Promise.all(lenses.map((lens) => agent(step(lens))));

    const one = await runWorkflow(runDir, viaTrial(runDir, slow), fanOut);

    const entries = await readJournal(runDir);
    expect(entries).toHaveLength(12);
    expect(new Set(entries.map((entry) => entry.key)).size).toBe(12);
    expect(entries.map((entry) => entry.index).sort((a, b) => a - b)).toEqual(
      lenses.map((_, index) => index),
    );
    expect(values(one.value)).toEqual(lenses.map((lens) => ({ answer: lens })));

    const second = echoes();
    const two = await runWorkflow(runDir, viaTrial(runDir, second), fanOut);

    expect(two.stats).toEqual({ hits: 12, misses: 0 });
    expect(second.opened).toHaveLength(0);
  });
});

describe("the key", () => {
  const keyOf = async (spec: Step): Promise<string> => {
    const journal = await openJournal(tempRunDir(), async () => ({
      kind: "failed",
      reason: "not run",
    }));
    return (await journal.call(spec)).key;
  };

  test("everything that changes the answer changes it", async () => {
    const base: Step = { prompt: "p", harness: "claude" };
    const variants: Step[] = [
      base,
      { ...base, prompt: "q" },
      { ...base, harness: "codex" },
      { ...base, model: "opus" },
      { ...base, backend: "pane" },
      { ...base, cwd: "/elsewhere" },
      { ...base, schema: { type: "string" } },
    ];

    const keys = await Promise.all(variants.map(keyOf));

    expect(new Set(keys).size).toBe(variants.length);
  });

  test("key order inside a schema is not a difference", async () => {
    const one = await keyOf({
      prompt: "p",
      harness: "claude",
      schema: { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
    });
    const two = await keyOf({
      prompt: "p",
      harness: "claude",
      schema: { required: ["a"], properties: { a: { type: "string" } }, type: "object" },
    });

    expect(one).toBe(two);
  });
});

describe("the journal entry", () => {
  test("a replayed call keeps the call id, so its recorded turn stays findable", async () => {
    const runDir = tempRunDir();
    const first = await openJournal(runDir, viaTrial(runDir, echoes()));
    const live = await first.call(step("a"));

    const second = await openJournal(runDir, viaTrial(runDir, echoes()));
    const replayed = await second.call(step("a"));

    expect(replayed.replayed).toBe(true);
    expect(replayed.callId).toBe(live.callId);
    expect(await Bun.file(`${runDir}/calls/${live.callId}/result.json`).exists()).toBe(true);
  });
});
