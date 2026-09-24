/** Per-stream capture limit; beyond it output is discarded rather than buffered. */
const MAX_OUTPUT_BYTES = 1_048_576;

export type ProcessResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  cancelled?: boolean;
};

export type ProcessInput = {
  argv: readonly string[];
  cwd?: string;
  /** Merged over the parent environment. The frozen legacy driver's `WF_RUN`/`WF_CALL` ride here. */
  env?: Record<string, string | undefined>;
  /** Fed to the child and closed. The prompt rides here: no CLI reinterprets stdin. */
  stdin?: string;
  timeoutMs: number;
  signal?: AbortSignal;
};

export type RunProcess = (input: ProcessInput) => Promise<ProcessResult>;

/** `run`, with each of `names` unset in every process it starts, whatever the caller passed. */
export function withholding(run: RunProcess, names: readonly string[]): RunProcess {
  const withheld = Object.fromEntries(names.map((name) => [name, undefined]));
  return (input) => run({ ...input, env: { ...input.env, ...withheld } });
}

/** A nonzero exit is a normal result, not a throw; the reason is on `stderr`. */
export const runProcess: RunProcess = async ({ argv, cwd, env, stdin, timeoutMs, signal }) => {
  if (signal?.aborted) {
    return {
      stdout: "",
      stderr: "process cancelled",
      exitCode: 130,
      timedOut: false,
      cancelled: true,
    };
  }
  let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    child = Bun.spawn({
      cmd: [...argv],
      cwd,
      env: childEnvironment(env),
      stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { stdout: "", stderr: reason, exitCode: 127, timedOut: false };
  }

  let timedOut = false;
  let cancelled = false;
  const abort = () => {
    cancelled = true;
    child.kill("SIGKILL");
  };
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readCapped(child.stdout),
      readCapped(child.stderr),
      child.exited,
    ]);
    return { stdout, stderr, exitCode, timedOut, ...(cancelled ? { cancelled: true } : {}) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
};

/**
 * `WF_RUN` and `WF_CALL` are the legacy driver's, and only for the process it sets them on. An
 * `awf` started from inside one would otherwise hand its own agents that run's directory.
 */
function childEnvironment(
  env?: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const inherited = { ...process.env };
  delete inherited.WF_RUN;
  delete inherited.WF_CALL;
  return { ...inherited, ...env };
}

async function readCapped(stream: ReadableStream<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  let captured = 0;
  for await (const chunk of stream) {
    if (captured >= MAX_OUTPUT_BYTES) continue;
    const kept = chunk.subarray(0, MAX_OUTPUT_BYTES - captured);
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
}
