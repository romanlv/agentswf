import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digestFixture } from "../packages/lab/src/review/fixtures/seal";
import { type AnswerKey, KEY_FORMAT } from "../packages/lab/src/review/format/format";

/**
 * A synthetic awf-lab workspace, shared by the lab's offline tests and its live eval: a sealed
 * dataset of two cases cut from one project, a config, and a tsconfig.json that finds the package,
 * as a real one outside awf must.
 */

const REVIEW_INDEX = join(import.meta.dir, "../packages/lab/src/review/index.ts");
const COMPARE_INDEX = join(import.meta.dir, "../packages/lab/src/compare/index.ts");
export const CANNED = join(import.meta.dir, "fixtures/lab/canned.workflow.ts");
const EXACT = join(import.meta.dir, "fixtures/lab/exact-judge.workflow.ts");

export function git(cwd: string, ...args: string[]): string {
  const run = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
  return run.stdout.toString().trim();
}

export const mechanism = (caseId: string, n: number) => `${caseId} issue ${n}: what goes wrong`;

function keyOf(caseId: string): AnswerKey {
  const issue = (n: number, severity: "must-fix" | "should-fix") => ({
    id: `K${n}`,
    mechanism: mechanism(caseId, n),
    visibleIn: "diff" as const,
    severity,
    category: "correctness" as const,
    scope: "change" as const,
    locations: [{ path: "src/app.ts", start: 1, end: 1 }],
    confirmation: { basis: "verified" as const, how: "traced" },
    sources: [{ commit: "c".repeat(40) }],
  });
  return {
    format: KEY_FORMAT,
    fixture: caseId,
    revision: 1,
    draftedBy: "hand",
    procedure: "hand",
    issues: [issue(1, "must-fix"), issue(2, "should-fix")],
    refuted: [],
    excluded: [],
  };
}

export type Workspace = {
  root: string;
  heads: Record<string, string>;
  answers: string;
  variant: (name: string, body?: string) => Promise<string>;
  scorer: (name: string, mode: string) => Promise<string>;
};

export const CONFIG = {
  clone: "project",
  datasets: "datasets",
  dataset: "first",
  results: "results",
  runs: "runs",
  variants: ["ideas/*.variant.ts"],
  scorers: ["scorers/*.scorer.ts"],
  scorer: "exact",
};

/** The workspace, in a fresh temp directory the caller removes. */
export async function workspace(): Promise<Workspace> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "awf-lab-test-")));
  const project = join(root, "project");
  mkdirSync(join(project, "src"), { recursive: true });
  git(project, "init", "--quiet", "--initial-branch", "main");
  git(project, "config", "user.email", "t@example.com");
  git(project, "config", "user.name", "t");
  // As a clone names its default branch; a restored case is laid out after it.
  git(project, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  await Bun.write(join(project, "src/app.ts"), "export const a = 1;\n");
  git(project, "add", ".");
  git(project, "commit", "--quiet", "-m", "base");
  const base = git(project, "rev-parse", "HEAD");
  git(project, "update-ref", "refs/remotes/origin/main", base);
  const dataset = join(root, "datasets", "first");
  const heads: Record<string, string> = {};
  const entries = [];
  for (const [n, id] of ["app-1", "app-2"].entries()) {
    git(project, "checkout", "--quiet", "-b", id, base);
    await Bun.write(join(project, "src/app.ts"), `export const a = ${n + 2};\n`);
    git(project, "commit", "--quiet", "-am", id);
    const head = git(project, "rev-parse", "HEAD");
    heads[id] = head;
    const dir = join(dataset, id);
    mkdirSync(join(dir, "key"), { recursive: true });
    git(project, "update-ref", "refs/fixture/head", head);
    git(
      project,
      "bundle",
      "create",
      "--quiet",
      join(dir, "snapshot.bundle"),
      "refs/fixture/head",
      `^${base}`,
    );
    await Bun.write(
      join(dir, "fixture.json"),
      JSON.stringify({
        format: "awf.review-fixture/1",
        id,
        source: {
          forge: "gitlab",
          project: "group/app",
          number: n + 1,
          url: `https://gitlab.example/group/app/-/merge_requests/${n + 1}`,
          state: "merged",
        },
        snapshot: { version: 1, base, head, at: "2026-06-01T00:00:00Z" },
        request: { asOf: "2026-06-01T00:00:00Z", removed: [] },
      }),
    );
    await Bun.write(join(dir, "request.md"), `# Change ${id}\n\nIt changes a.\n`);
    await Bun.write(join(dir, "key", "key.json"), JSON.stringify(keyOf(id)));
    entries.push({ id, at: "2026-06-01T00:00:00Z", digest: await digestFixture(dir) });
  }
  git(project, "checkout", "--quiet", "main");
  await Bun.write(
    join(dataset, "set.json"),
    JSON.stringify({
      format: "awf.fixture-set/1",
      name: "first",
      builtAt: "2026-06-02T00:00:00Z",
      builder: "test",
      fixtures: entries,
      excluded: [],
    }),
  );
  await Bun.write(join(root, "awf-lab.json"), JSON.stringify(CONFIG));
  await Bun.write(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        paths: { "@agentswf/lab/review": [REVIEW_INDEX], "@agentswf/lab/compare": [COMPARE_INDEX] },
      },
    }),
  );
  const answers = join(root, "answers.json");
  await Bun.write(answers, JSON.stringify({}));
  mkdirSync(join(root, "ideas"));
  mkdirSync(join(root, "scorers"));
  const ws: Workspace = {
    root,
    heads,
    answers,
    async variant(name, body) {
      const file = join(root, "ideas", `${name}.variant.ts`);
      await Bun.write(
        file,
        body ??
          `import { defineReviewVariant } from "@agentswf/lab/review";
import canned from ${JSON.stringify(CANNED)};

export default defineReviewVariant({
  workflow: canned,
  argv: ["--answers", ${JSON.stringify(answers)}, "--head", "{head}", "--request", "{request}", "--range", "{base}...HEAD"],
  timeout: "1m",
  read: (result) => result.findings.map((f) => ({ path: f.file, line: f.line, text: f.claim })),
});
`,
      );
      return file;
    },
    async scorer(name, mode) {
      const file = join(root, "scorers", `${name}.scorer.ts`);
      await Bun.write(
        file,
        `import { defineReviewScorer } from "@agentswf/lab/review";
import exact from ${JSON.stringify(EXACT)};

export default defineReviewScorer({
  workflow: exact,
  argv: ["--mode", ${JSON.stringify(mode)}],
  timeout: "1m",
});
`,
      );
      return file;
    },
  };
  await ws.scorer("exact", "plain");
  return ws;
}
