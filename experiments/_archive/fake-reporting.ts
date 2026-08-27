import type { FakeTurn } from "@wf/harness/testing";
import { runCli } from "@wf/engine";
import { RESULT_END, RESULT_START } from "./return-method";
import { resultFilePath } from "./trial";

/**
 * The three ways E2 had an agent report a value, as scripted acts for the fake backend. They
 * live here rather than beside the fake because two of the three are experiment vocabulary:
 * production settles a result through one channel.
 */

/** Runs the real `wf result`, including its rejection, and shows the agent what it printed. */
export function reportsViaCli(value: unknown): FakeTurn["act"] {
  return reportsRawViaCli(JSON.stringify(value));
}

export function reportsRawViaCli(raw: string): FakeTurn["act"] {
  return async (context) => {
    const outcome = await runCli(["result", raw], {
      WF_RUN: context.runDir,
      WF_CALL: context.callId,
    });
    context.print(outcome.stdout || outcome.stderr);
  };
}

export function writesFile(value: unknown): FakeTurn["act"] {
  return writesRawFile(JSON.stringify(value));
}

export function writesRawFile(raw: string): FakeTurn["act"] {
  return async (context) => {
    await Bun.write(resultFilePath(context.runDir, context.callId), raw);
  };
}

export function printsDelimited(value: unknown): FakeTurn["act"] {
  return printsRawDelimited(JSON.stringify(value));
}

export function printsRawDelimited(raw: string): FakeTurn["act"] {
  return (context) => {
    context.print(`${RESULT_START}\n${raw}\n${RESULT_END}`);
  };
}

/** An agent that answers in prose and reports nothing, which is the failure E2 counts. */
export function saysNothing(text = "Done — the answer is 4."): FakeTurn["act"] {
  return (context) => context.print(text);
}
