import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkVersion, DEFAULT_VERSION } from "../../shared/version";
import { checkAnswer } from "./answer";
import { type DatasetInfo, GRADERS_FILE, graderSpecs } from "./dataset";
import type { LabGrader } from "./grading";

const HELPER = join(import.meta.dir, "../env/grade-helper.ts");

let requests = 0;

/**
 * Starts the grade helper in `root` on a request and reads its answer. Its output goes to a file,
 * never a pipe: a process the grader left running would hold a pipe open, and the lab would wait
 * on it after the kill.
 */
export async function runHelper(
  request: Record<string, unknown>,
  options: {
    root: string;
    work: string;
    env: Record<string, string>;
    timeoutMs: number;
    name: string;
  },
): Promise<Record<string, unknown>> {
  mkdirSync(options.work, { recursive: true });
  const stem = join(options.work, `helper-${options.name}-${process.pid}-${++requests}`);
  const file = `${stem}.json`;
  const out = `${stem}.out.json`;
  const said = `${stem}.err.txt`;
  writeFileSync(file, JSON.stringify({ ...request, out }));
  try {
    const child = Bun.spawn([process.execPath, HELPER, file], {
      cwd: options.root,
      stdin: "ignore",
      stdout: "ignore",
      stderr: Bun.file(said),
      env: options.env,
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
    await child.exited;
    clearTimeout(timer);
    if (!existsSync(out)) {
      const last = existsSync(said)
        ? readFileSync(said, "utf8").trim().split("\n").at(-1)
        : undefined;
      throw new Error(
        child.signalCode
          ? `grader ${options.name} took longer than ${Math.round(options.timeoutMs / 1000)}s`
          : `grader ${options.name} exited ${child.exitCode}${last ? `: ${last}` : ""}`,
      );
    }
    return JSON.parse(readFileSync(out, "utf8")) as Record<string, unknown>;
  } finally {
    for (const each of [file, out, said]) rmSync(each, { force: true });
  }
}

/**
 * The dataset's own code graders, each run in a Bun process started in `root`, your checkout, so
 * `graders.ts` resolves its imports there and never loads into the lab's process.
 */
export function codeGraders(dataset: DatasetInfo, root: string, timeoutMs: number): LabGrader[] {
  const file = join(dataset.dir, GRADERS_FILE);
  return graderSpecs(dataset)
    .filter((spec) => spec.kind === "code")
    .map(({ name, onDemand }) => ({
      name,
      ...(onDemand ? { onDemand: true } : {}),
      async grade(input) {
        const answer = (await runHelper(
          {
            mode: "grade",
            file,
            name,
            input: {
              case: input.case,
              result: input.result ?? null,
              scratch: input.scratch,
              kept: input.kept,
              params: input.params,
            },
            facts: input.facts,
            stages: input.stages,
          },
          { root, work: input.work, env: input.env, timeoutMs, name },
        )) as { grade?: unknown; error?: string; version?: string };
        if (answer.version !== undefined && checkVersion(answer.version)) {
          throw new Error(`grader ${name}: ${checkVersion(answer.version)}`);
        }
        const withVersion = (error: Error) =>
          Object.assign(error, answer.version ? { version: answer.version } : {});
        if (answer.error !== undefined) throw withVersion(new Error(answer.error));
        try {
          return {
            ...checkAnswer(name, answer.grade),
            ...(answer.version ? { version: answer.version } : {}),
          };
        } catch (error) {
          throw withVersion(error as Error);
        }
      },
    }));
}

/**
 * Each dataset grader's declared version, read in a helper process without grading: a code
 * grader's `version`, a grader workflow's `meta.version` (`1.0.0` when it gives none). Throws,
 * naming the first grader that doesn't load.
 */
export async function graderVersions(
  dataset: DatasetInfo,
  options: { root: string; work: string; env: Record<string, string>; timeoutMs: number },
): Promise<Map<string, string>> {
  const specs = graderSpecs(dataset);
  if (specs.length === 0) return new Map();
  const code = specs.filter((s) => s.kind === "code").map((s) => s.name);
  const workflows = Object.fromEntries(
    specs.flatMap((s) => (s.kind === "workflow" ? [[s.name, s.file] as const] : [])),
  );
  const gradersFile = join(dataset.dir, GRADERS_FILE);
  const answer = (await runHelper(
    {
      mode: "versions",
      ...(existsSync(gradersFile) ? { code: { file: gradersFile, names: code } } : {}),
      workflows,
    },
    { ...options, name: "versions" },
  )) as { versions?: Record<string, string | null>; error?: string };
  if (answer.error !== undefined) throw new Error(answer.error);
  const versions = new Map<string, string>();
  for (const [name, version] of Object.entries(answer.versions ?? {})) {
    const value = version ?? DEFAULT_VERSION;
    const bad = checkVersion(value);
    if (bad) throw new Error(`grader ${name}: ${bad}`);
    versions.set(name, value);
  }
  return versions;
}
