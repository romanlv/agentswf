import type { AgentSessionAdapter, HarnessTurn } from "./adapter";
import type {
  AgentSession,
  AgentSessionDriver,
  CallIdentity,
  SettledState,
  Step,
  TurnOutcome,
} from "./types";

export function createLegacyDriver(options: {
  kind: "pane" | "headless";
  timeoutMs: number;
  adapter(call: CallIdentity): AgentSessionAdapter & {
    legacyTranscript?(): Promise<string | null>;
    legacySessionRef?(): string | undefined;
  };
}): AgentSessionDriver {
  return {
    kind: options.kind,
    async open(step: Step, call: CallIdentity): Promise<AgentSession> {
      const deadline = () => ({ unixMilliseconds: Date.now() + options.timeoutMs });
      const adapter = options.adapter(call);
      const session = await adapter.activate({
        key: call.callId,
        deadline: deadline(),
        cwd: step.cwd ?? process.cwd(),
        execution: {
          harness: step.harness,
          model: step.model ?? "",
        },
      });
      let current: HarnessTurn | undefined;
      let currentBinding: { endpoint: string; operationId: string } | undefined;
      let currentDeadline: { unixMilliseconds: number } | undefined;
      let turn = 0;
      let transcript = "";
      return {
        async prompt(text: string): Promise<TurnOutcome> {
          turn += 1;
          const operationId = `${call.callId}:legacy:${turn}`;
          if (!current) {
            currentBinding = { endpoint: call.runDir, operationId };
            currentDeadline = deadline();
            current = await session.start(
              { id: operationId, prompt: text, deadline: currentDeadline },
              currentBinding,
            );
          } else {
            current = await current.nudge({
              id: operationId,
              prompt: text,
              deadline: currentDeadline!,
            });
          }
          const outcome = await current.settled;
          if (outcome.resultEvidence.kind === "transcript") {
            transcript += outcome.resultEvidence.text;
          }
          return {
            state: legacyState(outcome.state, outcome.detail),
            ...(outcome.detail ? { detail: outcome.detail } : {}),
            ...(outcome.chargesUsd[0] === undefined
              ? {}
              : { usage: { costUsd: outcome.chargesUsd[0] } }),
            ...(adapter.legacySessionRef?.() ? { sessionRef: adapter.legacySessionRef!() } : {}),
          };
        },
        async transcript() {
          if (transcript !== "") return transcript;
          return adapter.legacyTranscript?.() ?? null;
        },
        async close() {
          await session.close("legacy experiment complete");
        },
      };
    },
  };
}

function legacyState(
  state: "completed" | "blocked" | "timed-out" | "failed" | "cancelled",
  detail: string | undefined,
): SettledState {
  if (state === "completed") return detail === "idle" ? "idle" : "done";
  if (state === "blocked") return "blocked";
  return "unknown";
}
