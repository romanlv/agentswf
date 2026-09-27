import { describe, expect, test } from "bun:test";
import type { ProbeReport } from "../examples/sandbox-probe/workflow";
import type { OutputRecord } from "../packages/contract/src/records";
import { type ProbeEvidence, problems } from "./sandbox-probe";

const canaries = [
  { path: "/Users/op/.awf-canary", token: "canary-home" },
  { path: "/tmp/awf-canary", token: "canary-tmp" },
];
const planted = {
  plan: {
    environment: "srt" as const,
    network: [],
    commands: { coder: [], tester: [], reviewer: [] },
  },
  canaries,
  listenerToken: "listener-token",
  homeToken: "home-token",
  allowed: "allowed-token",
  shared: "shared-token",
};

/** What an agent's harness records of a probe whose every command the sandbox refused. */
const transcript = [
  ...canaries.map(({ path }) => `{"output":"cat: ${path}: Operation not permitted"}`),
  '{"output":"sh: .git/hooks/pre-commit: Operation not permitted"}',
].join("\n");

function report(agent: ProbeReport["agent"], extra: { command: string; output: string }[] = []) {
  return {
    agent,
    outcome: "answered" as const,
    webSearch: "none",
    results: [
      { command: "cat allowed.txt", output: "allowed-token\n", exitCode: 0 },
      { command: "curl https://registry.npmjs.org/", output: "200", exitCode: 0 },
      { command: "curl https://pypi.org/", output: "000", exitCode: 56 },
      ...extra.map((result) => ({ ...result, exitCode: 0 })),
    ],
  };
}

function passing(): ProbeEvidence {
  const sandbox = (key: string, agents: string[]) => ({
    callPath: [],
    key,
    provider: "srt",
    spec: { cwd: "/repo", read: [], write: [], network: [] },
    directory: `/runs/${key}`,
    gitdirs: [],
    domains: [],
    agents: agents.map((agent) => ({ callPath: [], agent, home: `/runs/${key}/homes/${agent}` })),
  });
  const figures = (agent: string) => ({
    agent,
    agents: 1,
    known: 1,
    tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
  });
  const record = {
    outcome: "succeeded",
    value: {
      reports: [
        report("coder"),
        report("tester", [{ command: "cat shared-note.txt", output: "shared-token" }]),
        report("reviewer"),
      ],
    },
    sandboxes: [sandbox("shared", ["coder", "tester"]), sandbox("agent:reviewer", ["reviewer"])],
    accounting: { byAgent: ["coder", "tester", "reviewer"].map(figures) },
  } as unknown as OutputRecord;
  return {
    environment: "srt",
    exitCode: 0,
    record,
    planted,
    transcripts: { coder: `${transcript}\nhome-token`, tester: transcript, reviewer: transcript },
    before: { "allowed.txt": "a" },
    after: { "allowed.txt": "a", "shared-note.txt": "b" },
    hits: 0,
    proxyLogs: [],
    secretsLeft: [],
    leftovers: 0,
  };
}

describe("the sandbox probe's checks", () => {
  test("a run whose agents were refused everything they should be passes", () => {
    expect(problems(passing())).toEqual([]);
  });

  test("an agent that did not run a command is caught by its transcript, not its word", () => {
    const evidence = passing();
    evidence.transcripts.tester = transcript.replace("/tmp/awf-canary: Operation", "elsewhere");
    expect(problems(evidence)).toEqual([
      "srt: tester: no refusal of /tmp/awf-canary in its transcript",
    ]);
  });

  test.each<[string, (evidence: ProbeEvidence) => void, string]>([
    [
      "a canary read",
      (e) => {
        e.transcripts.coder += "canary-tmp";
      },
      "canary canary-tmp reached",
    ],
    [
      "another sandbox's home read",
      (e) => {
        e.transcripts.reviewer += "home-token";
      },
      "the reviewer read a home in another sandbox",
    ],
    [
      "a web search",
      (e) => {
        e.transcripts.tester += '"name":"WebSearch"';
      },
      "searched the web from the model's side",
    ],
    [
      "the listener reached",
      (e) => {
        e.hits = 1;
      },
      "listener was reached 1 times",
    ],
    [
      "the working directory changed",
      (e) => {
        e.after["reviewer-note.txt"] = "c";
      },
      "the working directory changed: reviewer-note.txt",
    ],
    [
      "no transcript",
      (e) => {
        e.transcripts.reviewer = "";
      },
      "reviewer: no transcript in its home",
    ],
    [
      "an agent missing from accounting",
      (e) => {
        (e.record as { accounting: { byAgent: unknown[] } }).accounting.byAgent.pop();
      },
      "accounting has coder, tester",
    ],
  ])("flags %s", (_name, spoil, problem) => {
    const evidence = passing();
    spoil(evidence);
    expect(problems(evidence).join("\n")).toContain(problem);
  });

  test("pane agents must have been refused the run's Herdr, and leave nothing behind", () => {
    const evidence = passing();
    evidence.planted = { ...planted, plan: { ...planted.plan, panes: ["coder"] } };
    expect(problems(evidence)).toEqual(["srt: coder: did not try the run's Herdr"]);
    const coder = (
      evidence.record as unknown as { value: { reports: ReturnType<typeof report>[] } }
    ).value.reports[0]!;
    coder.results.push({ command: "herdr pane list", output: '{"pane_id":"w1:p1"}', exitCode: 0 });
    expect(problems(evidence)).toEqual(["srt: coder: reached the run's Herdr"]);
    coder.results.at(-1)!.output = "error: Operation not permitted";
    expect(problems({ ...evidence, secretsLeft: ["/home/a"], leftovers: 2 })).toEqual([
      "srt: secrets left in /home/a",
      "srt: 2 processes of the run still running",
    ]);
  });

  test("under docker, the proxy must have logged its refusal", () => {
    const evidence = { ...passing(), environment: "docker" as const };
    for (const key of ["coder", "tester", "reviewer"] as const) {
      evidence.transcripts[key] = evidence.transcripts[key]!.replaceAll(
        "Operation not permitted",
        "No such file or directory",
      );
    }
    for (const sandbox of evidence.record!.sandboxes!) sandbox.provider = "docker";
    expect(problems(evidence)).toEqual(["docker: no proxy logged its refusal"]);
    expect(problems({ ...evidence, proxyLogs: ["deny pypi.org:443"] })).toEqual([]);
  });
});
