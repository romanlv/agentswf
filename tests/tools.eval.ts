import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ITEMS, RUNTIMES, type ToolsResult } from "../examples/tools/workflow";
import type { OutputRecord, RunLogLine } from "../packages/contract/src/records";
import { runOperatorCli } from "../packages/engine/src/operator-cli";
import { readCandidates, readEvents } from "../packages/engine/src/runs";
import { assertLiveOptIn, interruption } from "./live";

/**
 * Story 035's tools, live, from the lesson alone: every harness on its cheap model, in a pane and
 * headless but claude's, which headless is billed per token. Each agent lists the open items, a
 * tool with no input; labels one, a tool taught as JSON; closes both, a tool taught with flags, one
 * with a title holding `'` and `$HOME` as its reason; and returns its result with flags. `slow`
 * then makes `list_open` take longer than a harness lets a shell command run (M2): 15 s on codex,
 * which hands it back at 10 s, and 40 s on cursor, which backgrounds it at 30 s; its handler must run
 * once, with no refusal. Seven agents, about a minute; all but pi came to about $0.11 at list
 * prices. `slow` two more, about two minutes.
 */
const TOOLS = join(import.meta.dir, "../examples/tools/workflow.ts");
export const ALL = Object.keys(RUNTIMES);
const SLOW: [string, number][] = [
  ["codex", 15_000],
  ["cursor", 40_000],
];

async function run(workDir: string, argv: string[]) {
  const output: string[] = [];
  const exitCode = await runOperatorCli(
    ["run", "--run-root", join(workDir, "runs"), "--timeout", "8m", "--json", TOOLS, "--", ...argv],
    {
      cwd: workDir,
      signal: interruption(),
      stdout: (text) => output.push(text),
      stderr: (text) => console.error(text),
    },
  );
  const record = output.length > 0 ? (JSON.parse(output.join("\n")) as OutputRecord) : undefined;
  // Its own run's records: two runs started in the same minute don't sort by their start.
  const dir = record?.artifacts;
  const lines = dir ? await readEvents(dir) : [];
  const rejected = new Map<string, number>();
  for (const line of lines) {
    if (line.kind !== "operation-started") continue;
    const candidates = await readCandidates(dir!, line.operationId);
    rejected.set(line.operationId, candidates.filter((each) => !each.accepted).length);
  }
  return { exitCode, record, lines, rejected };
}

export function problems(
  exitCode: number,
  record: OutputRecord | undefined,
  runtimes: readonly string[],
): string[] {
  if (exitCode !== 0 || record?.outcome !== "completed") {
    return [`run did not succeed: exit ${exitCode}, outcome ${record?.outcome ?? "missing"}`];
  }
  const { triages } = record.value as ToolsResult;
  const found: string[] = [];
  for (const runtime of runtimes) {
    const triage = triages.find((each) => each.runtime === runtime);
    if (!triage) {
      found.push(`${runtime}: no triage`);
      continue;
    }
    const [logo, backup] = triage.items;
    if (triage.outcome !== "answered")
      found.push(`${runtime}: ${triage.outcome} ${triage.reason ?? ""}`);
    if (logo?.status !== "done") found.push(`${runtime}: logo item ${logo?.status}`);
    if (backup?.status !== "wontfix") found.push(`${runtime}: backup item ${backup?.status}`);
    if (backup?.why !== ITEMS[1]!.title)
      found.push(`${runtime}: backup reason ${JSON.stringify(backup?.why)}, not the title`);
    if (JSON.stringify([...(backup?.labels ?? [])].sort()) !== JSON.stringify(["cron", "ops"]))
      found.push(`${runtime}: backup labels ${JSON.stringify(backup?.labels)}`);
  }
  return found;
}

/**
 * A slow `list_open` must have run once, for at least `ms`, before the agent changed an item, with
 * no refusal; listing again after is the agent's choice.
 */
export function slowProblems(lines: readonly RunLogLine[], ms: number): string[] {
  const changed = lines.findIndex(
    (line) => line.kind === "tool-called" && line.tool !== "list_open",
  );
  const ended = lines
    .slice(0, changed === -1 ? undefined : changed)
    .flatMap((line) => (line.kind === "tool-ended" && line.tool === "list_open" ? [line] : []));
  const refused = lines.filter((line) => line.kind === "tool-refused");
  const found: string[] = [];
  if (ended.length !== 1) found.push(`list_open ran ${ended.length} times`);
  if (ended.some((line) => line.durationMs < ms)) found.push(`list_open ended before its ${ms} ms`);
  if (refused.length > 0)
    found.push(`refused: ${refused.map((line) => `${line.tool} ${line.code}`).join(", ")}`);
  return found;
}

/**
 * Per agent, what it got wrong first time: its tool calls refused or failed, and its results
 * rejected, from the run's records.
 */
export function firstTry(lines: readonly RunLogLine[], rejected: ReadonlyMap<string, number>) {
  const by = new Map<
    string,
    { calls: number; refused: string[]; failed: string[]; results: number }
  >();
  const entry = (agent: string) => {
    const found = by.get(agent) ?? { calls: 0, refused: [], failed: [], results: 0 };
    by.set(agent, found);
    return found;
  };
  for (const line of lines) {
    if (line.kind === "operation-started")
      entry(line.agent).results += rejected.get(line.operationId) ?? 0;
    if (line.kind === "tool-called") entry(line.agent).calls += 1;
    if (line.kind === "tool-refused") entry(line.agent).refused.push(`${line.tool}:${line.code}`);
    if (line.kind === "tool-ended" && line.outcome !== "ok")
      entry(line.agent).failed.push(`${line.tool}:${line.outcome}`);
  }
  return Object.fromEntries(by);
}

if (import.meta.main) {
  assertLiveOptIn();
  const picked = process.argv.slice(2);
  const unknown = picked.filter((name) => name !== "slow" && !ALL.includes(name));
  if (unknown.length > 0) {
    console.error(`unknown: ${unknown.join(", ")}; expected ${[...ALL, "slow"].join(", ")}`);
    process.exit(2);
  }
  const named = picked.filter((name) => name !== "slow");
  const runtimes = picked.length === 0 ? ALL : named;
  const workDir = await mkdtemp(join(tmpdir(), "awf-tools-"));
  const failed: string[] = [];
  const report: Record<string, unknown> = {};
  if (runtimes.length > 0) {
    const main = await run(workDir, runtimes);
    failed.push(...problems(main.exitCode, main.record, runtimes));
    report.firstTry = firstTry(main.lines, main.rejected);
    report.estimateUsd = main.record?.accounting.totals.estimate;
    report.artifacts = main.record?.artifacts;
  }
  if (picked.length === 0 || picked.includes("slow")) {
    const slow: Record<string, unknown> = {};
    for (const [runtime, ms] of SLOW) {
      const result = await run(workDir, [`--slow=${ms}`, runtime]);
      const found = [
        ...problems(result.exitCode, result.record, [runtime]),
        ...slowProblems(result.lines, ms),
      ];
      failed.push(...found.map((problem) => `slow ${runtime}: ${problem}`));
      slow[runtime] = { ms, firstTry: firstTry(result.lines, result.rejected), problems: found };
    }
    report.slow = slow;
  }
  console.log(JSON.stringify({ ok: failed.length === 0, failed, ...report }, null, 2));
  if (failed.length > 0) process.exitCode = 1;
}
