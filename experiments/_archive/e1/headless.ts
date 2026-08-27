import { HARNESSES, type HarnessName, type Usage } from "./harnesses";

export type HeadlessRun = {
  ok: boolean;
  exitCode: number;
  /** Spawn to the first byte on stdout. */
  firstOutputMs?: number;
  totalMs: number;
  reply: string;
  usage: Usage;
  stderr: string;
};

export const CWD = "/Users/roman/dev/braintrust/agent/wf-poc1";

export async function runHeadless(
  name: HarnessName,
  prompt: string,
  timeoutMs: number,
): Promise<HeadlessRun> {
  const harness = HARNESSES[name];
  const argv = harness.headless(prompt);
  const started = Date.now();
  const child = Bun.spawn(argv, {
    cwd: CWD,
    stdin: harness.promptOnStdin ? new TextEncoder().encode(prompt) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const timer = setTimeout(() => child.kill(), timeoutMs);
  let firstOutputMs: number | undefined;
  let stdout = "";
  for await (const chunk of child.stdout) {
    firstOutputMs ??= Date.now() - started;
    stdout += new TextDecoder().decode(chunk);
  }
  const exitCode = await child.exited;
  clearTimeout(timer);

  const totalMs = Date.now() - started;
  const stderr = await new Response(child.stderr).text();
  const parsed = harness.parse(stdout);
  return {
    ok: exitCode === 0 && parsed.reply !== "",
    exitCode,
    ...(firstOutputMs !== undefined && { firstOutputMs }),
    totalMs,
    reply: parsed.reply,
    usage: parsed.usage,
    stderr: stderr.trim().slice(0, 400),
  };
}
