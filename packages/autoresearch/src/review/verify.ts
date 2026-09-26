import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnswerKey } from "./format";
import { fetchBundle, git, restore } from "./git";
import type { GitLabDiscussion, GitLabMergeRequest } from "./gitlab-types";
import { orderVersions } from "./review-start";
import { accountable } from "./threads";
import {
  type Checked,
  checkAnswerKey,
  checkCollectRecord,
  checkFixture,
  checkVotes,
  keyProblems,
  type Problem,
  votesProblems,
} from "./validate";

export const SNAPSHOT_REF = "refs/fixture/head";

/**
 * Restores a fixture's frozen code into `target` with its later pushes beside it as
 * `refs/versions/<n>`: what the key is drafted and checked against. Never give it to a reviewer.
 */
export async function openKeyRepo(dir: string, clone: string, target: string): Promise<string> {
  const head = await restore({
    bundle: join(dir, "snapshot.bundle"),
    ref: SNAPSHOT_REF,
    clone,
    target,
  });
  const fixes = join(dir, "key", "fixes.bundle");
  if (existsSync(fixes)) await fetchBundle(target, fixes, clone, "refs/versions/*:refs/versions/*");
  return head;
}

/**
 * Checks a fixture folder end to end: its files are valid, it is the MR it claims to be, its
 * snapshot restores to the frozen head from a main-branch clone, and its key, if it has one, fits.
 */
export async function verifyFixture(
  dir: string,
  expect: { project: string; number: number; clone: string },
): Promise<Problem[]> {
  const problems: Problem[] = [];
  const fixture = checkFixture(await readJson(dir, "fixture.json", problems));
  if (!fixture.ok) problems.push(...fixture.problems.map((p) => at("fixture.json", p)));
  const record = checkCollectRecord(await readJson(dir, "key/evidence/collect.json", problems));
  if (!record.ok) problems.push(...record.problems.map((p) => at("key/evidence/collect.json", p)));
  const request = existsSync(join(dir, "request.md"))
    ? await Bun.file(join(dir, "request.md")).text()
    : "";
  if (!/^# \S/.test(request)) {
    problems.push({ path: "request.md", message: "missing, or doesn't start with the title" });
  }
  if (!fixture.ok) return problems;

  const { source, snapshot } = fixture.value;
  if (source.project !== expect.project || source.number !== expect.number) {
    problems.push({
      path: "fixture.json/source",
      message: `is ${source.project}!${source.number}, expected ${expect.project}!${expect.number}`,
    });
  }
  if (record.ok && record.value.reviewStart.version !== snapshot.version) {
    problems.push({ path: "key/evidence/collect.json", message: "names another version" });
  }

  const scratch = mkdtempSync(join(tmpdir(), "awf-verify-"));
  const repo = join(scratch, "repo");
  try {
    let head: string;
    try {
      head = await openKeyRepo(dir, expect.clone, repo);
    } catch (error) {
      problems.push({ path: "snapshot.bundle", message: `doesn't restore: ${String(error)}` });
      return problems;
    }
    if (head !== snapshot.head) {
      problems.push({
        path: "snapshot.bundle",
        message: `restores to ${head}, not ${snapshot.head}`,
      });
    }
    if (existsSync(join(dir, "key", "key.json"))) {
      const key = await verifyKey(dir, await readJson(dir, "key/key.json", problems), repo);
      if (!key.ok) problems.push(...key.problems.map((p) => at("key/key.json", p)));
      const file = "key/evidence/votes.json";
      const votes = checkVotes(await readJson(dir, file, problems));
      if (!votes.ok) problems.push(...votes.problems.map((p) => at(file, p)));
      if (key.ok && votes.ok) {
        problems.push(...votesProblems(key.value, votes.value).map((p) => at(file, p)));
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return problems;
}

/** Checks a key against its fixture, in a repository `openKeyRepo` made. */
export async function verifyKey(
  dir: string,
  value: unknown,
  repo: string,
): Promise<Checked<AnswerKey>> {
  const checked = checkAnswerKey(value);
  if (!checked.ok) return checked;
  const key = checked.value;
  const gitlab = join(dir, "key", "evidence", "gitlab");
  const discussions: GitLabDiscussion[] = await Bun.file(join(gitlab, "discussions.json")).json();
  const mr: GitLabMergeRequest = await Bun.file(join(gitlab, "merge-request.json")).json();
  const fixture = await Bun.file(join(dir, "fixture.json")).json();

  const paths = new Set(key.issues.flatMap((issue) => issue.locations.map((l) => l.path)));
  const lines = new Map([...paths].map((path) => [path, lineCount(repo, path)] as const));
  const versions = orderVersions(await Bun.file(join(gitlab, "versions.json")).json());
  // The MR's own commits each push added: not main's, not an earlier push's, and not a rebased
  // copy of either, which has a new id but the same patch.
  const later = new Map<number, Set<string>>();
  let previous = "review";
  for (const version of versions) {
    const ref = `refs/versions/${version.ordinal}`;
    if (!hasCommit(repo, ref)) continue;
    const newSince = (from: string) =>
      git(repo, [
        "rev-list",
        "--right-only",
        "--cherry-pick",
        "--no-merges",
        `${from}...${ref}`,
        `^${version.base_commit_sha}`,
      ])
        .split("\n")
        .filter(Boolean);
    // New against the previous push and against the frozen head: a push can go back to older code.
    const sinceFrozen = new Set(newSince("review"));
    later.set(version.ordinal, new Set(newSince(previous).filter((sha) => sinceFrozen.has(sha))));
    previous = ref;
  }

  const problems = keyProblems(key, {
    notes: new Map(discussions.map((d) => [d.id, new Set(d.notes.map((note) => note.id))])),
    mustAccount: discussions.filter((d) => accountable(d, mr.author.username)).map((d) => d.id),
    snapshotVersion: fixture.snapshot.version,
    lines,
    later,
  });
  return problems.length === 0 ? checked : { ok: false, problems };
}

function hasCommit(repo: string, ref: string): boolean {
  const found = Bun.spawnSync(["git", "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
    cwd: repo,
    stdout: "ignore",
    stderr: "ignore",
  });
  return found.exitCode === 0;
}

/** Lines in a file at the frozen head; null when the path is missing or isn't a file. */
function lineCount(repo: string, path: string): number | null {
  const shown = Bun.spawnSync(["git", "cat-file", "blob", `review:${path}`], {
    cwd: repo,
    stdout: "pipe",
    stderr: "ignore",
  });
  if (shown.exitCode !== 0) return null;
  const text = shown.stdout.toString();
  if (text === "") return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

async function readJson(dir: string, file: string, problems: Problem[]): Promise<unknown> {
  try {
    return await Bun.file(join(dir, file)).json();
  } catch (error) {
    problems.push({ path: file, message: `unreadable: ${String(error)}` });
    return undefined;
  }
}

function at(file: string, problem: Problem): Problem {
  return { path: `${file}${problem.path === "/" ? "" : problem.path}`, message: problem.message };
}
