import { acceptAny, type SemanticCheck } from "@wf/contract";
import type { AttemptSource } from "@wf/contract/records";
import { evaluateResult } from "./result-validation";
import { readCall, recordAttempt, writeAcceptedExclusive } from "./run-dir";

export type Acceptance =
  | { kind: "accepted"; value: unknown }
  | { kind: "rejected"; error: string };

/** Frozen E2/E5 compatibility. Production submission goes through the control plane. */
export async function acceptResult(
  runDir: string,
  callId: string,
  raw: string,
  source: AttemptSource,
  semantic: SemanticCheck = acceptAny,
): Promise<Acceptance> {
  const call = await readCall(runDir, callId);
  if (!call) return { kind: "rejected", error: `no call ${callId} is recorded in ${runDir}` };

  const evaluated = await evaluateResult(call, raw, semantic);
  const accepted =
    evaluated.kind === "accepted" &&
    (await writeAcceptedExclusive(runDir, callId, evaluated.value));
  const error =
    evaluated.kind === "rejected"
      ? evaluated.error
      : accepted
        ? undefined
        : "a valid result has already settled this call";
  await recordAttempt(runDir, callId, {
    at: new Date().toISOString(),
    source,
    accepted,
    raw,
    ...(error ? { error } : {}),
  });
  return accepted ? evaluated : { kind: "rejected", error: error ?? "result rejected" };
}

export type CliOutcome = { exitCode: number; stdout: string; stderr: string };

/** Frozen experiment driver, not the installed `wf` command. */
export async function runCli(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  semantic: SemanticCheck = acceptAny,
): Promise<CliOutcome> {
  const [command, ...rest] = argv;
  if (command !== "result") {
    return { exitCode: 2, stdout: "", stderr: "wf result '<json>'" };
  }
  const runDir = env.WF_RUN;
  const callId = env.WF_CALL;
  if (!runDir || !callId) {
    return { exitCode: 2, stdout: "", stderr: "wf: WF_RUN and WF_CALL are not set" };
  }
  if (rest.length > 1) {
    return { exitCode: 2, stdout: "", stderr: "Quote the JSON: wf result '<json>'" };
  }
  const raw = (rest[0] ?? "").trim();
  if (raw === "") {
    const call = await readCall(runDir, callId);
    const shape = call?.schema ? `\nexpected: ${JSON.stringify(call.schema)}` : "";
    return { exitCode: 2, stdout: "", stderr: `wf result needs one JSON argument.${shape}` };
  }

  const outcome = await acceptResult(runDir, callId, raw, "cli-callback", semantic);
  return outcome.kind === "accepted"
    ? { exitCode: 0, stdout: `wf: result accepted for call ${callId}`, stderr: "" }
    : {
        exitCode: 1,
        stdout: "",
        stderr: `wf: result rejected for call ${callId}.\n${outcome.error}\nFix the value and run wf result again.`,
      };
}
