import { readFileSync, writeFileSync } from "node:fs";
import { type CodeGrader, GRADER_KIND } from "./grader";

/**
 * Runs one export of a dataset's `graders.ts`, in a Bun process of its own the lab starts in your
 * checkout, so dataset code never loads into the lab's process. Reads a request file and writes
 * `{ grade, version }` or `{ error, version? }` to the file the request names.
 */
type Request = {
  file: string;
  name: string;
  input: Record<string, unknown>;
  facts: Record<string, unknown>;
  stages: Record<string, unknown>;
  out: string;
};

const request = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as Request;
const answer = (value: object) => writeFileSync(request.out, JSON.stringify(value));

let version: string | undefined;
try {
  const module = (await import(request.file)) as Record<string, unknown>;
  const grader = module[request.name] as CodeGrader | undefined;
  if (grader?.kind !== GRADER_KIND || typeof grader.grade !== "function") {
    answer({
      error: `${request.file} exports no grader ${request.name}: export const ${request.name} = defineGrader({ grade })`,
    });
  } else {
    version = grader.version;
    const input = grader.readsFacts
      ? { ...request.input, facts: request.facts, stages: request.stages }
      : request.input;
    answer({ grade: (await grader.grade(input as never)) ?? null, version });
  }
} catch (error) {
  answer({ error: error instanceof Error ? error.message : String(error), version });
}
process.exit(0);
