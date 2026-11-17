import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Type from "typebox";
import { checkSchema, describeProblems } from "../../shared/validate";
import { GraderEntrySchema } from "../format/records";
import { type DatasetInfo, GRADERS_FILE, sha256 } from "./dataset";
import type { LabGrader } from "./trial";

const HELPER = join(import.meta.dir, "../env/grade-helper.ts");

/** What a grader returns: its entry's verdict, numbers, reasons and notApplies, nothing else. */
const AnswerSchema = Type.Object(
  {
    verdict: Type.Optional(Type.Index(GraderEntrySchema, ["verdict"])),
    numbers: Type.Optional(Type.Index(GraderEntrySchema, ["numbers"])),
    reasons: Type.Optional(Type.Index(GraderEntrySchema, ["reasons"])),
    notApplies: Type.Optional(Type.Index(GraderEntrySchema, ["notApplies"])),
  },
  { additionalProperties: false },
);

/**
 * The dataset's own graders, each run in a Bun process started in `root`, your checkout, so
 * `graders.ts` resolves its imports there and never loads into the lab's process.
 */
export function codeGraders(dataset: DatasetInfo, root: string, timeoutMs: number): LabGrader[] {
  const names = (dataset.dataset.graders ?? []).filter((g): g is string => typeof g === "string");
  if (names.length === 0) return [];
  const file = join(dataset.dir, GRADERS_FILE);
  return names.map((name) => ({
    name,
    // `graders.ts` only: an edit to a module it imports keeps the digest.
    code: () => sha256(`${name}\n${existsSync(file) ? readFileSync(file, "utf8") : ""}`),
    async grade(input) {
      const request = join(input.work, `grade-${name}.json`);
      const out = join(input.work, `grade-${name}.out.json`);
      const said = join(input.work, `grade-${name}.err.txt`);
      writeFileSync(
        request,
        JSON.stringify({
          file,
          name,
          input: {
            case: input.case,
            result: input.result ?? null,
            scratch: input.scratch,
            kept: input.kept,
          },
          facts: input.facts,
          stages: input.stages,
          out,
        }),
      );
      try {
        // Its output goes to a file, never a pipe: a process the grader left running would hold a
        // pipe open, and the lab would wait on it after the kill.
        const child = Bun.spawn([process.execPath, HELPER, request], {
          cwd: root,
          stdin: "ignore",
          stdout: "ignore",
          stderr: Bun.file(said),
          env: input.env,
        });
        const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
        await child.exited;
        clearTimeout(timer);
        if (!existsSync(out)) {
          const last = existsSync(said)
            ? readFileSync(said, "utf8").trim().split("\n").at(-1)
            : undefined;
          throw new Error(
            child.signalCode
              ? `grader ${name} took longer than ${Math.round(timeoutMs / 1000)}s`
              : `grader ${name} exited ${child.exitCode}${last ? `: ${last}` : ""}`,
          );
        }
        const answer = JSON.parse(readFileSync(out, "utf8")) as { grade?: unknown; error?: string };
        if (answer.error !== undefined) throw new Error(answer.error);
        const checked = checkSchema(AnswerSchema, answer.grade ?? {});
        if (!checked.ok) {
          throw new Error(describeProblems(`grader ${name}'s answer`, checked.problems));
        }
        const grade = checked.value;
        const judged = grade.verdict !== undefined || grade.numbers !== undefined;
        if (!judged && grade.notApplies === undefined) {
          throw new Error(
            `grader ${name} gave no verdict, numbers or notApplies: did grade return its answer?`,
          );
        }
        if (judged && grade.notApplies !== undefined) {
          throw new Error(
            `grader ${name} gave notApplies with a verdict or numbers: one or the other`,
          );
        }
        return { ...grade, reasons: grade.reasons ?? [] };
      } finally {
        for (const each of [request, out, said]) rmSync(each, { force: true });
      }
    },
  }));
}
