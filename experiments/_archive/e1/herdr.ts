export const SESSION = "wf-lab";

export type HerdrCall = {
  ok: boolean;
  ms: number;
  /** The `result` object of the CLI's JSON line; `agent read` answers with plain text instead. */
  result: Record<string, unknown> | undefined;
  stdout: string;
  error: string;
};

export async function herdr(args: string[], timeoutMs = 300_000): Promise<HerdrCall> {
  const started = Date.now();
  const child = Bun.spawn(["herdr", "--session", SESSION, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), timeoutMs);
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const exitCode = await child.exited;
  clearTimeout(timer);

  const ms = Date.now() - started;
  const line = stdout.split("\n").find((candidate) => candidate.trim().startsWith("{"));
  let envelope: Record<string, unknown> | undefined;
  try {
    envelope = line ? (JSON.parse(line) as Record<string, unknown>) : undefined;
  } catch {
    envelope = undefined;
  }
  const result = envelope?.result;
  const failure = envelope?.error;
  return {
    ok: exitCode === 0,
    ms,
    result: result && typeof result === "object" ? (result as Record<string, unknown>) : undefined,
    stdout,
    error:
      exitCode === 0
        ? ""
        : `${JSON.stringify(failure ?? "")} ${stderr.trim()} ${stdout.trim()}`.trim().slice(0, 400),
  };
}
