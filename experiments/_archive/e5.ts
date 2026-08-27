/**
 * E5 — does the schema error get the agent to correct itself?
 *
 * A fiddly value through `wf result`, which refuses it with a per-field error the agent reads
 * on its own terminal. Nothing re-prompts inside a turn: whatever correction happens, happens
 * because the agent read the refusal. `trial.ts` records that as `firstAttempt: "corrected"`,
 * apart from a clean `accepted` and apart from a `malformed` that stayed wrong.
 *
 * Three arms, selected by flag:
 *   --arm shipped   the instructions `return-method.ts` actually sends: shape, no bounds
 *   --arm terse     the same, with a `wf` that refuses without saying why
 *   --arm schema    the same, with the JSON Schema itself pasted into the prompt
 *
 *   bun run e5.ts --arm shipped --harness claude --backend headless --trials 20
 */
import { join } from "node:path";
import { createHeadlessBackend } from "./backends/headless";
import { createPaneBackend } from "./backends/pane";
import { createRunDir } from "./deps";
import { expandMatrix, runMatrix, type MatrixSpec } from "./runner";
import type { Task } from "./trial";
import type { JsonSchema } from "./deps";
import type { AgentSessionBackend, BackendKind, Harness } from "./deps";

const HERE = import.meta.dir;

export type Arm = "shipped" | "terse" | "schema";

/**
 * Nested object, two enums, a `minItems` array, a bounded integer, two `minLength` strings and
 * `additionalProperties: false`. `describe()` renders the shape and none of the bounds, so a
 * first attempt has to guess them — which is what the shipped instructions really do.
 */
const SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["approve", "revise", "reject"] },
    confidence: { type: "integer", minimum: 1, maximum: 5 },
    findings: {
      type: "array",
      minItems: 2,
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["low", "medium", "high"] },
          note: { type: "string", minLength: 10 },
        },
        required: ["severity", "note"],
        additionalProperties: false,
      },
    },
    summary: { type: "string", minLength: 20 },
  },
  required: ["verdict", "confidence", "findings", "summary"],
  additionalProperties: false,
};

const SNIPPET = [
  "function total(items) {",
  "  let sum",
  "  for (var i = 0; i <= items.length; i++) sum += items[i].price",
  "  return sum",
  "}",
].join("\n");

const QUESTION =
  "review this four-line function and report a verdict, a confidence, the findings and a summary";

const BASE_PROMPT =
  "Review this JavaScript function and report what is wrong with it. " +
  "Do not use any tools and do not write any files; the whole review is these five lines.\n\n" +
  SNIPPET;

const SCHEMA_ARM_SUFFIX =
  "\n\nThe value must validate against this JSON Schema exactly:\n" +
  JSON.stringify(SCHEMA, null, 2);

const ALL_HARNESSES: Harness[] = ["claude", "codex", "pi", "cursor"];
const ALL_BACKENDS: BackendKind[] = ["pane", "headless"];

function flag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
}

function list<T extends string>(value: string | undefined, fallback: T[]): T[] {
  return value ? (value.split(",").map((entry) => entry.trim()) as T[]) : fallback;
}

async function main(argv: string[]): Promise<void> {
  const arm = (flag(argv, "arm") ?? "shipped") as Arm;
  const spec: MatrixSpec = {
    harnesses: list(flag(argv, "harness"), ALL_HARNESSES),
    backends: list(flag(argv, "backend"), ALL_BACKENDS),
    methods: ["cli-callback"],
    trials: Number(flag(argv, "trials") ?? 20),
  };

  const runId = flag(argv, "run") ?? `e5-${arm}`;
  const runDir = await createRunDir(flag(argv, "root") ?? join(HERE, "e5", "results"), runId);
  // The terse arm differs from the shipped one in exactly one thing: which `wf` is on PATH.
  const binDir = arm === "terse" ? join(HERE, "e5", "bin-terse") : join(HERE, "bin");

  const task: Task = {
    question: QUESTION,
    prompt: arm === "schema" ? BASE_PROMPT + SCHEMA_ARM_SUFFIX : BASE_PROMPT,
    schema: SCHEMA,
  };

  const backends: Partial<Record<BackendKind, AgentSessionBackend>> = {
    headless: createHeadlessBackend({ turnTimeoutMs: 240_000, binDir }),
    pane: createPaneBackend({
      session: flag(argv, "session") ?? "wf-lab",
      workspaceLabel: `e5-${arm}`,
      commandTimeoutMs: 30_000,
      settleTimeoutMs: 240_000,
      binDir,
    }),
  };

  console.log(`run ${runId} (arm ${arm}) -> ${runDir}`);
  await runMatrix(expandMatrix(spec, { runId, runDir, task, cwd: HERE }), backends, {
    onRecord: (record) =>
      console.log(
        `${record.callId}: ${record.outcome} first=${record.firstAttempt}` +
          (record.rejection ? ` rejected=${record.rejection.split("\n")[0]}` : ""),
      ),
  });
}

if (import.meta.main) await main(process.argv.slice(2));
