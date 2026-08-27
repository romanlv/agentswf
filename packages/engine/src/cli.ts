import { acceptResult } from "./result-layer";
import { acceptAny, type SemanticCheck } from "@wf/contract";
import { readCall } from "./run-dir";

const usage = [
  "wf result '<json>'   hand the value for the current call back to the workflow engine",
  "",
  "The call identity comes from the pane environment, not the prompt:",
  "  WF_RUN   run directory",
  "  WF_CALL  call id",
].join("\n");

export type CliOutcome = { exitCode: number; stdout: string; stderr: string };

/**
 * Returns its output rather than printing it, so the tests and the fake backend drive the
 * real acceptance path instead of a copy of it.
 */
export async function runCli(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  semantic: SemanticCheck = acceptAny,
): Promise<CliOutcome> {
  const [command, ...rest] = argv;
  if (command !== "result") {
    return { exitCode: 2, stdout: "", stderr: usage };
  }

  const runDir = env.WF_RUN;
  const callId = env.WF_CALL;
  if (!runDir || !callId) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: "wf: WF_RUN and WF_CALL are not set; this shell is not serving a workflow call",
    };
  }

  if (rest.length > 1) {
    // Rejoining what the shell split would collapse whitespace inside string literals into
    // one space and still parse, so a wrong value would be accepted silently.
    return {
      exitCode: 2,
      stdout: "",
      stderr: "wf result takes one argument. Quote the JSON: wf result '<json>'",
    };
  }
  const raw = (rest[0] ?? "").trim();
  if (raw === "") {
    const call = await readCall(runDir, callId);
    const shape = call?.schema ? `\nexpected: ${JSON.stringify(call.schema)}` : "";
    return { exitCode: 2, stdout: "", stderr: `wf result needs one JSON argument.${shape}` };
  }

  const outcome = await acceptResult(runDir, callId, raw, "cli-callback", semantic);
  if (outcome.kind === "rejected") {
    // Nonzero and loud: the agent reads this on its own terminal, inside the same turn, and
    // corrects itself. Nothing re-prompts it.
    return {
      exitCode: 1,
      stdout: "",
      stderr: `wf: result rejected for call ${callId}.\n${outcome.error}\nFix the value and run wf result again.`,
    };
  }
  return { exitCode: 0, stdout: `wf: result accepted for call ${callId}`, stderr: "" };
}

if (import.meta.main) {
  const outcome = await runCli(process.argv.slice(2), process.env);
  if (outcome.stdout) console.log(outcome.stdout);
  if (outcome.stderr) console.error(outcome.stderr);
  process.exit(outcome.exitCode);
}
