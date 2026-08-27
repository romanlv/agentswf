/** Per-stream capture limit; beyond it output is discarded rather than buffered. */
const MAX_OUTPUT_BYTES = 1_048_576;

export type ProcessResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
};

export type ProcessInput = {
  argv: readonly string[];
  cwd?: string;
  /** Merged over the parent environment. `WF_RUN` and `WF_CALL` ride in here for headless. */
  env?: Record<string, string>;
  /** Fed to the child and closed. The prompt rides here: no CLI reinterprets stdin. */
  stdin?: string;
  timeoutMs: number;
};

export type RunProcess = (input: ProcessInput) => Promise<ProcessResult>;

/** A nonzero exit is a normal result, not a throw; the reason is on `stderr`. */
export const runProcess: RunProcess = async ({ argv, cwd, env, stdin, timeoutMs }) => {
  let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    child = Bun.spawn({
      cmd: [...argv],
      cwd,
      env: { ...process.env, ...env },
      stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { stdout: "", stderr: reason, exitCode: 127, timedOut: false };
  }

  let timedOut = false;
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
    return { stdout, stderr, exitCode, timedOut };
  } finally {
    clearTimeout(timer);
  }
};

async function readCapped(stream: ReadableStream<Uint8Array>): Promise<string> {
  const text = await new Response(stream).text();
  return text.length > MAX_OUTPUT_BYTES ? text.slice(0, MAX_OUTPUT_BYTES) : text;
}
