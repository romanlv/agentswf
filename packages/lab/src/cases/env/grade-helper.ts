import { readFileSync, writeFileSync } from "node:fs";
import { CAPTURE_KIND, type Capture } from "./capture";
import { type CaseComparison, COMPARISON_KIND, type ComparisonCall } from "./compare";
import { type CodeGrader, GRADER_KIND } from "./grader";

/**
 * Runs in a Bun process of its own the lab starts in your checkout, so dataset code never loads
 * into the lab's process. Reads a request file and writes its answer to the file it names:
 *
 * - `grade`: runs one export of `graders.ts`; answers `{ grade, version }` or `{ error, version? }`.
 * - `capture`: runs the dataset's `capture.ts` on a real run; answers `{ cases }` or `{ error }`.
 * - `compare`: runs `graders.ts`'s `compare` on two columns' trials; answers `{ verdict, version }`,
 *   `{ none: true }` when it exports none, or `{ error }`.
 * - `versions`: each grader's declared version, without grading: a `graders.ts` export's, or a
 *   grader workflow's `meta.version` (null when it gives none); answers `{ versions }`, or
 *   `{ error }` naming the first that doesn't load.
 */
type Request =
  | {
      mode: "grade";
      file: string;
      name: string;
      input: Record<string, unknown>;
      facts: Record<string, unknown>;
      stages: Record<string, unknown>;
      out: string;
    }
  | {
      mode: "capture";
      /** The dataset's `capture.ts`. */
      file: string;
      input: { run: unknown; root: string };
      out: string;
    }
  | {
      mode: "compare";
      /** `graders.ts`. */
      file: string;
      input: ComparisonCall;
      out: string;
    }
  | {
      mode: "versions";
      /** `graders.ts` and the export names it should have, when the dataset has the file. */
      code?: { file: string; names: string[] };
      /** Grader workflows: name to file. */
      workflows: Record<string, string>;
      out: string;
    };

const request = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as Request;
const answer = (value: object) => writeFileSync(request.out, JSON.stringify(value));

const isGrader = (value: unknown): value is CodeGrader =>
  (value as CodeGrader | undefined)?.kind === GRADER_KIND &&
  typeof (value as CodeGrader).grade === "function";

const noExport = (file: string, name: string) =>
  `${file} exports no grader ${name}: export const ${name} = defineGrader({ grade })`;

if (request.mode === "compare") {
  try {
    const module = (await import(request.file)) as Record<string, unknown>;
    const comparison = module.compare as Partial<CaseComparison> | undefined;
    if (comparison === undefined) answer({ none: true });
    else if (comparison.kind !== COMPARISON_KIND || typeof comparison.compare !== "function") {
      answer({
        error: `${request.file}'s compare is not a comparison: export const compare = better.paired({ primary: "passed" })`,
      });
    } else {
      answer({ verdict: comparison.compare(request.input), version: comparison.version });
    }
  } catch (error) {
    answer({ error: error instanceof Error ? error.message : String(error) });
  }
} else if (request.mode === "capture") {
  try {
    const module = (await import(request.file)) as { default?: Partial<Capture> };
    const capture = module.default;
    if (capture?.kind !== CAPTURE_KIND || typeof capture.capture !== "function") {
      answer({
        error: `${request.file} has no capture as its default export: export default defineCapture(({ run, root }) => [...])`,
      });
    } else {
      answer({ cases: (await capture.capture(request.input as never)) ?? null });
    }
  } catch (error) {
    answer({ error: error instanceof Error ? error.message : String(error) });
  }
} else if (request.mode === "versions") {
  try {
    const versions: Record<string, string | null> = {};
    if (request.code) {
      const module = (await import(request.code.file)) as Record<string, unknown>;
      for (const name of request.code.names) {
        const grader = module[name];
        if (!isGrader(grader)) throw new Error(noExport(request.code.file, name));
        versions[name] = grader.version;
      }
    }
    const exports = request.code
      ? ((await import(request.code.file)) as Record<string, unknown>)
      : {};
    for (const [name, file] of Object.entries(request.workflows)) {
      if (isGrader(exports[name])) {
        throw new Error(
          `grader ${name}: ${file} and an export of graders.ts share the name; rename one`,
        );
      }
      let module: { default?: { kind?: unknown; meta?: { version?: unknown } } };
      try {
        module = await import(file);
      } catch (error) {
        throw new Error(`grader ${name}: ${file} does not load: ${(error as Error).message}`);
      }
      if (typeof module.default?.kind !== "string") {
        throw new Error(
          `grader ${name}: ${file} has no workflow as its default export: export default defineWorkflow({ … })`,
        );
      }
      const version = module.default.meta?.version;
      versions[name] = typeof version === "string" ? version : null;
    }
    answer({ versions });
  } catch (error) {
    answer({ error: error instanceof Error ? error.message : String(error) });
  }
} else {
  let version: string | undefined;
  try {
    const module = (await import(request.file)) as Record<string, unknown>;
    const grader = module[request.name];
    if (!isGrader(grader)) {
      answer({ error: noExport(request.file, request.name) });
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
}
process.exit(0);
