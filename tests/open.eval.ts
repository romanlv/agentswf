import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenResultJson, OutputRecord } from "../packages/contract/src/records";
import { runOperatorCli } from "../packages/engine/src/operator-cli";
import { assertLiveOptIn, interruption } from "./live";

/**
 * `awf open` on every headless harness, live (story 042): a quick-check run asks each agent 17 × 23
 * and then 9 more; a copy of each agent's session, and then the session itself, are each asked
 * which two numbers it gave. Both must name 391 and 400. claude is left out: headless it is billed
 * per token, and its TUI is checked by hand. Cents on codex and pi, cursor on its plan.
 */
const QUICK_CHECK = join(import.meta.dir, "../examples/quick-check/workflow.ts");

export const RUNTIMES = ["codex", "pi", "cursor"];

const QUESTION =
  "Which two numbers did you give as answers earlier? Reply with just the two numbers.";

/** Why a reply fails: it must hold both answers. */
export function replyProblem(reply: string): string | undefined {
  return reply.includes("391") && reply.includes("400")
    ? undefined
    : `answered ${JSON.stringify(reply.slice(0, 200))}`;
}

async function cli(argv: string[], cwd: string): Promise<{ code: number; stdout: string }> {
  const output: string[] = [];
  const code = await runOperatorCli(argv, {
    cwd,
    signal: interruption(),
    stdout: (text) => output.push(text),
    stderr: (text) => console.error(text),
  });
  return { code, stdout: output.join("\n") };
}

if (import.meta.main) {
  assertLiveOptIn();
  const workDir = await mkdtemp(join(tmpdir(), "awf-open-"));
  const runRoot = join(workDir, "runs");
  const runtimes = process.argv.slice(2).length > 0 ? process.argv.slice(2) : RUNTIMES;
  const ran = await cli(
    ["run", "--run-root", runRoot, "--timeout", "10m", "--json", QUICK_CHECK, "--", ...runtimes],
    workDir,
  );
  const record = ran.stdout ? (JSON.parse(ran.stdout) as OutputRecord) : undefined;
  const failed: string[] = [];
  if (ran.code !== 0 || record?.outcome !== "completed")
    failed.push(`quick-check did not complete: exit ${ran.code}`);
  const checks: Record<string, unknown>[] = [];
  for (const runtime of failed.length > 0 ? [] : runtimes) {
    for (const how of [[], ["--no-fork"]]) {
      const name = `${runtime}${how.length > 0 ? " --no-fork" : ""}`;
      const asked = await cli(
        [
          "open",
          `quick-check/${record!.runId}`,
          `check-${runtime}`,
          ...how,
          "-p",
          QUESTION,
          "--json",
          "--run-root",
          runRoot,
        ],
        workDir,
      );
      const result = asked.stdout ? (JSON.parse(asked.stdout) as Partial<OpenResultJson>) : {};
      const problem = asked.code !== 0 ? `exit ${asked.code}` : replyProblem(result.reply ?? "");
      if (problem) failed.push(`${name}: ${problem}`);
      checks.push({ name, ...result });
    }
  }
  console.log(JSON.stringify({ ok: failed.length === 0, failed, checks, workDir }, null, 2));
  if (failed.length > 0) process.exitCode = 1;
}
