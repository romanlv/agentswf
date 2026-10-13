// M2: does each harness, placement and model use --await-reply as the gate needs, live on the built wf?
// bun run.ts {runtime} {pairs per run} {runs}; writes results/{runtime}-{n}.json, one per run.
// biome-ignore-all lint/suspicious/noExplicitAny: a throwaway reading untyped JSON records
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OutputRecord, RunLogLine } from "../../packages/contract/src/records";
import { canAwaitReply } from "../../packages/engine/src/messaging/limits";
import { runOperatorCli } from "../../packages/engine/src/operator-cli";
import { PAYMENTS, RUNTIMES } from "./workflow";

const [runtime = "codex", pairsArg = "5", runsArg = "1"] = process.argv.slice(2);
if (!Object.hasOwn(RUNTIMES, runtime)) throw new Error(`unknown runtime ${runtime}`);
const RESULTS = join(import.meta.dir, "results", process.env.RESULTS ?? "main");
mkdirSync(RESULTS, { recursive: true });

const lines = (text: string) =>
  text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
const read = (path: string) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
};

async function cli(argv: string[], cwd: string): Promise<{ code: number; out: string }> {
  const out: string[] = [];
  const code = await runOperatorCli(argv, {
    cwd,
    stdout: (text) => out.push(text),
    stderr: () => undefined,
    // On for what M2 measures, as the gate would turn it on.
    awaitReply: (execution, confirms) =>
      canAwaitReply(execution, confirms, {
        claude: { headless: true, pane: "confirmed" },
        codex: { headless: true },
        pi: { headless: true },
        cursor: { headless: true },
      }),
  });
  return { code, out: out.join("\n") };
}

for (let run = 1; run <= Number(runsArg); run++) {
  const work = mkdtempSync(join(tmpdir(), "awf-m2-"));
  mkdirSync(join(work, "src"));
  writeFileSync(join(work, "src", "payments.ts"), PAYMENTS);
  Bun.spawnSync(["git", "init", "-q", work]);
  const runRoot = join(work, "runs");
  const started = Date.now();
  const { code, out } = await cli(
    [
      "run",
      "--run-root",
      runRoot,
      "--timeout",
      "12m",
      "--json",
      join(import.meta.dir, "workflow.ts"),
      "--",
      runtime,
      pairsArg,
    ],
    work,
  );
  let record: OutputRecord | undefined;
  try {
    record = JSON.parse(out) as OutputRecord;
  } catch {}
  const dir = record?.artifacts;
  const log: RunLogLine[] = dir ? lines(read(join(dir, "turns.jsonl"))) : [];
  const liveness = (op: string) => lines(read(join(dir ?? "", "calls", op, "liveness.jsonl")));
  const trials = [];
  for (let index = 1; index <= Number(pairsArg); index++) {
    const planner = `planner:${index}`;
    const architect = `architect:${index}`;
    const ops = (agent: string) =>
      log
        .filter((l: any) => l.kind === "operation-started" && l.agent === agent)
        .map((l: any) => l.operationId);
    const [plannerOp] = ops(planner);
    const architectOps = ops(architect);
    const logs = await cli(
      [
        "logs",
        record?.runId ? `m2-messaging/${record.runId}` : "",
        "--run-root",
        runRoot,
        "--agent",
        planner,
        "--limit",
        "1000",
        "--json",
      ].filter(Boolean),
      work,
    );
    let activity: any[] = [];
    try {
      activity = JSON.parse(logs.out).events.filter((e: any) => e.kind === "activity");
    } catch {}
    const tools = activity
      .filter((e: any) => e.activity.type === "tool")
      .map((e: any) => `${e.activity.tool} ${e.activity.input ?? ""}`);
    const plannerLive = plannerOp ? liveness(plannerOp) : [];
    trials.push({
      index,
      result: (record?.outcome === "completed" ? (record.value as any[]) : []).find(
        (t) => t.key === planner,
      ),
      sent: log
        .filter((l: any) => l.kind === "message-sent" && l.from === planner)
        .map((l: any) => ({ to: l.to, awaits: !!l.awaitsReply, replyTo: l.replyTo })),
      refused: log
        .filter(
          (l: any) => l.kind === "message-refused" && (l.from === planner || l.from === architect),
        )
        .map((l: any) => `${l.from} ${l.command} ${l.code}`),
      request: log
        .filter((l: any) => l.kind === "request-ended" && l.asker === planner)
        .map((l: any) => l.end),
      architectSent: log
        .filter((l: any) => l.kind === "message-sent" && l.from === architect)
        .map((l: any) => ({ to: l.to, replyTo: l.replyTo })),
      plannerPhases: plannerLive.map(
        (l: any) => l.kind + (l.reason && l.kind === "continued" ? `:${l.reason}` : ""),
      ),
      architectReminded: architectOps.some((op: string) =>
        liveness(op).some((l: any) => l.kind === "reminder-due"),
      ),
      architectOperations: architectOps.length,
      tools,
    });
  }
  const file = join(RESULTS, `${runtime}-${Date.now()}.json`);
  writeFileSync(
    file,
    JSON.stringify(
      {
        runtime,
        execution: RUNTIMES[runtime as keyof typeof RUNTIMES],
        exitCode: code,
        outcome: record?.outcome,
        reason: (record as any)?.reason,
        seconds: Math.round((Date.now() - started) / 1000),
        estimateUsd: record?.accounting.totals.estimate,
        artifacts: dir,
        deliveries: log.reduce((counts: Record<string, number>, line: any) => {
          if (line.kind === "message-delivery") counts[line.state] = (counts[line.state] ?? 0) + 1;
          return counts;
        }, {}),
        trials,
      },
      null,
      2,
    ),
  );
  console.log(`${runtime} run ${run}: exit ${code}, ${record?.outcome}, ${file}`);
}
