/**
 * Can this instrument register a failure at all? Every cell of the live matrix delivered, which
 * is only good news if a broken channel would have been recorded as broken.
 *
 * The break has to be one the agent cannot route around. A first attempt that simply left `wf`
 * off PATH did not work: the agents found `bin/wf` in the working directory, and one of them
 * installed a shim for it into `~/.local/bin`. So here `WF_RUN` points at a decoy directory
 * that holds no record of the call. `wf` runs, and refuses every value, however well formed —
 * while the trial collects against the real run directory, where nothing will ever appear.
 * A trial that still comes back `unprompted` would mean the harness is measuring something
 * other than delivery.
 *
 *   bun run e2/negative-control.ts
 */
import { join } from "node:path";
import { createHeadlessBackend } from "../backends/headless";
import { createPaneBackend } from "../backends/pane";
import { appendTrial, createRunDir } from "../deps";
import { runTrial, type Task, type TrialSpec } from "../trial";
import type { AgentSessionBackend, BackendKind, CallIdentity, Harness, Step } from "../deps";

const HERE = join(import.meta.dir, "..");
const TASK: Task = {
  question: "how many times does the letter e appear in 'agent terminal', and is that count even",
  prompt:
    "Count how many times the letter e appears in the string 'agent terminal', " +
    "and say whether that count is even. Do not use any tools for the counting.",
  schema: {
    type: "object",
    properties: { count: { type: "integer", minimum: 0 }, even: { type: "boolean" } },
    required: ["count", "even"],
    additionalProperties: false,
  },
};

const runDir = await createRunDir(join(HERE, "e2", "results"), "negative-control");
const decoy = await createRunDir(join(HERE, "e2", "results"), "negative-control-decoy");
const binDir = join(HERE, "bin");

/** Hands the agent a run directory that knows nothing about its call. */
function sabotage(backend: AgentSessionBackend): AgentSessionBackend {
  return {
    kind: backend.kind,
    open: (step: Step, call: CallIdentity) => backend.open(step, { ...call, runDir: decoy }),
  };
}

const backends: Record<BackendKind, AgentSessionBackend> = {
  headless: sabotage(createHeadlessBackend({ turnTimeoutMs: 180_000, binDir })),
  pane: sabotage(
    createPaneBackend({
      session: "wf-lab",
      workspaceLabel: "e2-negative",
      commandTimeoutMs: 30_000,
      settleTimeoutMs: 180_000,
      binDir,
    }),
  ),
};

for (const harness of ["claude", "codex", "pi", "cursor"] as Harness[]) {
  for (const backend of ["headless", "pane"] as BackendKind[]) {
    const spec: TrialSpec = {
      runId: "negative-control",
      runDir,
      callId: `${harness}-${backend}-cli-callback-nc`,
      harness,
      backend,
      method: "cli-callback",
      index: 1,
      task: TASK,
      cwd: HERE,
    };
    const record = await runTrial(spec, backends[backend]);
    await appendTrial(runDir, record);
    console.log(
      `${spec.callId.padEnd(34)} ${record.outcome.padEnd(11)} ${record.firstAttempt.padEnd(10)} ${record.settled}/${record.settledAfterNudge ?? "-"}`,
    );
  }
}
