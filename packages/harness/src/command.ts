import { REAP_GRACE_MS, type SandboxedCommand } from "@agentswf/sandbox";

/** Per-stream capture limit; beyond it output is discarded rather than buffered. */
const MAX_OUTPUT_BYTES = 1_048_576;
/**
 * How long a sandboxed command's output may keep coming once its group is dead: only a process
 * that left the group, as a daemon does, still holds the pipes, and waiting for it could be forever.
 */
const DRAIN_GRACE_MS = 1_000;

export type ProcessResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  cancelled?: boolean;
  /** A held child's line answered, whatever its exit: a kill after that ended nothing it owed. */
  answered?: boolean;
};

export type ProcessInput = {
  argv: readonly string[];
  cwd?: string;
  /** Merged over the parent environment. */
  env?: Record<string, string | undefined>;
  /** Fed to the child and closed. The prompt rides here: no CLI reinterprets stdin. */
  stdin?: string;
  timeoutMs: number;
  signal?: AbortSignal;
} & Holding;

/**
 * For a child that serves requests on stdin and exits when it closes, as codex's app-server and
 * pi's rpc mode do: stdin is held open until a line of stdout answers, then closed.
 */
export type Holding = { holdStdinUntil?: (line: string) => boolean };

/**
 * A `SandboxedCommand` runs as its own process group with exactly its `env`, and ends with its
 * group killed and its `reap` awaited for up to `REAP_GRACE_MS`, however it ended; a reap that
 * fails is its provider's to report. Anything else runs as a child of this process, in its
 * environment.
 */
export type RunProcess = (
  input: ProcessInput | (SandboxedCommand & Holding),
) => Promise<ProcessResult>;

/** `run`, with each of `names` unset in every process it starts, whatever the caller passed. */
export function withholding(run: RunProcess, names: readonly string[]): RunProcess {
  const withheld = Object.fromEntries(names.map((name) => [name, undefined]));
  return (input) => {
    if (!isSandboxed(input)) return run({ ...input, env: { ...input.env, ...withheld } });
    const env = { ...input.env };
    for (const name of names) delete env[name];
    return run({ ...input, env });
  };
}

function isSandboxed(
  input: ProcessInput | (SandboxedCommand & Holding),
): input is SandboxedCommand & Holding {
  return "group" in input && input.group === true;
}

/** A nonzero exit is a normal result, not a throw; the reason is on `stderr`. */
export const runProcess: RunProcess = async (input) => {
  const { argv, cwd, stdin, timeoutMs, signal } = input;
  const sandboxed = isSandboxed(input);
  const reap = sandboxed ? input.reap : undefined;
  const reaped = async (result: ProcessResult) => {
    if (reap) await reapWithin(reap);
    return result;
  };
  if (signal?.aborted) {
    return reaped({
      stdout: "",
      stderr: "process cancelled",
      exitCode: 130,
      timedOut: false,
      cancelled: true,
    });
  }
  const { holdStdinUntil } = input;
  let child: Bun.Subprocess<"ignore" | "pipe" | Uint8Array, "pipe", "pipe">;
  try {
    child = Bun.spawn({
      cmd: [...argv],
      cwd,
      env: sandboxed ? { ...input.env } : childEnvironment(input.env),
      // `setsid`: the group is everything the command starts, which killing it alone would leave
      // running (story 004, X1).
      detached: sandboxed,
      stdin: holdStdinUntil
        ? "pipe"
        : stdin === undefined
          ? "ignore"
          : new TextEncoder().encode(stdin),
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return reaped({ stdout: "", stderr: reason, exitCode: 127, timedOut: false });
  }

  const kill = () => {
    if (!sandboxed) return void child.kill("SIGKILL");
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // The group is already empty.
    }
  };
  let timedOut = false;
  let cancelled = false;
  const abort = () => {
    cancelled = true;
    kill();
  };
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, timeoutMs);

  let answered: ReturnType<typeof setTimeout> | undefined;
  let onLine: ((line: string) => void) | undefined;
  if (holdStdinUntil) {
    const pipe = child.stdin as Bun.FileSink;
    if (stdin !== undefined) pipe.write(stdin);
    void pipe.flush();
    onLine = (line) => {
      if (answered || !holdStdinUntil(line)) return;
      void pipe.end();
      // Closing stdin is how it is told to exit; one that does not is stopped.
      answered = setTimeout(kill, HELD_EXIT_GRACE_MS);
    };
  }

  let result: ProcessResult;
  try {
    const out = capture(child.stdout, onLine);
    const err = capture(child.stderr);
    const exitCode = await child.exited;
    // A held child that answered may leave a descendant holding its pipes, as a sandboxed one may,
    // and so may an unsandboxed one stopped, whose descendants its kill doesn't reach.
    if (sandboxed || answered || cancelled || timedOut) {
      // What the command left running still holds its pipes open, so it goes before they are read.
      kill();
      const drained = await Promise.race([
        Promise.all([out.text, err.text]).then(() => true),
        Bun.sleep(DRAIN_GRACE_MS).then(() => false),
      ]);
      if (!drained) await Promise.all([out.stop(), err.stop()]);
    }
    const [stdout, stderr] = await Promise.all([out.text, err.text]);
    result = {
      stdout,
      stderr,
      exitCode,
      timedOut,
      ...(cancelled ? { cancelled: true } : {}),
      ...(answered ? { answered: true } : {}),
    };
  } finally {
    clearTimeout(timer);
    clearTimeout(answered);
    signal?.removeEventListener("abort", abort);
  }
  return reaped(result);
};

/** How long a held child has to exit once its stdin is closed. */
const HELD_EXIT_GRACE_MS = 5_000;

/** Awaits `reap` until it settles or its grace runs out, whichever is first. */
async function reapWithin(reap: () => Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, REAP_GRACE_MS);
  });
  try {
    await Promise.race([
      Promise.resolve()
        .then(reap)
        .catch(() => undefined),
      expired,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function childEnvironment(
  env?: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return { ...process.env, ...env };
}

/**
 * A stream read up to the capture cap; `stop` ends the read early, keeping what came. `onLine`
 * sees each complete line as it arrives, beyond the cap too.
 */
function capture(
  stream: ReadableStream<Uint8Array>,
  onLine?: (line: string) => void,
): {
  text: Promise<string>;
  stop(): Promise<void>;
} {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let partial = "";
  const text = (async () => {
    const chunks: Uint8Array[] = [];
    let captured = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (onLine) {
        const lines = (partial + decoder.decode(value, { stream: true })).split("\n");
        partial = lines.pop() ?? "";
        for (const line of lines) onLine(line);
      }
      if (captured >= MAX_OUTPUT_BYTES) continue;
      const kept = value.subarray(0, MAX_OUTPUT_BYTES - captured);
      chunks.push(kept);
      captured += kept.byteLength;
    }
    const joined = new Uint8Array(captured);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(joined);
  })();
  return { text, stop: () => reader.cancel() };
}
