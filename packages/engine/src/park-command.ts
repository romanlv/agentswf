import { randomUUID } from "node:crypto";
import { OPERATOR_PARK, type ParkResultJson } from "@agentswf/contract/records";
import { type Out, parsePlace, type ReadPlace } from "./command-line";
import help from "./help/park.txt" with { type: "text" };
import { appendIn } from "./in-lines";
import { asksJson, printRefusal, readFailureCode } from "./refusals";
import { runLockFile, withRunLock } from "./run-lock";
import { findRunByRef, runStatus } from "./run-state";
import type { Run } from "./runs";
import { readWaits } from "./waits";
import { nudgeOver } from "./wake";

/** `awf park --json`'s `"v"`, which its refusals carry too. */
export const PARK_V = 1 satisfies ParkResultJson["v"];

export const parkUsage = help.trimEnd();

/** A run a park can't apply to, as it stands: refused `park`. */
class NotParked extends Error {}

export async function parkCommand(
  argv: readonly string[],
  shellCwd: string,
  out: Out,
  context: {
    home: string;
    environment: Readonly<Record<string, string | undefined>>;
    /** Asks the live run's wait to read its files again; false when it couldn't be reached. */
    nudge?: (run: Run) => Promise<boolean>;
    now?: () => number;
  },
): Promise<number> {
  let parsed: { ref: string; place: ReadPlace; json: boolean };
  try {
    parsed = parse(argv, shellCwd);
  } catch (error) {
    printRefusal(out, { json: asksJson(argv), v: PARK_V }, error, "usage", parkUsage);
    return 2;
  }
  const json = { json: parsed.json, v: PARK_V };
  let result: ParkResultJson;
  try {
    const { run, ref } = await findRunByRef(parsed.ref, parsed.place, context.home);
    if (!run.record.events) throw new NotParked(`${ref} has no events, so it never parks`);
    result = await withRunLock(
      runLockFile(run.root, run.record.workflow, run.record.id),
      async () => {
        const now = context.now?.() ?? Date.now();
        // Read again under the lock, which a claim and a park also hold: the attempt stays this one.
        const status = await runStatus(run, undefined, now);
        if (status.state === "parked") return { v: PARK_V, ref, did: "parked-already" as const };
        const attempt = status.attempts.at(-1);
        // A run with no attempt claimed reads `running` while its lock is held, as this holds it.
        if (status.state !== "running" || !attempt || attempt.ended !== undefined)
          throw new NotParked(
            `${ref} ${status.state === "running" ? "has no attempt running" : `is ${status.state}, not running`}; awf runs ${ref} says what to run next`,
          );
        const n = attempt.attempt;
        const warm = status.warm !== undefined;
        if ((await readWaits(run.dir, now)).parks.has(n))
          return { v: PARK_V, ref, did: "asked-already" as const, attempt: n, warm };
        await appendIn(run.dir, {
          at: new Date(now).toISOString(),
          id: `awf.park.${randomUUID()}`,
          name: OPERATOR_PARK,
          data: { attempt: n },
          from: "operator",
        });
        // Only a nudge, never a launch: an attempt that died meanwhile is not the one asked. One that
        // fails is no matter, as the live wait looks at in.jsonl within a second.
        await (context.nudge ?? nudgeOver(context))(run);
        return { v: PARK_V, ref, did: "asked" as const, attempt: n, warm };
      },
    );
  } catch (error) {
    printRefusal(out, json, error, error instanceof NotParked ? "park" : readFailureCode(error));
    return error instanceof NotParked ? 2 : 1;
  }
  if (parsed.json) out.stdout(JSON.stringify(result));
  else if (result.did === "parked-already") out.stdout(`${result.ref} is parked already`);
  else {
    const when = result.warm ? "at its wait now" : "at its next wait, once its turn ends";
    const again = result.did === "asked-already" ? ", asked before" : "";
    out.stdout(`parking ${result.ref}: attempt ${result.attempt}, ${when}${again}`);
  }
  return 0;
}

function parse(
  argv: readonly string[],
  shellCwd: string,
): { ref: string; place: ReadPlace; json: boolean } {
  const { place, json, rest } = parsePlace(argv, shellCwd);
  const words: string[] = [];
  for (const word of rest) {
    if (word.startsWith("-")) throw new Error(`park takes no ${word}`);
    words.push(word);
  }
  const [ref, ...more] = words;
  if (ref === undefined) throw new Error("name the run to park, <workflow>/<id> or <id>");
  if (more.length > 0) throw new Error(`one run at a time; also given: ${more.join(" ")}`);
  return { ref, place, json };
}
