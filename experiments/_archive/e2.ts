import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHeadlessBackend } from "./backends/headless";
import { createPaneBackend } from "./backends/pane";
import { createRunDir } from "./deps";
import { expandMatrix, formatTally, runMatrix, tally, type MatrixSpec } from "./runner";
import type { Task } from "./trial";
import type { AgentSessionBackend, BackendKind, Harness, ReturnMethod } from "./deps";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Trivial and checkable, so a failed trial is a return-channel failure and nothing else. */
const TASK: Task = {
  question: "how many times does the letter e appear in 'agent terminal', and is that count even",
  prompt:
    "Count how many times the letter e appears in the string 'agent terminal', " +
    "and say whether that count is even. Do not use any tools for the counting.",
  schema: {
    type: "object",
    properties: {
      count: { type: "integer", minimum: 0 },
      even: { type: "boolean" },
    },
    required: ["count", "even"],
    additionalProperties: false,
  },
};

const ALL_HARNESSES: Harness[] = ["claude", "codex", "pi", "cursor"];
const ALL_BACKENDS: BackendKind[] = ["pane", "headless"];
const ALL_METHODS: ReturnMethod[] = ["cli-callback", "write-a-file", "delimited-line"];

function list<T extends string>(value: string | undefined, fallback: T[]): T[] {
  return value ? (value.split(",").map((entry) => entry.trim()) as T[]) : fallback;
}

function flag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
}

async function main(argv: string[]): Promise<void> {
  const spec: MatrixSpec = {
    harnesses: list(flag(argv, "harness"), ALL_HARNESSES),
    backends: list(flag(argv, "backend"), ALL_BACKENDS),
    methods: list(flag(argv, "method"), ALL_METHODS),
    trials: Number(flag(argv, "trials") ?? 20),
  };

  const runId = flag(argv, "run") ?? new Date().toISOString().replace(/[:.]/g, "-");
  // The same `--run` under the same `--root` appends, so the matrix can be driven one cell at
  // a time and still land in one run directory.
  const runDir = await createRunDir(flag(argv, "root") ?? join(HERE, "runs"), runId);
  const binDir = join(HERE, "bin");

  const backends: Partial<Record<BackendKind, AgentSessionBackend>> = {
    headless: createHeadlessBackend({ turnTimeoutMs: 180_000, binDir }),
    pane: createPaneBackend({
      // Never `review-loop`: that session has a live loop attached to it.
      session: flag(argv, "session") ?? "wf-lab",
      workspaceLabel: "e2",
      commandTimeoutMs: 30_000,
      settleTimeoutMs: 180_000,
      binDir,
    }),
  };

  console.log(`run ${runId} -> ${runDir}`);
  const records = await runMatrix(
    expandMatrix(spec, { runId, runDir, task: TASK, cwd: HERE }),
    backends,
    { onRecord: (record) => console.log(`${record.callId}: ${record.outcome}`) },
  );

  const summary = formatTally(tally(records));
  await Bun.write(join(runDir, "summary.txt"), `${summary}\n`);
  console.log(`\n${summary}`);
}

if (import.meta.main) await main(process.argv.slice(2));
