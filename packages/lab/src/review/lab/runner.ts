import { basename, dirname, join } from "node:path";
import type { AllowanceReport } from "@agentswf/contract/records";
import {
  AWF,
  awfArgv,
  awfCommand,
  loginRefused,
  type RunRequest as ProcessRequest,
  parseRecord,
  type RunResult,
  runEnvironment,
  spawnAwf,
} from "../../shared/runner";
import type { RunSummary } from "../format/scoring";

export {
  AWF,
  awfArgv,
  parseRecord,
  type RunOutput,
  type RunResult,
  withoutCallingSession,
} from "../../shared/runner";

export type RunRequest = ProcessRequest & {
  /** The whole run in a container instead, with only these paths mounted, each where it is. */
  contained?: Contained;
};

export type Contained = {
  image: string;
  read: readonly string[];
  write: readonly string[];
  /** The run's home: a fresh one, holding the harness credential and nothing else. */
  home: string;
};

/** The review kind's runner: a plain request, or one contained, which mounts this checkout. */
export type Runner = (request: RunRequest) => Promise<RunResult>;

/**
 * `docker run` for a contained request: the operator's uid, no capabilities, and only the paths it
 * names, each mounted where it is on the host so no argument needs rewriting. awf comes from this
 * checkout's packages, never its root, which holds `.env`.
 */
export function containedArgv(
  request: RunRequest & { contained: Contained },
  uid: string,
): string[] {
  const { image, read, write, home } = request.contained;
  const mount = (path: string, mode: "ro" | "rw") => ["-v", `${path}:${path}:${mode}`];
  return [
    "docker",
    "run",
    "--rm",
    "--init",
    "--name",
    // The trial's scratch folder, `awf-lab-trial-…`: a stray container is found by it.
    basename(dirname(home)),
    "--user",
    uid,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "-e",
    `HOME=${home}`,
    ...mount(home, "rw"),
    ...AWF_MOUNTS.flatMap((path) => mount(join(AWF_ROOT, path), "ro")),
    ...read.flatMap((path) => mount(path, "ro")),
    ...write.flatMap((path) => mount(path, "rw")),
    "-w",
    request.cwd,
    image,
    "bun",
    "--no-env-file",
    AWF,
    ...awfArgv(request),
  ];
}

const AWF_ROOT = join(AWF, "../../../..");
const AWF_MOUNTS = [
  "packages",
  "examples",
  "node_modules",
  "package.json",
  "tsconfig.json",
  "bunfig.toml",
];

export function awfRunner(): Runner {
  return async (request) => {
    if (request.contained && (!process.getuid || !process.getgid)) {
      throw new Error("a contained run needs the operator's uid, and this platform has none");
    }
    const uid = `${process.getuid?.()}:${process.getgid?.()}`;
    // As `awf` runs itself: a .env where awf-lab started could change how every agent logs in.
    const argv = request.contained
      ? containedArgv({ ...request, contained: request.contained }, uid)
      : awfCommand(undefined, awfArgv(request));
    const { exitCode, stdout, stderr, ms } = await spawnAwf(argv, { env: runEnvironment() });
    return { exitCode, stderr, ms, ...parseRecord(stdout) };
  };
}

/** `awf allowance --json`, as the operator's own login reads it; undefined when it printed none. */
export async function awfAllowance(
  harnesses: readonly string[],
): Promise<AllowanceReport | undefined> {
  // A pane read takes up to 90 s; past three minutes awf is stuck, and the run goes ahead.
  const child = Bun.spawn(awfCommand(undefined, ["allowance", "--json", ...harnesses]), {
    stdout: "pipe",
    stderr: "ignore",
    stdin: "ignore",
    timeout: 180_000,
  });
  const [stdout] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  try {
    const report = JSON.parse(stdout) as AllowanceReport | { code: string };
    // A refusal, which has a code and no report's fields, is none.
    return "code" in report || report.v !== 1 ? undefined : report;
  } catch {
    return undefined;
  }
}

// awf fails a run whose agent outlived the shutdown grace, though the workflow may have finished:
// that is the host's doing, not the variant's, so the trial is run again, its spend still counted.
const CLEANUP_LATE = /^agent cleanup exceeded \d+ms shutdown grace/;

/**
 * A run as a score keeps it. A run that never started, or that awf failed only for an agent's slow
 * shutdown, is `failed` with no id: it says nothing about the workflow, so it is run again.
 */
export function summaryOf(result: RunResult): RunSummary {
  const { record } = result;
  if (!record) {
    const said = result.stderr.trim().split("\n").slice(-3).join(" ").trim();
    return {
      outcome: "failed",
      reason: `awf run exited ${result.exitCode} without a record${said ? `: ${said}` : ""}`,
      models: [],
      ms: result.ms,
      estimate: 0,
      billing: "unknown",
      complete: true,
    };
  }
  const { totals } = record.accounting;
  if (record.outcome !== "completed" && loginRefused(record)) {
    return {
      outcome: "failed",
      reason: record.reason,
      models: [],
      ms: record.accounting.wallMs,
      estimate: 0,
      billing: "unknown",
      complete: true,
    };
  }
  const decisions = totals.decisions;
  const priced =
    (totals.agents === 0 || totals.estimate !== undefined) &&
    (!decisions || decisions.calls === 0 || decisions.estimate !== undefined);
  const reportedCost = (totals.reportedCost ?? 0) + (decisions?.reportedCost ?? 0);
  return {
    ...(record.outcome !== "completed" && CLEANUP_LATE.test(record.reason)
      ? {}
      : { id: record.runId }),
    outcome: record.outcome,
    ...(record.outcome === "completed" ? {} : { reason: record.reason }),
    models: record.accounting.byModel.map((model) => model.model),
    ms: record.accounting.wallMs,
    ...(priced ? { estimate: (totals.estimate ?? 0) + (decisions?.estimate ?? 0) } : {}),
    ...(reportedCost > 0 ? { charged: reportedCost } : {}),
    billing: record.accounting.billing,
    complete:
      totals.known === totals.agents &&
      totals.priced === totals.agents &&
      (!decisions || decisions.priced === decisions.calls),
  };
}
