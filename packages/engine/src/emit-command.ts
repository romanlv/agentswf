import type { EmitResultJson } from "@agentswf/contract/records";
import type { JsonValue } from "@agentswf/contract/workflow";
import { EmitError, emitEvent } from "./emit";
import { messageOf } from "./errors";
import type { Out } from "./run-commands";
import type { Launch } from "./wake";
import { loadWorkflowFile } from "./workflow-loader";

export const emitUsage = [
  "usage: awf emit --target <file> <event> [<json>] [--id <id>] [--json]",
  "",
  "Sends an event to a workflow with events. Its key's run starts if it has none and the event is",
  "one that starts one, and is woken if it has one: nudged while it runs, continued when it is",
  "parked or crashed. The run lives in the project of <file>, the nearest directory above it",
  "holding .awf/, whoever sends. --id names the occurrence: the same id again is a duplicate.",
  "",
  "Prints what became of the event, and what was done to the run: accepted, duplicate or refused.",
  "--json prints one document. Exits 0 for any of the three, 1 when the run's attempt could not be",
  "started (the event is kept, and the next event or awf tick tries again), 2 when the event is",
  "wrong for its target: its name, its data, or its id.",
].join("\n");

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
  let parsed: { target: string; name: string; data: JsonValue; id?: string; json: boolean };
  try {
    parsed = parse(argv);
  } catch (error) {
    out.stderr(`awf: ${messageOf(error)}\n\n${emitUsage}`);
    return 2;
  }
  let result: EmitResultJson;
  try {
    const loaded = await loadWorkflowFile(parsed.target, shellCwd);
    if (!loaded.keyed) {
      out.stderr(`awf: ${loaded.file} declares no events; awf run starts it`);
      return 2;
    }
    result = await emitEvent(
      { file: loaded.file, definition: loaded.keyed },
      {
        name: parsed.name,
        data: parsed.data,
        ...(parsed.id === undefined ? {} : { id: parsed.id }),
      },
      { from: "operator", ...context },
    );
  } catch (error) {
    out.stderr(`awf: ${messageOf(error)}`);
    return error instanceof EmitError ? 2 : 1;
  }
  out.stdout(parsed.json ? JSON.stringify(result) : emitLine(result));
  if (result.why !== "launch-failed") return 0;
  out.stderr(`awf: the run's attempt did not start: ${result.error}`);
  return 1;
}

/** `accepted dd-case/dd-case.kombo: started`, as `awf emit` and `awf send` print an emit. */
export function emitLine(result: EmitResultJson): string {
  const did = result.did === "none" ? result.why : result.did;
  return `${result.outcome} ${result.run}${did === undefined ? "" : `: ${did}`}`;
}

function parse(argv: readonly string[]): {
  target: string;
  name: string;
  data: JsonValue;
  id?: string;
  json: boolean;
} {
  let target: string | undefined;
  let id: string | undefined;
  let json = false;
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i]!;
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${word} needs a value`);
      return next;
    };
    if (word === "--target") target = value();
    else if (word === "--id") id = value();
    else if (word === "--json") json = true;
    else if (word.startsWith("--")) throw new Error(`unknown option ${word}`);
    else words.push(word);
  }
  if (target === undefined) throw new Error("--target names the workflow file the event is for");
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
  return { target, name, data, ...(id === undefined ? {} : { id }), json };
}
