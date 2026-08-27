import { describe, expect, test } from "bun:test";
import {
  createFakeBackend,
  createManualClock,
  reportsRawViaCli,
  reportsViaCli,
  saysNothing,
  writesFile,
} from "./backends/fake";
import { readTrials } from "./deps";
import { expandMatrix, formatTally, runMatrix, tally, type MatrixSpec } from "./runner";
import type { TrialRecord } from "./trial";
import { COUNT_SCHEMA, tempRunDir } from "./deps";

const ANSWER = { count: 3, even: false };

const TASK = {
  question: "how many e's",
  prompt: "Count the letter e in 'agent terminal'.",
  schema: COUNT_SCHEMA,
};

const MATRIX: MatrixSpec = {
  harnesses: ["claude", "codex"],
  backends: ["pane", "headless"],
  methods: ["cli-callback", "write-a-file", "delimited-line"],
  trials: 20,
};

describe("expandMatrix", () => {
  test("covers every cell the requested number of times", () => {
    const specs = expandMatrix(MATRIX, { runId: "r", runDir: "/tmp/r", task: TASK });

    expect(specs).toHaveLength(2 * 2 * 3 * 20);
  });

  test("gives every trial its own call id", () => {
    const specs = expandMatrix(MATRIX, { runId: "r", runDir: "/tmp/r", task: TASK });

    expect(new Set(specs.map((spec) => spec.callId)).size).toBe(specs.length);
  });

  test("the call id names the cell, so a run directory is readable by eye", () => {
    const specs = expandMatrix(
      { harnesses: ["pi"], backends: ["headless"], methods: ["write-a-file"], trials: 2 },
      { runId: "r", runDir: "/tmp/r", task: TASK },
    );

    expect(specs.map((spec) => spec.callId)).toEqual([
      "pi-headless-write-a-file-1",
      "pi-headless-write-a-file-2",
    ]);
  });
});

describe("runMatrix", () => {
  test("a missing backend stops the run before any agent work", async () => {
    const specs = expandMatrix(
      { harnesses: ["claude"], backends: ["pane"], methods: ["cli-callback"], trials: 1 },
      { runId: "r", runDir: tempRunDir(), task: TASK },
    );

    await expect(runMatrix(specs, {})).rejects.toThrow("no backend supplied for pane");
  });

  test("each trial is written out as it finishes", async () => {
    const runDir = tempRunDir();
    const specs = expandMatrix(
      { harnesses: ["claude"], backends: ["headless"], methods: ["cli-callback"], trials: 3 },
      { runId: "r", runDir, task: TASK },
    );
    const backend = createFakeBackend({ script: () => ({ act: reportsViaCli(ANSWER) }) });

    await runMatrix(specs, { headless: backend });

    const written = await readTrials<TrialRecord>(runDir);
    expect(written.map((record) => record.callId)).toEqual(specs.map((spec) => spec.callId));
  });

  test("each cell runs against the backend it names", async () => {
    const runDir = tempRunDir();
    const specs = expandMatrix(
      {
        harnesses: ["claude"],
        backends: ["pane", "headless"],
        methods: ["cli-callback"],
        trials: 1,
      },
      { runId: "r", runDir, task: TASK },
    );
    const pane = createFakeBackend({
      kind: "pane",
      script: () => ({ act: reportsViaCli(ANSWER) }),
    });
    const headless = createFakeBackend({ script: () => ({ act: reportsViaCli(ANSWER) }) });

    await runMatrix(specs, { pane, headless });

    expect(pane.opened.map((entry) => entry.callId)).toEqual(["claude-pane-cli-callback-1"]);
    expect(headless.opened.map((entry) => entry.callId)).toEqual([
      "claude-headless-cli-callback-1",
    ]);
  });
});

describe("tally", () => {
  async function run(scripts: ("reports" | "nudge" | "silent")[]) {
    const runDir = tempRunDir();
    const specs = expandMatrix(
      {
        harnesses: ["claude"],
        backends: ["headless"],
        methods: ["cli-callback"],
        trials: scripts.length,
      },
      { runId: "r", runDir, task: TASK },
    );
    const clock = createManualClock();
    const behaviour = new Map(specs.map((spec, index) => [spec.callId, scripts[index]!]));
    const backend = createFakeBackend({
      clock,
      script: ({ callId, turn }) => {
        const script = behaviour.get(callId);
        if (script === "reports") return { act: reportsViaCli(ANSWER), durationMs: 1_000 };
        if (script === "nudge" && turn === 2) {
          return { act: reportsViaCli(ANSWER), durationMs: 1_000 };
        }
        return { act: saysNothing(), durationMs: 1_000 };
      },
    });
    return tally(await runMatrix(specs, { headless: backend }, { now: clock.now }));
  }

  test("separates reported, recovered, and lost", async () => {
    const [cell] = await run(["reports", "reports", "nudge", "silent"]);

    expect(cell).toMatchObject({
      trials: 4,
      unprompted: 2,
      nudged: 1,
      lost: 1,
      unpromptedRate: 0.5,
      deliveryRate: 0.75,
    });
  });

  test("the delivery rate is what the 95% gate is read against, nudges included", async () => {
    const [cell] = await run(["nudge", "nudge", "nudge", "nudge"]);

    expect(cell?.deliveryRate).toBe(1);
    expect(cell?.unpromptedRate).toBe(0);
  });

  test("an in-turn correction is counted apart from a rejection that survived the turn", async () => {
    const runDir = tempRunDir();
    const specs = expandMatrix(
      { harnesses: ["claude"], backends: ["headless"], methods: ["cli-callback"], trials: 2 },
      { runId: "r", runDir, task: TASK },
    );
    const backend = createFakeBackend({
      script: ({ callId }) =>
        callId.endsWith("-1")
          ? {
              act: async (context) => {
                await reportsRawViaCli('{"count":"3","even":false}')!(context);
                await reportsViaCli(ANSWER)!(context);
              },
            }
          : { act: reportsRawViaCli('{"count":"3","even":false}') },
    });

    const [cell] = tally(await runMatrix(specs, { headless: backend }));

    expect(cell).toMatchObject({
      correctedFirst: 1,
      malformedFirst: 1,
      unprompted: 1,
      lost: 1,
      deliveryRate: 0.5,
    });
  });

  test("median wall clock ignores the order trials ran in", async () => {
    const [cell] = await run(["reports", "nudge", "reports"]);

    // one turn each for the two clean trials, two for the nudged one
    expect(cell?.medianWallClockMs).toBe(1_000);
  });

  test("cells are kept apart", async () => {
    const runDir = tempRunDir();
    const specs = expandMatrix(
      {
        harnesses: ["claude"],
        backends: ["headless"],
        methods: ["cli-callback", "write-a-file"],
        trials: 1,
      },
      { runId: "r", runDir, task: TASK },
    );
    // Writes the file every turn: only the cell collecting from a file should see a value.
    const backend = createFakeBackend({ script: () => ({ act: writesFile(ANSWER) }) });

    const cells = tally(await runMatrix(specs, { headless: backend }));

    expect(cells.map((cell) => `${cell.method}:${cell.unprompted}`)).toEqual([
      "cli-callback:0",
      "write-a-file:1",
    ]);
  });
});

describe("formatTally", () => {
  test("renders one row per cell under a header", async () => {
    const runDir = tempRunDir();
    const specs = expandMatrix(
      { harnesses: ["claude"], backends: ["headless"], methods: ["cli-callback"], trials: 2 },
      { runId: "r", runDir, task: TASK },
    );
    const backend = createFakeBackend({ script: () => ({ act: reportsViaCli(ANSWER) }) });

    const text = formatTally(tally(await runMatrix(specs, { headless: backend })));
    const lines = text.split("\n");

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("delivered");
    expect(lines[1]).toContain("claude");
    expect(lines[1]).toContain("100%");
  });
});
