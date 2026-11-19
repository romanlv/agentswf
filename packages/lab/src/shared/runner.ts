import { join } from "node:path";
import { OUTPUT_RECORD_VERSION, type OutputRecord } from "@agentswf/contract/records";

/** An `awf` other than this checkout's: a folder's own installed bin, started in that folder. */
export type AwfBin = {
  /** The bin's file, `node_modules/agentswf/src/awf.ts`. */
  bin: string;
  /** The working folder it starts in, so it hands the run to no other engine. */
  dir: string;
  /** A module `bun --preload` loads before the bin. */
  preload?: string;
};

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
  /** Absent: this checkout's own engine, from the lab's working folder. */
  awf?: AwfBin;
  /** Added to the run's environment, over the lab's own less the calling session's. */
  env?: Readonly<Record<string, string>>;
  /** `awf run --quiet`. */
  quiet?: boolean;
  /** `awf run --boxed`: the caller boxes the whole run, and the workflow's sandboxes are set aside. */
  boxed?: true;
  /** The command the whole `awf run` process starts inside, such as `srt -s {profile} --`. */
  box?: readonly string[];
};

/** `awf run`'s record: never parked, as `awf run` refuses a workflow with events. */
export type RunOutput = Exclude<OutputRecord, { outcome: "parked" }>;

export type RunResult = {
  exitCode: number;
  record?: RunOutput;
  /** A record was printed that this lab can't read: why. */
  unread?: string;
  stderr: string;
  ms: number;
};

/**
 * Runs one workflow as an operator would and returns the record it wrote: the one seam between
 * awf-lab and the engine, so the run record stays the only interface (ADR 0002).
 */
export type Runner = (request: RunRequest) => Promise<RunResult>;

/**
 * The `awf` of this checkout, as the root package's `awf` script runs it: a process, not an import,
 * so the engine's record stays the interface. A test pins that the file is there.
 */
export const AWF = join(import.meta.dir, "../../../engine/src/operator-cli.ts");

/** `awf run`'s arguments for a request: the one argv both the process and a test's runner use. */
export function awfArgv(request: RunRequest): string[] {
  return [
    "run",
    "--json",
    ...(request.quiet ? ["--quiet"] : []),
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
    ...(request.boxed ? ["--boxed"] : []),
    request.workflow,
    "--",
    ...request.argv,
  ];
}

/**
 * The command that starts an `awf`: as `awf` runs itself, never reading a `.env` where it starts,
 * which could change how every agent logs in.
 */
export function awfCommand(awf: AwfBin | undefined, args: readonly string[]): string[] {
  return [
    process.execPath,
    "--no-env-file",
    ...(awf?.preload ? ["--preload", awf.preload] : []),
    awf?.bin ?? AWF,
    ...args,
  ];
}

/** The lab's environment, less the calling session, with `extra` over it. */
export function runEnvironment(
  extra: Readonly<Record<string, string>> = {},
  base: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string | undefined> {
  return { ...withoutCallingSession(base), ...extra };
}

/** Starts an `awf` and waits for it; stdout and stderr whole. */
export async function spawnAwf(
  argv: readonly string[],
  options: { cwd?: string; env?: Readonly<Record<string, string | undefined>> } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string; ms: number }> {
  const started = Date.now();
  const child = Bun.spawn([...argv], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    ...(options.cwd ? { cwd: options.cwd } : {}),
    env: options.env ?? runEnvironment(),
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr, ms: Date.now() - started };
}

/** The runner both kinds start a plain request with: this checkout's `awf`, or a folder's. */
export function processRunner(): Runner {
  return async (request) => {
    const { exitCode, stdout, stderr, ms } = await spawnAwf(
      [...(request.box ?? []), ...awfCommand(request.awf, awfArgv(request))],
      {
        ...(request.awf ? { cwd: request.awf.dir } : {}),
        env: runEnvironment(request.env),
      },
    );
    return { exitCode, stderr, ms, ...parseRecord(stdout) };
  };
}

/**
 * Each harness's session variable, its spec's `sessionEnv`: a case's run started with one would
 * find the operator's session and let its workflow fork it (story 027).
 */
const SESSION_VARIABLES = [
  "CLAUDE_CODE_SESSION_ID",
  "CODEX_SESSION_ID",
  "PI_SESSION_ID",
  "CURSOR_CONVERSATION_ID",
];

/** `environment` without the session `awf-lab` was started from, if it was started from one. */
export function withoutCallingSession(
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(environment).filter(([name]) => !SESSION_VARIABLES.includes(name)),
  );
}

/**
 * `awf run --json` prints the record, success or not; a run that never started, a refusal. A
 * record this lab can't read, of another version or parked, is `unread`, saying why: the lab's to
 * report, never a run to grade.
 */
export function parseRecord(stdout: string): { record?: RunOutput; unread?: string } {
  const text = stdout.trim();
  if (!text.startsWith("{")) return {};
  let record: OutputRecord;
  try {
    record = JSON.parse(text) as OutputRecord;
  } catch {
    return {};
  }
  if (typeof record !== "object" || record === null || !("version" in record)) return {};
  if (record.version !== OUTPUT_RECORD_VERSION) {
    return {
      unread: `awf printed a run record of version ${record.version}; this lab reads version ${OUTPUT_RECORD_VERSION}`,
    };
  }
  if (record.outcome === "parked") return { unread: "awf printed a parked run's record" };
  return { record };
}

const LOGIN_REFUSED = /subscription authentication is required/;

/**
 * awf checks a harness's login as its first agent opens, inside the run: refused there, with no
 * agent opened, the run says nothing about the workflow, as one awf refused at the start.
 */
export function loginRefused(record: RunOutput): boolean {
  return (
    record.outcome !== "completed" &&
    record.accounting.totals.agents === 0 &&
    LOGIN_REFUSED.test(record.reason)
  );
}

/** More events than any trial's run holds: `awf logs` without `--after` gives the newest this many. */
const ALL_EVENTS = 10_000_000;

/**
 * Everything `awf logs --json` has for a run, as the text it printed: what the marker search reads.
 * One page without `--after` is the newest `--limit` events, and says when older ones were left
 * out; anything short of the whole run is `unread`, saying why.
 */
export async function awfLogs(
  awf: AwfBin | undefined,
  runRoot: string,
  ref: string,
  env: Readonly<Record<string, string>> = {},
): Promise<{ text: string } | { unread: string }> {
  const { stdout, stderr, exitCode } = await spawnAwf(
    awfCommand(awf, ["logs", ref, "--json", "--run-root", runRoot, "--limit", String(ALL_EVENTS)]),
    { ...(awf ? { cwd: awf.dir } : {}), env: runEnvironment(env) },
  );
  let page: { v?: unknown; events?: unknown; more?: { older?: boolean } };
  try {
    page = JSON.parse(stdout);
  } catch {
    const said = stderr.trim().split("\n").at(-1) ?? "";
    return {
      unread: `awf logs ${ref} printed no page (exit ${exitCode})${said ? `: ${said}` : ""}`,
    };
  }
  if (exitCode !== 0 || !Array.isArray(page.events)) {
    return { unread: `awf logs ${ref} refused: ${stdout.trim().slice(0, 300)}` };
  }
  if (page.more?.older) return { unread: `awf logs ${ref} left out the run's oldest events` };
  return { text: stdout };
}

/**
 * What a run's folder says it is estimated at, from `awf runs {ref} --json`: for a run that
 * printed no record, as one cut short does, though its agents may have spent. Undefined when the
 * folder can't be read.
 */
export async function awfRunEstimate(
  awf: AwfBin | undefined,
  runRoot: string,
  ref: string,
  env: Readonly<Record<string, string>> = {},
): Promise<number | undefined> {
  const { stdout, exitCode } = await spawnAwf(
    awfCommand(awf, ["runs", ref, "--json", "--run-root", runRoot]),
    { ...(awf ? { cwd: awf.dir } : {}), env: runEnvironment(env) },
  );
  if (exitCode !== 0) return undefined;
  try {
    const estimate = (JSON.parse(stdout) as { run?: { estimate?: unknown } }).run?.estimate;
    return typeof estimate === "number" && Number.isFinite(estimate) ? estimate : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether `awf run` printed the record version this lab reads: the folder's own `awf`, started
 * once in `dir` on a workflow that does nothing, before the first trial. The version it printed,
 * or why it printed none.
 */
export async function probeRecordVersion(
  awf: AwfBin,
  workflow: string,
  dir: string,
): Promise<{ version: unknown } | { unread: string }> {
  const { stdout, stderr, exitCode } = await spawnAwf(
    awfCommand({ bin: awf.bin, dir: awf.dir }, [
      "run",
      "--json",
      "--quiet",
      "--no-watch",
      "--timeout",
      "60s",
      "--run-root",
      join(dir, "runs"),
      "--cwd",
      dir,
      workflow,
    ]),
    { cwd: awf.dir, env: runEnvironment() },
  );
  try {
    const record = JSON.parse(stdout.trim()) as { version?: unknown };
    if (typeof record === "object" && record !== null && "version" in record) {
      return { version: record.version };
    }
  } catch {}
  const said = (stderr.trim() || stdout.trim()).split("\n").slice(-3).join(" ");
  return { unread: `its awf run printed no record (exit ${exitCode})${said ? `: ${said}` : ""}` };
}
