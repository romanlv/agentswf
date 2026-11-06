import type { EmitResultJson } from "@agentswf/contract/records";
import { isEventWorkflow, type JsonValue } from "@agentswf/contract/workflow";
import { EmitError, emitEvent, emitToRun } from "./emit";
import { messageOf } from "./errors";
import help from "./help/emit.txt" with { type: "text" };
import { asksJson, printRefusal, readFailureCode } from "./refusals";
import { type Out, parsePlace, type ReadPlace } from "./run-commands";
import { findRunByRef } from "./run-state";
import type { Launch } from "./wake";
import { loadWorkflowFile } from "./workflow-loader";

export const emitUsage = help.trimEnd();

type Event = { name: string; data: JsonValue; id?: string; source?: string };

/** `--target {file} --id {id}`, which may start the run; or a run that is there, by its ref. */
type Parsed = Event & { json: boolean } & (
    | { target: string; run: string; ref?: undefined }
    | { ref: string; place: ReadPlace; target?: undefined }
  );

export async function emitCommand(
  argv: readonly string[],
  shellCwd: string,
  out: Out,
  context: {
    home: string;
    environment: Readonly<Record<string, string | undefined>>;
    launch?: Launch;
  },
): Promise<number> {
  if (argv.includes("-h") || argv.includes("--help")) {
    out.stdout(emitUsage);
    return 0;
  }
  let parsed: Parsed;
  try {
    parsed = parse(argv, shellCwd);
  } catch (error) {
    printRefusal(out, { json: asksJson(argv), v: 1 }, error, "usage", emitUsage);
    return 2;
  }
  const json = { json: parsed.json, v: 1 };
  const event = {
    name: parsed.name,
    data: parsed.data,
    ...(parsed.id === undefined ? {} : { id: parsed.id }),
    ...(parsed.source === undefined ? {} : { source: parsed.source }),
  };
  let result: EmitResultJson;
  try {
    if (parsed.ref !== undefined) {
      const status = await findRunByRef(parsed.ref, parsed.place, context.home);
      result = await emitToRun(status, event, context);
    } else {
      const loaded = await loadWorkflowFile(parsed.target, shellCwd, context.home);
      if (!isEventWorkflow(loaded.workflow)) {
        printRefusal(out, json, `${loaded.file} declares no events; awf run starts it`, "event");
        return 2;
      }
      result = await emitEvent(
        loaded.workflow,
        { run: parsed.run, ...event },
        { from: "operator", ...context },
      );
    }
  } catch (error) {
    printRefusal(out, json, error, readFailureCode(error));
    return error instanceof EmitError ? 2 : 1;
  }
  return printEmit(result, parsed.json, out);
}

/** Prints an emit's result, as `awf emit` does: 1 when the run's attempt didn't start. */
export function printEmit(result: EmitResultJson, json: boolean, out: Out): number {
  out.stdout(json ? JSON.stringify(result) : emitLine(result));
  if (result.why !== "launch-failed") return 0;
  out.stderr(`awf: the run's attempt did not start: ${result.error}`);
  return 1;
}

/** `accepted dd-case/kombo: started`. */
function emitLine(result: EmitResultJson): string {
  const did = result.did === "none" ? result.why : result.did;
  return `${result.outcome} ${result.ref}${did === undefined ? "" : `: ${did}`}`;
}

function parse(argv: readonly string[], shellCwd: string): Parsed {
  const { place, json, rest } = parsePlace(argv, shellCwd);
  let target: string | undefined;
  let run: string | undefined;
  let id: string | undefined;
  let source: string | undefined;
  const words: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const word = rest[i]!;
    const value = () => {
      const next = rest[++i];
      if (next === undefined) throw new Error(`${word} needs a value`);
      return next;
    };
    if (word === "--target") target = value();
    else if (word === "--id") run = value();
    else if (word === "--event-id") id = value();
    else if (word === "--source") source = value();
    else if (word.startsWith("--")) throw new Error(`unknown option ${word}`);
    else words.push(word);
  }
  let form: { target: string; run: string } | { ref: string; place: ReadPlace };
  if (target !== undefined) {
    if (run === undefined) throw new Error("--id names the run the event is for, by its id");
    if (place.repeat.length > 0)
      throw new Error(
        "--cwd and --run-root find a run by its ref; --target's file names its project",
      );
    form = { target, run };
  } else {
    if (run !== undefined) throw new Error("--id goes with --target; a run's ref names it alone");
    const ref = words.shift();
    if (ref === undefined)
      throw new Error(
        "name the run, <workflow>/<id> or <id>, or the workflow by --target and --id",
      );
    form = { ref, place };
  }
  const [name, text, ...more] = words;
  if (name === undefined) throw new Error("the event's name is missing");
  if (more.length > 0) throw new Error(`one event at a time; also given: ${more.join(" ")}`);
  let data: JsonValue = null;
  if (text !== undefined) {
    try {
      data = JSON.parse(text) as JsonValue;
    } catch (error) {
      throw new Error(`the event's data is not JSON: ${messageOf(error)}`);
    }
  }
  return {
    ...form,
    name,
    data,
    ...(id === undefined ? {} : { id }),
    ...(source === undefined ? {} : { source }),
    json,
  };
}
