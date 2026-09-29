import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OutputRecord } from "../packages/contract/src/records";
import { runOperatorCli } from "../packages/engine/src/operator-cli";
import { openRouterKey } from "../packages/engine/src/operator-runtime";
import { assertLiveOptIn } from "./live";

/**
 * Story 006 against the live model: `examples/triage` through `awf run`, with Jev on OpenRouter as
 * `OPENROUTER_API_KEY` installs it. Four synthetic tickets, one call each with a choice, a yes-no
 * and a score: about a second and $0.0001. No agent runs, though `awf run` checks both
 * subscription logins at start.
 */
const EXAMPLE = join(import.meta.dir, "../examples/triage/workflow.ts");
const MOST_USD = 0.001;

async function evaluate(): Promise<{ failed: string[]; record?: OutputRecord }> {
  if (!(await openRouterKey(process.env))) return { failed: [] };
  const output: string[] = [];
  const errors: string[] = [];
  // The operator runtime `awf run` installs, so Jev is installed from the key as an operator's is.
  const exitCode = await runOperatorCli(
    ["run", "--json", "--run-root", await mkdtemp(join(tmpdir(), "awf-decisions-")), EXAMPLE],
    { stdout: (text) => output.push(text), stderr: (text) => errors.push(text) },
  );
  if (exitCode !== 0) return { failed: [`awf run exited ${exitCode}: ${errors.join("\n")}`] };
  const record = JSON.parse(output.join("\n")) as OutputRecord;
  const asked = record.decisions ?? [];
  const charged = asked.reduce((sum, decision) => sum + (decision.charged?.amount ?? 0), 0);
  const failed = [
    ...(asked.length === 4 ? [] : [`${asked.length} decisions recorded, expected 4`]),
    ...asked.flatMap((decision) => [
      ...(decision.outcome === "answered"
        ? []
        : [`${decision.key}: ${decision.outcome} ${decision.error}`]),
      ...(decision.snapshot?.startsWith("typesafe/jev-1.13-")
        ? []
        : [`${decision.key}: snapshot ${decision.snapshot}`]),
      ...(decision.tokens?.input ? [] : [`${decision.key}: no input tokens`]),
    ]),
    ...(record.accounting.unpriced.length === 0 ? [] : [`unpriced: ${record.accounting.unpriced}`]),
    ...(charged > 0 && charged < MOST_USD
      ? []
      : [`charged $${charged}, expected (0, ${MOST_USD})`]),
  ];
  for (const line of errors) console.error(line);
  return { failed, record };
}

if (import.meta.main) {
  assertLiveOptIn(process.env, "call a live model");
  const { failed, record } = await evaluate();
  if (!record && failed.length === 0) {
    console.error("OPENROUTER_API_KEY is not set, nor in .env: skipped");
    console.log(JSON.stringify({ ok: true, skipped: true, failed, estimateUsd: 0 }));
  } else {
    console.log(
      JSON.stringify(
        {
          ok: failed.length === 0,
          failed,
          estimateUsd: record?.accounting.totals.decisions?.estimate,
          ...(record
            ? { artifacts: record.artifacts, value: "value" in record ? record.value : null }
            : {}),
        },
        null,
        2,
      ),
    );
    if (failed.length > 0) process.exitCode = 1;
  }
}
