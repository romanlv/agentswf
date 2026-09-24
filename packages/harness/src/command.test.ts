import { expect, test } from "bun:test";
import { type ProcessInput, runProcess, withholding } from "./command";

test("child processes inherit no stale run binding", async () => {
  const names = ["WF_RUN", "WF_CALL"] as const;
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) process.env[name] = `stale-${name}`;
  try {
    const result = await runProcess({
      argv: [
        process.execPath,
        "-e",
        "console.log(JSON.stringify([process.env.WF_RUN, process.env.WF_CALL]))",
      ],
      timeoutMs: 5_000,
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual([null, null]);
  } finally {
    for (const name of names) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("withholding unsets the named variables and leaves everything else alone", async () => {
  const seen: ProcessInput[] = [];
  const run = withholding(
    async (input) => {
      seen.push(input);
      return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
    },
    ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"],
  );
  await run({
    argv: ["codex", "exec"],
    timeoutMs: 1_000,
    env: { OPENAI_API_KEY: "metered", TERM: "xterm-256color" },
  });
  expect(seen[0]?.env).toEqual({
    OPENAI_API_KEY: undefined,
    ANTHROPIC_API_KEY: undefined,
    TERM: "xterm-256color",
  });
});
