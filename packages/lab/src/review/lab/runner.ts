import { join } from "node:path";
import { OUTPUT_RECORD_VERSION, type OutputRecord } from "@agentswf/contract/records";
import type { RunSummary } from "../format/scoring";

export type RunRequest = {
  /** The workflow file. */
  workflow: string;
  /** Where the workflow works: `awf run --cwd`. */
  cwd: string;
  timeout: string;
  /** The workflow's own arguments, after `--`. */
  argv: readonly string[];
  runRoot: string;
  /** A sandbox spec file every agent of the run is put in: `awf run --sandbox`. */
  sandbox?: string;
};

export type RunResult = { exitCode: number; record?: OutputRecord; stderr: string; ms: number };

/**
 * Runs one workflow as an operator would and returns the record it wrote: the one seam between
 * awf-lab and the engine, so the run record stays the only interface (ADR 0002).
 */
export type Runner = (request: RunRequest) => Promise<RunResult>;

/**
 * The `awf` of this checkout, as the root package's `awf` script runs it: a process, not an import,
 * so the engine's record stays the interface. A test pins that the file is there.
 */
export const AWF = join(import.meta.dir, "../../../../engine/src/operator-cli.ts");

/** `awf run`'s arguments for a request: the one argv both the process and a test's runner use. */
export function awfArgv(request: RunRequest): string[] {
  return [
    "run",
    "--json",
    "--no-watch",
    "--timeout",
    request.timeout,
    "--run-root",
    request.runRoot,
    "--cwd",
    request.cwd,
    ...(request.sandbox ? ["--sandbox", request.sandbox] : []),
    request.workflow,
    "--",
    ...request.argv,
  ];
}

export function awfRunner(): Runner {
  return async (request) => {
    const started = Date.now();
    // As `awf` runs itself: a .env where awf-lab started could change how every agent logs in.
    const child = Bun.spawn([process.execPath, "--no-env-file", AWF, ...awfArgv(request)], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { exitCode, stderr, ms: Date.now() - started, ...parseRecord(stdout) };
  };
}

/** `awf run --json` prints the record, success or not; usage errors print none. */
export function parseRecord(stdout: string): { record?: OutputRecord } {
  const text = stdout.trim();
  if (!text.startsWith("{")) return {};
  try {
    const record = JSON.parse(text) as OutputRecord;
    // Written by the same checkout's awf; another version is a reader this one doesn't know.
    return record.version === OUTPUT_RECORD_VERSION ? { record } : {};
  } catch {
    return {};
  }
}

/** A run as a score keeps it. A run that never started is `failed` with what awf said. */
export function summaryOf(result: RunResult): RunSummary {
  const { record } = result;
  if (!record) {
    const said = result.stderr.trim().split("\n").slice(-3).join(" ").trim();
    return {
      outcome: "failed",
      error: `awf run exited ${result.exitCode} without a record${said ? `: ${said}` : ""}`,
      models: [],
      ms: result.ms,
      estimate: 0,
      billing: "unknown",
      complete: true,
    };
  }
  const { totals } = record.accounting;
  const decisions = totals.decisions;
  const priced =
    (totals.agents === 0 || totals.estimate !== undefined) &&
    (!decisions || decisions.calls === 0 || decisions.estimate !== undefined);
  const charged = (totals.charged ?? 0) + (decisions?.charged ?? 0);
  return {
    id: record.runId,
    outcome: record.outcome,
    ...(record.outcome === "succeeded" ? {} : { error: record.error }),
    models: record.accounting.byModel.map((model) => model.model),
    ms: record.accounting.wallMs,
    ...(priced ? { estimate: (totals.estimate ?? 0) + (decisions?.estimate ?? 0) } : {}),
    ...(charged > 0 ? { charged } : {}),
    billing: record.accounting.billing,
    complete:
      totals.known === totals.agents &&
      totals.priced === totals.agents &&
      (!decisions || decisions.priced === decisions.calls),
  };
}
