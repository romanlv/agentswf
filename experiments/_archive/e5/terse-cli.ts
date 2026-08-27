/**
 * The comparison arm: `wf result` that refuses without saying why.
 *
 * E5's claim is that the per-field error is what gets the agent to correct itself. The only way
 * to test that is to take the error away and change nothing else, so this is the same acceptance
 * path — `acceptResult`, same schema, same attempt log — with the message replaced by a bare
 * refusal. It lives here rather than behind a flag in `cli.ts` so the shipped CLI has no mode
 * that silently withholds the correction the design depends on.
 */
import { acceptResult } from "../deps";
import type { CliOutcome } from "../deps";

export async function runTerseCli(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): Promise<CliOutcome> {
  const [command, ...rest] = argv;
  if (command !== "result") {
    return { exitCode: 2, stdout: "", stderr: "wf: unknown command" };
  }
  const runDir = env.WF_RUN;
  const callId = env.WF_CALL;
  if (!runDir || !callId) {
    return { exitCode: 2, stdout: "", stderr: "wf: not serving a workflow call" };
  }
  if (rest.length > 1) {
    return { exitCode: 2, stdout: "", stderr: "wf: result takes one argument" };
  }
  const raw = (rest[0] ?? "").trim();
  if (raw === "") return { exitCode: 2, stdout: "", stderr: "wf: result needs a value" };

  const outcome = await acceptResult(runDir, callId, raw, "cli-callback");
  if (outcome.kind === "rejected") {
    return { exitCode: 1, stdout: "", stderr: "wf: result rejected." };
  }
  return { exitCode: 0, stdout: `wf: result accepted for call ${callId}`, stderr: "" };
}

if (import.meta.main) {
  const outcome = await runTerseCli(process.argv.slice(2), process.env);
  if (outcome.stdout) console.log(outcome.stdout);
  if (outcome.stderr) console.error(outcome.stderr);
  process.exit(outcome.exitCode);
}
