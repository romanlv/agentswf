import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OutputRecord } from "../packages/contract/src/records";
import { runOperatorCli } from "../packages/engine/src/operator-cli";
import { type AnswerKey, KEY_FORMAT } from "../packages/lab/src/review/format/format";
import type { ReviewFinding, ScorerResult } from "../packages/lab/src/review/format/scoring";
import { checkScorerResult } from "../packages/lab/src/review/judge/check";
import { categoryOf } from "../packages/lab/src/review/judge/panel";
import { agreement } from "../packages/lab/src/review/metrics/metrics";
import { assertLiveOptIn } from "./live";

/**
 * The panel judge live (story 008, Task 3), on cheap models: a synthetic fixture, a two-file
 * change with two planted issues, and six findings with known labels. The judgement must pass
 * `checkScorerResult` and hit both planted issues; how many labels match, the judges' κ and the cost
 * are printed, not asserted, since they are what the eval measures. About a minute.
 */
const WORKFLOW = join(import.meta.dir, "../packages/lab/src/review/judge/judge.workflow.ts");
const PANEL = "codex/gpt-6-luna,claude/claude-haiku-4-5";
const TIEBREAK = "codex/gpt-6-luna";

const BASE_UPLOAD = `export async function upload(
  body: ReadableStream<Uint8Array>,
  send: (body: ReadableStream<Uint8Array>) => Promise<Response>,
): Promise<Response> {
  const response = await send(body);
  if (!response.ok) throw new Error(\`upload failed: \${response.status}\`);
  return response;
}
`;

const HEAD_UPLOAD = `export async function upload(
  body: ReadableStream<Uint8Array>,
  send: (body: ReadableStream<Uint8Array>) => Promise<Response>,
): Promise<Response> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await send(body);
    if (response.ok) return response;
  }
  throw new Error("upload failed after 3 attempts");
}
`;

const CONFIG = `export function parsePort(value: string): number {
  return parseInt(value, 10);
}

export function serverPort(env: Record<string, string | undefined>): number {
  return parsePort(env.PORT ?? "8080");
}
`;

function git(cwd: string, ...args: string[]): string {
  const run = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
  return run.stdout.toString().trim();
}

async function repository(root: string): Promise<{ repo: string; base: string; head: string }> {
  const repo = join(root, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  git(repo, "init", "--quiet", "--initial-branch", "review");
  git(repo, "config", "user.email", "eval@example.com");
  git(repo, "config", "user.name", "eval");
  await Bun.write(join(repo, "src/upload.ts"), BASE_UPLOAD);
  git(repo, "add", ".");
  git(repo, "commit", "--quiet", "-m", "upload");
  const base = git(repo, "rev-parse", "HEAD");
  await Bun.write(join(repo, "src/upload.ts"), HEAD_UPLOAD);
  await Bun.write(join(repo, "src/config.ts"), CONFIG);
  git(repo, "add", ".");
  git(repo, "commit", "--quiet", "-m", "Retry failed uploads; read the port from the environment");
  return { repo, base, head: git(repo, "rev-parse", "HEAD") };
}

const KEY: AnswerKey = {
  format: KEY_FORMAT,
  fixture: "synthetic-1",
  revision: 1,
  draftedBy: "hand",
  procedure: "hand",
  issues: [
    {
      id: "K1",
      mechanism:
        "Every retry passes the same ReadableStream to send; the first attempt consumes it, so a second attempt sends a locked or empty body and the retry cannot succeed.",
      visibleIn: "diff",
      severity: "must-fix",
      category: "correctness",
      scope: "change",
      locations: [{ path: "src/upload.ts", start: 5, end: 8 }],
      confirmation: { basis: "verified", how: "a stream can be read once" },
      sources: [{ commit: "c".repeat(40) }],
    },
    {
      id: "K2",
      mechanism:
        "parsePort returns NaN for a PORT that is not a number, and serverPort passes it on unchecked, so the server is started on NaN instead of failing with a clear error.",
      visibleIn: "diff",
      severity: "should-fix",
      category: "correctness",
      scope: "change",
      locations: [{ path: "src/config.ts", start: 1, end: 3 }],
      confirmation: { basis: "verified", how: "parseInt('abc', 10) is NaN" },
      sources: [{ commit: "c".repeat(40) }],
    },
  ],
  refuted: [
    {
      id: "R1",
      claim: "The retry loop has no bound and can retry forever.",
      reason: "false-premise",
      why: "The loop stops after three attempts.",
      sources: [{ commit: "c".repeat(40) }],
    },
  ],
  excluded: [
    {
      sources: [{ commit: "c".repeat(40) }],
      reason: "unconfirmed",
      claim: "Failed responses' bodies are never read, which may leak connections.",
    },
  ],
};

const FINDINGS: ReviewFinding[] = [
  {
    path: "src/upload.ts",
    line: 6,
    text: "Retrying calls send(body) with the same stream each time. After the first attempt the stream has been read, so later attempts send nothing useful.",
  },
  {
    path: "src/upload.ts",
    line: 5,
    text: "The retry loop has no upper bound and can spin forever.",
  },
  {
    path: "src/config.ts",
    line: 2,
    text: "parsePort doesn't validate its input: parseInt('abc', 10) is NaN, which then becomes the port.",
  },
  { path: "src/upload.ts", line: 1, text: "Consider a more descriptive name than `upload`." },
  {
    path: "src/upload.ts",
    line: 6,
    text: "Same stream issue as above: the body is reused on retry.",
  },
  {
    path: "src/upload.ts",
    line: 5,
    text: "Retries happen immediately with no delay or backoff, so a struggling server is hit three times at once.",
  },
];

/** What a careful judge says; only the hits are asserted, the rest is measured. */
const EXPECTED = ["hit:K1", "wrong", "hit:K2", "noise", "duplicate", "new"];

async function evaluate(): Promise<{ failed: string[]; record?: OutputRecord }> {
  const root = mkdtempSync(join(tmpdir(), "awf-judge-eval-"));
  try {
    const { repo, base, head } = await repository(root);
    const fixture = join(root, "fixture");
    mkdirSync(join(fixture, "key"), { recursive: true });
    await Bun.write(
      join(fixture, "fixture.json"),
      JSON.stringify({
        format: "awf.review-fixture/1",
        id: "synthetic-1",
        source: {
          forge: "gitlab",
          project: "eval/synthetic",
          number: 1,
          url: "https://gitlab.example/eval/synthetic/-/merge_requests/1",
          state: "merged",
        },
        snapshot: { version: 1, base, head, at: new Date().toISOString() },
        request: { asOf: new Date().toISOString(), removed: [] },
      }),
    );
    await Bun.write(
      join(fixture, "request.md"),
      "# Retry failed uploads\n\nUploads now retry up to three times. The server port comes from `PORT`.\n",
    );
    await Bun.write(join(fixture, "key", "key.json"), JSON.stringify(KEY));
    const findings = join(root, "findings.json");
    await Bun.write(findings, JSON.stringify(FINDINGS));

    const output: string[] = [];
    const exitCode = await runOperatorCli(
      [
        "run",
        "--json",
        "--timeout",
        "15m",
        "--run-root",
        join(root, "runs"),
        "--cwd",
        repo,
        WORKFLOW,
        "--",
        "--panel",
        PANEL,
        "--tiebreak",
        TIEBREAK,
        "--fixture",
        fixture,
        "--findings",
        findings,
      ],
      { stdout: (text) => output.push(text) },
    );
    const record = output.length > 0 ? (JSON.parse(output.join("\n")) as OutputRecord) : undefined;
    if (exitCode !== 0 || record?.outcome !== "succeeded") {
      return {
        failed: [`run did not succeed: exit ${exitCode}, ${record?.outcome ?? "no record"}`],
        ...(record ? { record } : {}),
      };
    }
    const judgement = record.value as ScorerResult;
    const checked = checkScorerResult(judgement, FINDINGS, KEY);
    const got = judgement.labels.map(categoryOf);
    const matched = got.filter((category, index) => category === EXPECTED[index]).length;
    const [a, b] = judgement.votes ?? [];
    console.error(`labels: ${got.join(", ")}`);
    console.error(`expected: ${EXPECTED.join(", ")}; ${matched}/${EXPECTED.length} match`);
    console.error(`κ between the panel: ${a && b ? agreement(a.labels, b.labels) : "n/a"}`);
    console.error(`votes: ${(judgement.votes ?? []).map((v) => `${v.by} (${v.role})`).join(", ")}`);
    return {
      failed: [
        ...(checked.ok ? [] : checked.problems.map((p) => `${p.path}: ${p.message}`)),
        ...(got[0] === "hit:K1" ? [] : [`finding 0 is ${got[0]}, not hit:K1`]),
        ...(got[2] === "hit:K2" ? [] : [`finding 2 is ${got[2]}, not hit:K2`]),
      ],
      record,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  assertLiveOptIn();
  const { failed, record } = await evaluate();
  for (const line of failed) console.error(line);
  console.log(
    JSON.stringify(
      {
        ok: failed.length === 0,
        failed,
        estimateUsd: record?.accounting.totals.estimate,
        ...(record && "value" in record ? { value: record.value } : {}),
      },
      null,
      2,
    ),
  );
  if (failed.length > 0) process.exitCode = 1;
}
