import { randomUUID } from "node:crypto";
import { OPERATOR_WAKE, type WakeResultJson } from "@agentswf/contract/records";
import { type Out, parsePlace, type ReadPlace } from "./command-line";
import { launchExit } from "./emit-command";
import help from "./help/wake.txt" with { type: "text" };
import { appendIn } from "./in-lines";
import { asksJson, printRefusal, readFailureCode } from "./refusals";
import { runLockFile, withRunLock } from "./run-lock";
import { wakeableTimers } from "./run-policy/waits";
import { findRunByRef, runStatus } from "./run-state";
import { clockTime } from "./run-text";
import { readWaits } from "./waits";
import { type Launch, wake } from "./wake";

/** `awf wake --json`'s `"v"`, which its refusals carry too. */
export const WAKE_V = 1 satisfies WakeResultJson["v"];

export const wakeUsage = help.trimEnd();

/** A run a wake can't apply to, as it stands: refused `wake`. */
class NotWoken extends Error {}

export async function wakeCommand(
  argv: readonly string[],
  shellCwd: string,
  out: Out,
  context: {
    home: string;
    environment: Readonly<Record<string, string | undefined>>;
    launch?: Launch;
    now?: () => number;
  },
): Promise<number> {
  let parsed: { ref: string; timer?: string; place: ReadPlace; json: boolean };
  try {
    parsed = parse(argv, shellCwd);
  } catch (error) {
    printRefusal(out, { json: asksJson(argv), v: WAKE_V }, error, "usage", wakeUsage);
    return 2;
  }
  const json = { json: parsed.json, v: WAKE_V };
  let result: WakeResultJson;
  try {
    const found = await findRunByRef(parsed.ref, parsed.place, context.home);
    const { run, ref } = found;
    if (!run.record.events) throw new NotWoken(`${ref} has no events, so nothing parks it`);
    result = await withRunLock(
      runLockFile(run.root, run.record.workflow, run.record.id),
      async () => {
        const now = context.now?.() ?? Date.now();
        // Read again under the lock: a wake or an attempt may have come since it was found.
        const { state } = await runStatus(run, undefined, now);
        // Running, it may be at a wait its process holds live, as `keepAlive` does: nudged, it reads
        // the wake as a parked run's next attempt would.
        if (state !== "parked" && state !== "running")
          throw new NotWoken(
            `${ref} is ${state}, not parked; awf runs ${ref} says what to run next`,
          );
        const timers = wakeableTimers(await readWaits(run.dir, now));
        const names = timers.map((timer) => timer.name);
        if (timers.length === 0)
          throw new NotWoken(
            state === "running"
              ? `${ref} is running, not at a wait with a timer`
              : `${ref}'s wait has no timer to fire; an event it takes wakes it: awf runs ${ref} says which`,
          );
        const chosen =
          parsed.timer === undefined ? undefined : timers.find((t) => t.name === parsed.timer);
        if (parsed.timer !== undefined && !chosen)
          throw new NotWoken(
            `${ref}'s wait has no timer ${parsed.timer}; it has ${names.join(", ")}`,
          );
        if (!chosen && timers.length > 1)
          throw new NotWoken(`${ref}'s wait has timers ${names.join(", ")}: name one with --timer`);
        const timer = chosen ?? timers[0]!;
        await appendIn(run.dir, {
          at: new Date(now).toISOString(),
          id: `awf.wake.${randomUUID()}`,
          name: OPERATOR_WAKE,
          data: { timer: timer.name },
          from: "operator",
        });
        const { cause: _, ...woken } = await wake(run, context);
        return { v: WAKE_V, ref, timer: timer.name, due: timer.due, ...woken };
      },
    );
  } catch (error) {
    printRefusal(out, json, error, error instanceof NotWoken ? "wake" : readFailureCode(error));
    return error instanceof NotWoken ? 2 : 1;
  }
  if (parsed.json) out.stdout(JSON.stringify(result));
  else {
    const did = result.did === "none" ? (result.why ?? "nothing") : result.did;
    out.stdout(
      `woke ${result.ref}: timer ${result.timer}, due ${clockTime(Date.parse(result.due))}, fired now; ${did}`,
    );
  }
  return launchExit(result, out);
}

function parse(
  argv: readonly string[],
  shellCwd: string,
): { ref: string; timer?: string; place: ReadPlace; json: boolean } {
  const { place, json, rest } = parsePlace(argv, shellCwd);
  let timer: string | undefined;
  const words: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const word = rest[i]!;
    if (word === "--timer") {
      timer = rest[++i];
      if (timer === undefined || timer.startsWith("--")) throw new Error("--timer needs a name");
    } else if (word.startsWith("-")) throw new Error(`wake takes no ${word}`);
    else words.push(word);
  }
  const [ref, ...more] = words;
  if (ref === undefined) throw new Error("name the run to wake, <workflow>/<id> or <id>");
  if (more.length > 0) throw new Error(`one run at a time; also given: ${more.join(" ")}`);
  return { ref, ...(timer === undefined ? {} : { timer }), place, json };
}
