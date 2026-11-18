import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type EnvValue, TRIAL_ENV, type TrialSettings } from "../format/trial-env";
import type { TrialLine } from "../format/trial-file";
import { blame, readTrialLines } from "../lab/blame";

// End to end: a fixture workflow and its env.ts, run by this checkout's own `awf run` with the
// lab's preload, as a trial is. No agents, no cost.

const REPO = join(import.meta.dir, "../../../../..");
const AWF = join(REPO, "packages/agentswf/src/awf.ts");
const FETCH = join(import.meta.dir, "fetch.ts");
const FIXTURES = join(import.meta.dir, "fixtures");
const base = mkdtempSync(join(tmpdir(), "awf-lab-env-"));

type Trial = {
  exitCode: number;
  stdout: string;
  /** The trial file, as written. */
  file: string;
  outcome?: string;
  value?: EnvValue;
  lines: TrialLine[];
  cleaned: boolean;
};

type Run = {
  env?: string;
  input?: Record<string, unknown>;
  settings?: Partial<TrialSettings>;
  /** The trial's parameters, as `--param` and `--vary` give them. */
  params?: Record<string, string>;
  /** Run without the lab's variables, as a person running env.ts by hand would. */
  bare?: boolean;
  /** Sent to the trial's process once its body has begun. */
  signal?: "SIGTERM" | "SIGINT";
};

let count = 0;
async function trial(run: Run): Promise<Trial> {
  const dir = join(base, String(++count));
  const [caseDir, scratch, store] = ["case", "scratch", "store"].map((name) => join(dir, name));
  for (const each of [caseDir!, scratch!, store!]) mkdirSync(each, { recursive: true });
  writeFileSync(join(caseDir!, "input.json"), JSON.stringify(run.input ?? {}));
  const trialFile = join(dir, "trial.jsonl");
  const settings: TrialSettings = {
    dataset: "fixture",
    timeoutMs: 20_000,
    setupTimeoutMs: 10_000,
    realHosts: [],
    ...run.settings,
  };
  const env: Record<string, string | undefined> = { ...process.env };
  for (const name of Object.values(TRIAL_ENV)) delete env[name];
  if (!run.bare) {
    Object.assign(env, {
      [TRIAL_ENV.case]: caseDir,
      [TRIAL_ENV.trial]: trialFile,
      [TRIAL_ENV.scratch]: scratch,
      [TRIAL_ENV.root]: REPO,
      [TRIAL_ENV.settings]: JSON.stringify(settings),
      ...(run.params ? { [TRIAL_ENV.params]: JSON.stringify(run.params) } : {}),
    });
  }
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "--preload",
      FETCH,
      AWF,
      "run",
      "--json",
      "--quiet",
      "--cwd",
      scratch!,
      "--run-root",
      store!,
      "--timeout",
      "2m",
      join(FIXTURES, run.env ?? "env.ts"),
    ],
    { cwd: REPO, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" },
  );
  if (run.signal) {
    const signal = run.signal;
    void (async () => {
      for (let waited = 0; waited < 20_000; waited += 50) {
        if (existsSync(trialFile) && readFileSync(trialFile, "utf8").includes('"phase":"body"')) {
          child.kill(signal);
          return;
        }
        await Bun.sleep(50);
      }
    })();
  }
  const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  let record: { outcome?: string; value?: EnvValue } = {};
  try {
    record = JSON.parse(stdout);
  } catch {}
  const lines = existsSync(trialFile)
    ? readFileSync(trialFile, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as TrialLine)
    : [];
  return {
    exitCode,
    stdout,
    file: trialFile,
    ...(record.outcome ? { outcome: record.outcome } : {}),
    ...(record.value ? { value: record.value } : {}),
    lines,
    cleaned: existsSync(join(scratch!, "cleaned")),
  };
}

const phases = (t: Trial) => t.lines.flatMap((line) => ("phase" in line ? [line.phase] : []));
const errorOf = (t: Trial) => t.lines.flatMap((line) => ("error" in line ? [line.error] : []))[0];
const refusedOf = (t: Trial) =>
  t.lines.flatMap((line) => ("refused" in line ? [line.refused] : []));
const endOf = (t: Trial) => t.lines.flatMap((line) => ("end" in line ? [line.end] : []))[0];
const unusedOf = (t: Trial) =>
  t.lines.flatMap((line) => ("unused" in line ? [line.unused] : []))[0];
const timedOutOf = (t: Trial) =>
  t.lines.flatMap((line) => ("timedOut" in line ? [line.timedOut] : []))[0];

const real = Bun.serve({
  port: 0,
  fetch: async (request) =>
    new Response(request.method === "POST" ? `got ${await request.text()}` : "real"),
});

const runs = {
  plain: { input: { scenario: "plain", argv: ["plain"] } },
  params: { input: { scenario: "plain", argv: ["plain"] }, params: { model: "b", tz: "utc" } },
  catchRefused: { input: { scenario: "plain", argv: ["catch-refused"] } },
  fetch: {
    input: {
      scenario: "fetch",
      argv: [
        "fetch",
        "https://api.test/items/7",
        "https://api.test/nope",
        "https://elsewhere.test/x",
        `http://localhost:${real.port}/real`,
      ],
    },
    settings: { realHosts: ["localhost"] },
  },
  fake: { input: { scenario: "plain", argv: ["fake", "close"] } },
  nothingToSend: { input: { scenario: "nothing-to-send", argv: ["plain"] } },
  class: { input: { scenario: "plain", argv: ["class"] } },
  given: { input: { scenario: "plain", argv: ["plain"], given: { gather: ["g1", "g2"] } } },
  givenRefused: { input: { scenario: "plain", argv: ["plain"], given: { gather: [1, 2] } } },
  until: { input: { scenario: "plain", argv: ["plain"], until: "gather" } },
  swallow: { input: { scenario: "plain", argv: ["swallow"], until: "gather" } },
  stopAfter: { input: { scenario: "plain", argv: ["stop-after"], until: "gather" } },
  misspelled: { input: { scenario: "plain", argv: ["plain"], until: "gahter" } },
  early: { input: { scenario: "plain", argv: ["early"], until: "decide" } },
  throws: { input: { scenario: "plain", argv: ["throw"], until: "decide" } },
  setupThrows: { input: { scenario: "setup-throws", argv: ["plain"] } },
  setupSlow: {
    input: { scenario: "setup-slow", argv: ["plain"] },
    settings: { setupTimeoutMs: 300 },
  },
  bodySlow: { input: { scenario: "plain", argv: ["slow"] }, settings: { timeoutMs: 500 } },
  mockNode: { input: { scenario: "mock-node", argv: ["plain"] } },
  factsNull: { input: { scenario: "plain", argv: ["plain"], facts: "null" } },
  factsUndefined: { input: { scenario: "plain", argv: ["early"], facts: "undefined" } },
  factsObject: { input: { scenario: "plain", argv: ["plain"], facts: "object" } },
  prepare: { input: { scenario: "plain", argv: ["bad"] } },
  events: { env: "events.env.ts" },
  loadedEarly: { env: "early.env.ts" },
  located: { env: "located.env.ts" },
  missing: { env: "missing.env.ts" },
  bare: { bare: true },
  rootedLoaded: { env: "rooted/env.ts" },
  rootedDataset: {
    env: "rooted/env.ts",
    input: { until: "decidee" },
    settings: { datasetDir: join(FIXTURES, "rooted") },
  },
  cancelTerm: { input: { scenario: "plain", argv: ["slow"] }, signal: "SIGTERM" },
  cancelInt: { input: { scenario: "plain", argv: ["slow"] }, signal: "SIGINT" },
  exits: { input: { scenario: "plain", argv: ["exit"] } },
  post: {
    input: { scenario: "plain", argv: ["post", `http://localhost:${real.port}/echo`] },
    settings: { realHosts: ["localhost"] },
  },
  refusedFailed: { input: { scenario: "plain", argv: ["catch-refused-throw"] } },
  refusedTimedOut: {
    input: { scenario: "plain", argv: ["catch-refused-slow"] },
    settings: { timeoutMs: 1_500 },
  },
} satisfies Record<string, Run>;

const results = {} as Record<keyof typeof runs, Trial>;

beforeAll(async () => {
  await Promise.all(
    Object.entries(runs).map(async ([name, run]) => {
      results[name as keyof typeof runs] = await trial(run);
    }),
  );
}, 120_000);

afterAll(() => {
  real.stop(true);
  rmSync(base, { recursive: true, force: true });
});

describe("a trial that completes", () => {
  test("c.params holds the trial's parameters, {} without them", () => {
    expect(endOf(results.params)?.facts.params).toBe(JSON.stringify({ model: "b", tz: "utc" }));
    expect(endOf(results.plain)?.facts.params).toBe("{}");
  });

  test("writes each phase, the workflow, unused fakes and the facts, and returns the value", () => {
    const t = results.plain;
    expect(t.exitCode).toBe(0);
    expect(phases(t)).toEqual(["setup", "body", "observe", "teardown"]);
    expect(t.lines).toContainEqual({ workflow: { name: "case-fixture", version: "1.2.0" } });
    expect(endOf(t)).toEqual({
      facts: {
        count: 2,
        notes: "",
        sends: 2,
        gathered: '["a","b"]',
        requests: "",
        none: "x",
        params: "{}",
      },
      stages: { gather: ["a", "b"], decide: { count: 2, sent: ["a", "b"] } },
      given: [],
    });
    expect(t.value?.result).toEqual({ mode: "plain", count: 2, sent: ["a", "b"], notes: [] });
    expect(t.value?.refused).toEqual([]);
    expect(t.cleaned).toBe(true);
  });

  test("lists fakes and routes never called, refusing stand-ins left out", () => {
    expect(unusedOf(results.plain)).toEqual([
      "service.connect",
      "service.client.ping",
      "fake.query",
      "GET https://api.test/items/:id",
      "POST https://api.test/forms",
    ]);
    expect(results.plain.value?.unused).toEqual(unusedOf(results.plain));
  });

  test("leaves out a mock never called whose .mock.calls observe read", () => {
    const t = results.nothingToSend;
    expect(endOf(t)?.facts.sends).toBe(0);
    expect(unusedOf(t)).not.toContain("service.send");
  });

  test("a workflow that gives its own file runs", () => {
    expect(results.located.exitCode).toBe(0);
    expect(endOf(results.located)?.facts).toEqual({ located: true });
  });

  test("a fact null is kept as null", () => {
    expect(results.factsNull.exitCode).toBe(0);
    expect(endOf(results.factsNull)?.facts.none).toBeNull();
  });
});

describe("refused calls", () => {
  test("a strict mock refuses an export not given, recorded even though the workflow caught it", () => {
    const t = results.catchRefused;
    expect(t.exitCode).toBe(0);
    expect(t.value?.result).toMatchObject({
      notes: [
        "no fake for service.remove in this case: fake it, or name it in `real` if it is a pure helper",
      ],
    });
    expect(refusedOf(t)).toEqual([
      {
        what: "service.remove",
        by: "function",
        phase: "body",
        message:
          "no fake for service.remove in this case: fake it, or name it in `real` if it is a pure helper",
      },
    ]);
    expect(errorOf(t)).toMatchObject({ by: "dataset", phase: "body", code: "refused" });
    expect(t.value?.refused).toHaveLength(1);
  });

  test("fetch: a route answers, an unmatched routed host and an unknown host are refused, realHosts pass", () => {
    const t = results.fetch;
    expect(t.value?.result).toMatchObject({
      notes: [
        '200 {"id":"7"}',
        "refused: no route for GET https://api.test/nope in this case: add one to c.http",
        "refused: reached elsewhere.test: add a route, or list it in realHosts",
        "200 real",
      ],
    });
    expect(refusedOf(t).map(({ what, by, phase }) => ({ what, by, phase }))).toEqual([
      { what: "GET https://api.test/nope", by: "host", phase: "body" },
      { what: "GET https://elsewhere.test/x", by: "host", phase: "body" },
    ]);
    expect(errorOf(t)).toMatchObject({ by: "dataset", code: "refused" });
    expect(endOf(t)?.facts.requests).toBe(
      [
        "GET https://api.test/items/7",
        "GET https://api.test/nope",
        "GET https://elsewhere.test/x",
        `GET http://localhost:${real.port}/real`,
      ].join("|"),
    );
    expect(unusedOf(t)).toContain("POST https://api.test/forms");
    expect(unusedOf(t)).not.toContain("GET https://api.test/items/:id");
  });

  test("a c.fake from async () => db is awaited; a member not given is refused", () => {
    const t = results.fake;
    expect(t.value?.result).toMatchObject({
      notes: ["row", "db1", "no fake for fake.close in this case: fake it"],
    });
    expect(refusedOf(t).map((each) => each.what)).toEqual(["fake.close"]);
    expect(unusedOf(t)).not.toContain("service.connect");
  });

  test("a strictly mocked module's class still works with instanceof, and a real helper runs", () => {
    expect(results.class.value?.result).toMatchObject({ notes: ["true", "a+b"] });
    expect(refusedOf(results.class)).toEqual([]);
  });
});

describe("stages", () => {
  test("a given stage runs none of its work, and the stage after it runs live", () => {
    const t = results.given;
    expect(t.exitCode).toBe(0);
    expect(endOf(t)?.stages).toEqual({
      gather: ["g1", "g2"],
      decide: { count: 2, sent: ["g1", "g2"] },
    });
    expect(endOf(t)?.given).toEqual(["gather"]);
    expect(unusedOf(t)).toContain("service.list");
  });

  test("a given value its schema refuses errors the trial as the dataset's", () => {
    const t = results.givenRefused;
    expect(t.exitCode).toBe(1);
    expect(errorOf(t)).toMatchObject({ by: "dataset", phase: "body", code: "given-refused" });
  });

  test("until completes the run once the stage returned, observe given its value", () => {
    const t = results.until;
    expect(t.exitCode).toBe(0);
    expect(t.value?.result).toBeNull();
    expect(endOf(t)).toMatchObject({
      until: "gather",
      stages: { gather: ["a", "b"] },
      facts: { count: null, sends: 0 },
    });
    expect(endOf(t)?.neverReached).toBeUndefined();
  });

  test("a workflow that swallows the signal gets it again at its next stage, and completes at until", () => {
    const t = results.swallow;
    expect(t.exitCode).toBe(0);
    expect(endOf(t)).toMatchObject({ until: "gather", stages: { gather: ["a", "b"] } });
  });

  test("a wf.stop after until writes the facts and passes through", () => {
    const t = results.stopAfter;
    expect(t.outcome).toBe("stopped");
    expect(endOf(t)).toMatchObject({ until: "gather", stages: { gather: ["a", "b"] } });
    expect(t.lines).toContainEqual({ stopped: { reason: "enough" } });
  });

  test("a misspelled stage errors as stage-missing before the body runs", () => {
    const t = results.misspelled;
    expect(t.exitCode).toBe(1);
    expect(errorOf(t)).toMatchObject({ by: "dataset", phase: "body", code: "stage-missing" });
    expect(errorOf(t)?.reason).toContain("gahter");
    expect(t.lines.some((line) => "end" in line)).toBe(false);
  });

  test("a body that returns before until is graded on its result, noted never reached", () => {
    const t = results.early;
    expect(t.exitCode).toBe(0);
    expect(t.value?.result).toMatchObject({ notes: ["nothing to do"] });
    expect(endOf(t)?.neverReached).toEqual(["decide"]);
    expect(endOf(t)?.until).toBeUndefined();
  });

  test("a workflow that throws before until fails as the workflow's", () => {
    const t = results.throws;
    expect(t.exitCode).toBe(1);
    expect(errorOf(t)).toEqual({ by: "workflow", phase: "body", reason: "the workflow broke" });
    expect(t.cleaned).toBe(true);
  });
});

describe("whose error", () => {
  test("setup throwing is the dataset's, and teardown still runs", () => {
    const t = results.setupThrows;
    expect(t.exitCode).toBe(1);
    expect(errorOf(t)).toEqual({
      by: "dataset",
      phase: "setup",
      code: "threw",
      reason: "setup broke",
    });
    expect(t.cleaned).toBe(true);
  });

  test("setup timing out writes the line, and runs teardown", () => {
    const t = results.setupSlow;
    expect(timedOutOf(t)).toBe("setup");
    expect(t.cleaned).toBe(true);
    expect(phases(t)).not.toContain("body");
  });

  test("the body timing out writes the line, writes no facts, and runs teardown", () => {
    const t = results.bodySlow;
    expect(t.exitCode).toBe(1);
    expect(timedOutOf(t)).toBe("body");
    expect(endOf(t)).toBeUndefined();
    expect(t.cleaned).toBe(true);
  });

  test("c.mock of a node: module is refused", () => {
    expect(errorOf(results.mockNode)).toMatchObject({ by: "dataset", phase: "setup" });
    expect(errorOf(results.mockNode)?.reason).toContain("c.mock refuses node:fs");
  });

  test("an undefined fact is facts-missing, an object fact-type", () => {
    expect(errorOf(results.factsUndefined)).toMatchObject({
      by: "dataset",
      phase: "observe",
      code: "facts-missing",
    });
    expect(errorOf(results.factsObject)).toMatchObject({
      by: "dataset",
      phase: "observe",
      code: "fact-type",
    });
  });

  test("the workflow's prepare refusing the argv is the dataset's", () => {
    expect(errorOf(results.prepare)).toMatchObject({ by: "dataset", code: "prepare" });
  });

  test("a workflow with events is refused", () => {
    expect(errorOf(results.events)).toMatchObject({ by: "dataset", code: "events" });
  });

  test("a workflow env.ts imported before setup is refused", () => {
    expect(errorOf(results.loadedEarly)).toMatchObject({
      by: "dataset",
      code: "workflow-loaded-early",
    });
  });

  test("a workflow module that doesn't exist is the dataset's", () => {
    expect(errorOf(results.missing)).toMatchObject({ by: "dataset", code: "workflow-missing" });
  });

  test("env.ts run without the lab is refused, saying how to run it", () => {
    const t = results.bare;
    expect(t.exitCode).toBe(2);
    expect(t.stdout).toContain("awf-lab run");
    expect(t.lines).toEqual([]);
  });
});

describe("stage names are looked for in the workflow's source only", () => {
  test("a name env.ts itself holds, loaded before setup, is still missing", () => {
    const t = results.rootedLoaded;
    expect(errorOf(t)).toMatchObject({ by: "dataset", code: "stage-missing" });
    expect(errorOf(t)?.reason).toContain("gahter");
  });

  test("a name only a dataset file holds, never loaded, is still missing", () => {
    const t = results.rootedDataset;
    expect(errorOf(t)).toMatchObject({ by: "dataset", code: "stage-missing" });
    expect(errorOf(t)?.reason).toContain("decidee");
  });
});

describe("a cancel, and an exit short of the deadline", () => {
  for (const name of ["cancelTerm", "cancelInt"] as const) {
    test(`${name === "cancelTerm" ? "SIGTERM" : "SIGINT"}: the cancel is recorded, teardown runs, and no timeout is written`, () => {
      const t = results[name];
      expect(t.lines).toContainEqual({ cancelled: "body" });
      expect(timedOutOf(t)).toBeUndefined();
      expect(t.cleaned).toBe(true);
      const blamed = blame(t.lines, {
        stderr: "",
        loginRefused: false,
        ...(t.outcome ? { outcome: t.outcome } : {}),
      });
      expect(blamed.errored).toMatchObject({ by: "lab", phase: "body" });
    });
  }

  test("process.exit in the body writes an exit, not a timeout, and teardown still runs", () => {
    const t = results.exits;
    expect(t.lines).toContainEqual({ exited: "body" });
    expect(timedOutOf(t)).toBeUndefined();
    expect(t.cleaned).toBe(true);
  });
});

test("fetch: a stream body and a built Request reach a real host whole", () => {
  expect(results.post.value?.result).toMatchObject({ notes: ["got streamed", "got built"] });
});

describe("refused calls reach the lab on a run that failed or timed out", () => {
  for (const name of ["refusedFailed", "refusedTimedOut"] as const) {
    test(name === "refusedFailed" ? "failed" : "timed out", () => {
      const t = results[name];
      expect(t.exitCode).not.toBe(0);
      expect(refusedOf(t)).toEqual([
        {
          what: "service.remove",
          by: "function",
          phase: "body",
          message:
            "no fake for service.remove in this case: fake it, or name it in `real` if it is a pure helper",
        },
      ]);
      const { lines, bad } = readTrialLines(readFileSync(t.file, "utf8"));
      expect(bad).toBe(0);
      const blamed = blame(lines, {
        stderr: "",
        loginRefused: false,
        ...(t.outcome ? { outcome: t.outcome } : {}),
      });
      expect(blamed.errored).toMatchObject({ by: "dataset", phase: "body", code: "refused" });
      expect(blamed.refused).toHaveLength(1);
    });
  }
  test("the timed-out one timed out", () => {
    expect(timedOutOf(results.refusedTimedOut)).toBe("body");
  });
});
