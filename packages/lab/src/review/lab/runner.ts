import { basename, dirname, join } from "node:path";
import {
  ALLOWANCE_VERSION,
  type AllowanceReport,
  OUTPUT_RECORD_VERSION,
  type OutputRecord,
} from "@agentswf/contract/records";
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
  /**
   * The run's id: `awf run --id`. The lab finds a run by its id alone, across workflows, so it gives
   * each one an id unique among all of them.
   */
  id: string;
  /** A sandbox spec file every agent of the run is put in: `awf run --sandbox`. */
  sandbox?: string;
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
    "--id",
    request.id,
    "--cwd",
    request.cwd,
    ...(request.sandbox ? ["--sandbox", request.sandbox] : []),
    request.workflow,
    "--",
    ...request.argv,
  ];
}

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
    const started = Date.now();
    if (request.contained && (!process.getuid || !process.getgid)) {
      throw new Error("a contained run needs the operator's uid, and this platform has none");
    }
    const uid = `${process.getuid?.()}:${process.getgid?.()}`;
    // As `awf` runs itself: a .env where awf-lab started could change how every agent logs in.
    const argv = request.contained
      ? containedArgv({ ...request, contained: request.contained }, uid)
      : [process.execPath, "--no-env-file", AWF, ...awfArgv(request)];
    const child = Bun.spawn(argv, {
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

/** `awf allowance --json`, as the operator's own login reads it; undefined when it printed none. */
export async function awfAllowance(
  harnesses: readonly string[],
): Promise<AllowanceReport | undefined> {
  // A pane read takes up to 90 s; past three minutes awf is stuck, and the run goes ahead.
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", AWF, "allowance", "--json", ...harnesses],
    { stdout: "pipe", stderr: "ignore", stdin: "ignore", timeout: 180_000 },
  );
  const [stdout] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  try {
    const report = JSON.parse(stdout) as AllowanceReport;
    return report.version === ALLOWANCE_VERSION ? report : undefined;
  } catch {
    return undefined;
  }
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

const LOGIN_REFUSED = /subscription authentication is required/;
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
  // awf checks a harness's login as its first agent opens, inside the run: refused there, with no
  // agent opened, the run says nothing about the workflow, as one awf refused at the start.
  if (record.outcome !== "completed" && totals.agents === 0 && LOGIN_REFUSED.test(record.reason)) {
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
  const charged = (totals.charged ?? 0) + (decisions?.charged ?? 0);
  return {
    ...(record.outcome !== "completed" && CLEANUP_LATE.test(record.reason)
      ? {}
      : { id: record.runId }),
    outcome: record.outcome,
    ...(record.outcome === "completed" ? {} : { reason: record.reason }),
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
