import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CollectOptions, collect } from "./collect";
import { git, restore } from "./git";
import type { MergeRequestSource } from "./gitlab";
import type {
  DescriptionVersion,
  GitLabDiscussion,
  GitLabMergeRequest,
  GitLabVersion,
} from "./gitlab-types";
import { sealSet, verifySet } from "./seal";
import { checkCollectRecord, checkFixture } from "./validate";
import { openKeyRepo, verifyFixture } from "./verify";

const ID = ["-c", "user.name=t", "-c", "user.email=t@example.com"];

let root: string;
let remote: string;
let clone: string;
let out: string;

function commit(repo: string, file: string, text: string, message: string): string {
  writeFileSync(join(repo, file), text);
  git(repo, ["add", file]);
  git(repo, [...ID, "commit", "--quiet", "-m", message]);
  return git(repo, ["rev-parse", "HEAD"]);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "awf-collect-test-"));
  remote = join(root, "remote");
  clone = join(root, "clone");
  out = join(root, "set");
  git(root, ["init", "--quiet", "-b", "main", remote]);
  // GitLab serves commits by sha after their branch is gone; a local remote needs telling.
  git(remote, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
  commit(remote, "app.ts", "one\n", "m1");
  commit(remote, "app.ts", "one\ntwo\n", "m2");
  git(root, ["clone", "--quiet", remote, clone]);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function mrData(overrides: Partial<GitLabMergeRequest> = {}): GitLabMergeRequest {
  return {
    title: "Add three",
    description: "Adds three.",
    state: "merged",
    draft: false,
    web_url: "https://gitlab.example/acme/shop/-/merge_requests/7",
    updated_at: "2026-01-05T00:00:00Z",
    author: { username: "author" },
    ...overrides,
  };
}

function version(id: number, head: string, base: string, at: string): GitLabVersion {
  return {
    id,
    head_commit_sha: head,
    base_commit_sha: base,
    start_commit_sha: base,
    created_at: at,
  };
}

function comment(at: string, head: string, by = "reviewer", id = 1): GitLabDiscussion {
  return {
    id: `d${id}`,
    notes: [
      {
        id,
        type: "DiffNote",
        body: "This drops two.",
        system: false,
        created_at: at,
        author: { username: by },
        position: { head_sha: head, new_path: "app.ts", new_line: 2 },
      },
    ],
  };
}

function source(data: {
  mr?: GitLabMergeRequest;
  versions: GitLabVersion[];
  discussions: GitLabDiscussion[];
  descriptions?: DescriptionVersion[];
}): MergeRequestSource {
  return {
    fetch: async () => ({
      project: { default_branch: "main" },
      mr: data.mr ?? mrData(),
      versions: data.versions,
      discussions: data.discussions,
      descriptions: data.descriptions ?? [],
    }),
  };
}

const options = (extra: Partial<CollectOptions> = {}): CollectOptions => ({
  project: "acme/shop",
  mr: 7,
  clone,
  out,
  ...extra,
});

const run = (data: Parameters<typeof source>[0], extra: Partial<CollectOptions> = {}) =>
  collect(options(extra), { source: source(data) });

async function restoreInto(name: string): Promise<{ target: string; head: string }> {
  const target = join(root, name);
  const head = await restore({
    bundle: join(out, "shop-7", "snapshot.bundle"),
    ref: "refs/fixture/head",
    clone,
    target,
  });
  return { target, head };
}

/** A restored repo must not say which MR it is, nor hold anything past the frozen head. */
function expectSealed(target: string, id = "shop-7"): void {
  expect(existsSync(join(target, ".git", "logs"))).toBe(false);
  expect(existsSync(join(target, ".git", "FETCH_HEAD"))).toBe(false);
  expect(git(target, ["remote"])).toBe("");
  expect(git(target, ["branch", "--all", "--format=%(refname)"])).toBe("refs/heads/review");
  const config = Bun.spawnSync(["cat", join(target, ".git", "config")]).stdout.toString();
  expect(config).not.toContain(id);
  expect(git(target, ["fsck", "--unreachable", "--no-reflogs"])).toBe("");
}

/** Writes a key with the votes record a drafted key carries: one vote each, as drafted. */
async function writeKey(
  dir: string,
  key: { issues: { id: string; severity: string }[] },
): Promise<void> {
  await Bun.write(join(dir, "key", "key.json"), JSON.stringify(key));
  const issues = key.issues.map(({ id, severity }) => ({
    id,
    real: true,
    severity,
    votes: [{ by: "test", real: true, severity, why: "" }],
  }));
  await Bun.write(
    join(dir, "key", "evidence", "votes.json"),
    JSON.stringify({
      format: "awf.key-votes/1",
      procedure: "test",
      voters: ["test"],
      issues,
      refuted: [],
    }),
  );
}

describe("collect", () => {
  test("freezes the version review started on, even after a rebase deleted it", async () => {
    const m2 = git(remote, ["rev-parse", "HEAD"]);
    git(remote, ["checkout", "--quiet", "-b", "feature"]);
    const v1 = commit(remote, "app.ts", "one\nthree\n", "add three");
    git(remote, ["checkout", "--quiet", "main"]);
    const m3 = commit(remote, "other.ts", "x\n", "m3");
    git(remote, ["checkout", "--quiet", "feature"]);
    git(remote, [...ID, "rebase", "--quiet", "main"]);
    const v2 = commit(remote, "app.ts", "one\ntwo\nthree\n", "keep two");
    git(remote, ["checkout", "--quiet", "main"]);
    git(remote, ["branch", "--quiet", "-D", "feature"]);

    const result = await run({
      versions: [
        version(12, v2, m3, "2026-01-02T09:00:00Z"),
        version(11, v1, m2, "2026-01-01T09:00:00Z"),
      ],
      // GitLab has moved the comment to the newest version it still applies to.
      discussions: [comment("2026-01-01T15:00:00Z", v2)],
    });

    expect(result).toMatchObject({ status: "collected", id: "shop-7", version: 1 });
    const dir = join(out, "shop-7");
    const fixture = await Bun.file(join(dir, "fixture.json")).json();
    expect(checkFixture(fixture).ok).toBe(true);
    expect(fixture.snapshot).toMatchObject({ version: 1, base: m2, head: v1 });
    const record = await Bun.file(join(dir, "key", "evidence", "collect.json")).json();
    expect(checkCollectRecord(record).ok).toBe(true);
    expect(record.reviewStart).toMatchObject({ version: 1, how: "first-comment" });
    expect(await Bun.file(join(dir, "request.md")).text()).toBe("# Add three\n\nAdds three.\n");
    for (const file of [
      "snapshot.bundle",
      "key/fixes.bundle",
      "key/evidence/gitlab/discussions.json",
    ]) {
      expect(existsSync(join(dir, file))).toBe(true);
    }

    const { target, head } = await restoreInto("restored");
    expect(head).toBe(v1);
    expect(git(target, ["log", "--format=%s", "--all"]).split("\n")).toEqual([
      "add three",
      "m2",
      "m1",
    ]);
    expect(() => git(target, ["cat-file", "-e", `${m3}^{commit}`])).toThrow();
    expectSealed(target);

    const expected = { project: "acme/shop", number: 7, clone };
    expect(await verifyFixture(dir, expected)).toEqual([]);
    expect(await verifyFixture(dir, { ...expected, number: 8 })).toMatchObject([
      { path: "fixture.json/source" },
    ]);
    writeFileSync(join(dir, "snapshot.bundle"), "not a bundle");
    writeFileSync(join(dir, "request.md"), "");
    const broken = await verifyFixture(dir, expected);
    expect(broken.map((problem) => problem.path)).toEqual(["request.md", "snapshot.bundle"]);
  });

  test("carries the base's history when the MR targeted a branch that isn't main", async () => {
    const m2 = git(remote, ["rev-parse", "HEAD"]);
    git(remote, ["checkout", "--quiet", "-b", "epic"]);
    const epic = commit(remote, "epic.ts", "e\n", "epic work");
    git(remote, ["checkout", "--quiet", "-b", "feature"]);
    const head = commit(remote, "app.ts", "one\ntwo\nthree\n", "add three");
    git(remote, ["checkout", "--quiet", "main"]);
    commit(remote, "later.ts", "l\n", "later on main");
    git(clone, ["pull", "--quiet"]);

    const result = await run({
      versions: [version(11, head, epic, "2026-01-01T09:00:00Z")],
      discussions: [comment("2026-01-01T15:00:00Z", head)],
    });
    expect(result.status).toBe("collected");
    const { target } = await restoreInto("restored");
    expect(git(target, ["merge-base", "--is-ancestor", epic, "HEAD"])).toBe("");
    expect(git(target, ["merge-base", "--is-ancestor", m2, "HEAD"])).toBe("");
    expect(git(target, ["log", "--format=%s", "--all"])).not.toContain("later on main");
    expectSealed(target);
  });

  test("bundles a head that is already on main", async () => {
    const m2 = git(remote, ["rev-parse", "HEAD"]);
    const head = commit(remote, "app.ts", "one\ntwo\nthree\n", "add three");
    git(clone, ["pull", "--quiet"]);

    const result = await run({
      versions: [version(11, head, m2, "2026-01-01T09:00:00Z")],
      discussions: [comment("2026-01-01T15:00:00Z", head)],
    });
    expect(result.status).toBe("collected");
    expect((await restoreInto("restored")).head).toBe(head);
  });

  test("uses the description as the reviewer read it, without the bot's summary", async () => {
    const m2 = git(remote, ["rev-parse", "HEAD"]);
    const head = commit(remote, "app.ts", "one\ntwo\nthree\n", "add three");
    const summary = "<!-- CURSOR_SUMMARY -->\nRisky.\n<!-- /CURSOR_SUMMARY -->";

    const result = await run({
      mr: mrData({ description: "Adds three. Fixed the review comments too." }),
      versions: [version(11, head, m2, "2026-01-01T09:00:00Z")],
      discussions: [comment("2026-01-01T15:00:00Z", head)],
      descriptions: [
        {
          createdAt: "2026-01-01T09:01:00Z",
          author: "bot",
          description: `Adds three.\n\n${summary}`,
          diff: null,
        },
        {
          createdAt: "2026-01-02T00:00:00Z",
          author: "author",
          description: "Adds three. Fixed the review comments too.",
          diff: null,
        },
      ],
    });
    expect(result.status).toBe("collected");
    const dir = join(out, "shop-7");
    expect(await Bun.file(join(dir, "request.md")).text()).toBe("# Add three\n\nAdds three.\n");
    const fixture = await Bun.file(join(dir, "fixture.json")).json();
    expect(fixture.request.removed).toEqual([{ by: "CURSOR_SUMMARY", what: summary }]);
    expect(fixture.request.asOf).toBe("2026-01-01T15:00:00Z");
  });

  test("checks a key against the frozen code and the pushes after it", async () => {
    const m2 = git(remote, ["rev-parse", "HEAD"]);
    const v1 = commit(remote, "app.ts", "one\nthree\n", "add three");
    const v2 = commit(remote, "app.ts", "one\ntwo\nthree\n", "keep two");
    await run({
      versions: [
        version(11, v1, m2, "2026-01-01T09:00:00Z"),
        version(12, v2, m2, "2026-01-02T09:00:00Z"),
      ],
      discussions: [
        comment("2026-01-01T15:00:00Z", v1),
        comment("2026-01-01T16:00:00Z", v1, "bot", 2),
      ],
    });
    const dir = join(out, "shop-7");
    const issue = {
      id: "K1",
      mechanism: "Line two is dropped, so anything reading it gets three instead.",
      visibleIn: "diff",
      severity: "must-fix",
      category: "correctness",
      scope: "change",
      locations: [{ path: "app.ts", start: 1, end: 2 }],
      confirmation: { basis: "fixed", version: 2, commit: v2 },
      sources: [{ discussion: "d1", note: 1 }],
    };
    const key = {
      format: "awf.review-key/1",
      fixture: "shop-7",
      revision: 1,
      draftedBy: "test",
      procedure: "test",
      issues: [issue],
      refuted: [],
      excluded: [
        {
          sources: [{ discussion: "d2", note: 2 }],
          reason: "not-a-claim",
          claim: "A bot summary.",
        },
      ],
    };
    const expected = { project: "acme/shop", number: 7, clone };
    await writeKey(dir, key);
    expect(await verifyFixture(dir, expected)).toEqual([]);

    const wrong = {
      ...key,
      issues: [
        {
          ...issue,
          locations: [{ path: "app.ts", start: 1, end: 3 }],
          confirmation: { basis: "fixed", version: 2, commit: v1 },
        },
      ],
      excluded: [],
    };
    await writeKey(dir, wrong);
    expect((await verifyFixture(dir, expected)).map((p) => p.path)).toEqual([
      "key/key.json/issues/0/locations/0",
      "key/key.json/issues/0/confirmation/commit",
      "key/key.json",
    ]);
  });

  test("keeps every later push when the MR was merged without squashing", async () => {
    const m2 = git(remote, ["rev-parse", "HEAD"]);
    const v1 = commit(remote, "app.ts", "one\ntwo\nthree\n", "v1");
    const v2 = commit(remote, "app.ts", "one\ntwo\nthree\nfour\n", "v2");
    const v3 = commit(remote, "app.ts", "one\ntwo\nthree\nfour\nfive\n", "v3");
    git(clone, ["pull", "--quiet"]);
    await run({
      versions: [
        version(11, v1, m2, "2026-01-01T09:00:00Z"),
        version(12, v2, m2, "2026-01-02T09:00:00Z"),
        version(13, v3, m2, "2026-01-03T09:00:00Z"),
      ],
      discussions: [comment("2026-01-01T15:00:00Z", v1)],
    });
    const target = join(root, "key-repo");
    await openKeyRepo(join(out, "shop-7"), clone, target);
    expect(
      git(target, ["for-each-ref", "--format=%(refname)", "refs/versions/"]).split("\n"),
    ).toEqual(["refs/versions/2", "refs/versions/3"]);
  });

  test("accepts as a fix only a commit the MR itself added in that push", async () => {
    const m2 = git(remote, ["rev-parse", "HEAD"]);
    git(remote, ["checkout", "--quiet", "-b", "feature"]);
    const v1 = commit(remote, "app.ts", "one\nthree\n", "add three");
    git(remote, ["checkout", "--quiet", "main"]);
    const m3 = commit(remote, "other.ts", "x\n", "m3");
    git(remote, ["checkout", "--quiet", "feature"]);
    git(remote, [...ID, "rebase", "--quiet", "main"]);
    const v2 = commit(remote, "app.ts", "one\ntwo\nthree\n", "keep two");
    git(remote, ["checkout", "--quiet", "main"]);
    git(clone, ["pull", "--quiet"]);
    await run({
      versions: [
        version(11, v1, m2, "2026-01-01T09:00:00Z"),
        version(12, v2, m3, "2026-01-02T09:00:00Z"),
      ],
      discussions: [comment("2026-01-01T15:00:00Z", v1)],
    });
    const dir = join(out, "shop-7");
    const key = (commit: string) => ({
      format: "awf.review-key/1",
      fixture: "shop-7",
      revision: 1,
      draftedBy: "test",
      procedure: "test",
      issues: [
        {
          id: "K1",
          mechanism: "Line two is dropped.",
          visibleIn: "diff",
          severity: "must-fix",
          category: "correctness",
          scope: "change",
          locations: [{ path: "app.ts", start: 1, end: 2 }],
          confirmation: { basis: "fixed", version: 2, commit },
          sources: [{ discussion: "d1", note: 1 }],
        },
      ],
      refuted: [],
      excluded: [],
    });
    const expected = { project: "acme/shop", number: 7, clone };
    await writeKey(dir, key(v2));
    expect(await verifyFixture(dir, expected)).toEqual([]);
    await writeKey(dir, key(m3));
    expect((await verifyFixture(dir, expected)).map((p) => p.path)).toEqual([
      "key/key.json/issues/0/confirmation/commit",
    ]);
    // The rebase copied "add three" under a new id; it's the change under review, not a fix.
    await writeKey(dir, key(git(remote, ["rev-parse", `${v2}^`])));
    expect((await verifyFixture(dir, expected)).map((p) => p.path)).toEqual([
      "key/key.json/issues/0/confirmation/commit",
    ]);
  });

  test("never counts the frozen code's own commits as a later fix, even after a push went back", async () => {
    const m2 = git(remote, ["rev-parse", "HEAD"]);
    git(remote, ["checkout", "--quiet", "-b", "feature"]);
    const a1 = commit(remote, "app.ts", "one\nthree\n", "a1");
    const a2 = commit(remote, "app.ts", "one\nthree\nfour\n", "a2");
    const fix = commit(remote, "app.ts", "one\ntwo\nthree\nfour\n", "keep two");
    git(remote, ["checkout", "--quiet", "main"]);
    await run({
      versions: [
        version(11, a2, m2, "2026-01-01T09:00:00Z"),
        version(12, a1, m2, "2026-01-02T09:00:00Z"),
        version(13, fix, m2, "2026-01-03T09:00:00Z"),
      ],
      discussions: [comment("2026-01-01T15:00:00Z", a2)],
    });
    const dir = join(out, "shop-7");
    const key = (version: number, sha: string) => ({
      format: "awf.review-key/1",
      fixture: "shop-7",
      revision: 1,
      draftedBy: "test",
      procedure: "test",
      issues: [
        {
          id: "K1",
          mechanism: "Line two is dropped.",
          visibleIn: "diff",
          severity: "must-fix",
          category: "correctness",
          scope: "change",
          locations: [{ path: "app.ts", start: 1, end: 2 }],
          confirmation: { basis: "fixed", version, commit: sha },
          sources: [{ discussion: "d1", note: 1 }],
        },
      ],
      refuted: [],
      excluded: [],
    });
    const expected = { project: "acme/shop", number: 7, clone };
    await writeKey(dir, key(3, fix));
    expect(await verifyFixture(dir, expected)).toEqual([]);
    await writeKey(dir, key(3, a2));
    expect((await verifyFixture(dir, expected)).map((p) => p.path)).toEqual([
      "key/key.json/issues/0/confirmation/commit",
    ]);
  });

  test("ignores the author's own comments when finding where review started", async () => {
    const m2 = git(remote, ["rev-parse", "HEAD"]);
    const v1 = commit(remote, "app.ts", "one\ntwo\nthree\n", "add three");
    const v2 = commit(remote, "app.ts", "one\ntwo\nthree\nfour\n", "add four");
    const result = await run({
      versions: [
        version(11, v1, m2, "2026-01-01T09:00:00Z"),
        version(12, v2, m2, "2026-01-02T09:00:00Z"),
      ],
      discussions: [
        comment("2026-01-01T10:00:00Z", v1, "author", 1),
        comment("2026-01-02T12:00:00Z", v2, "reviewer", 2),
      ],
    });
    expect(result).toMatchObject({ status: "collected", version: 2 });
  });

  test("freezes a version chosen by hand, with the request as of that push", async () => {
    const m2 = git(remote, ["rev-parse", "HEAD"]);
    const v1 = commit(remote, "app.ts", "one\ntwo\nthree\n", "add three");
    const v2 = commit(remote, "app.ts", "one\ntwo\nthree\nfour\n", "add four");
    const result = await run(
      {
        versions: [
          version(11, v1, m2, "2026-01-01T09:00:00Z"),
          version(12, v2, m2, "2026-01-02T09:00:00Z"),
        ],
        discussions: [comment("2026-01-01T10:00:00Z", v1)],
      },
      { version: 2 },
    );
    expect(result).toMatchObject({ status: "collected", version: 2 });
    const fixture = await Bun.file(join(out, "shop-7", "fixture.json")).json();
    expect(fixture.request.asOf).toBe("2026-01-02T09:00:00Z");
  });

  test("ignores whatever a killed run left half-written", async () => {
    const m2 = git(remote, ["rev-parse", "HEAD"]);
    const head = commit(remote, "app.ts", "one\ntwo\nthree\n", "add three");
    mkdirSync(join(out, "shop-7.partial", "key"), { recursive: true });
    writeFileSync(join(out, "shop-7.partial", "key", "fixes.bundle"), "STALE");
    writeFileSync(join(out, "shop-7.partial", "stray.txt"), "x");

    await run({
      versions: [version(11, head, m2, "2026-01-01T09:00:00Z")],
      discussions: [comment("2026-01-01T15:00:00Z", head)],
    });
    const dir = join(out, "shop-7");
    expect(existsSync(join(dir, "stray.txt"))).toBe(false);
    expect(existsSync(join(dir, "key", "fixes.bundle"))).toBe(false);
    expect(readdirSync(out)).toEqual(["shop-7"]);
  });

  test("fails, rather than excluding the MR, when the remote can't be reached", async () => {
    const m2 = git(remote, ["rev-parse", "HEAD"]);
    git(remote, ["checkout", "--quiet", "-b", "feature"]);
    const head = commit(remote, "app.ts", "one\ntwo\nthree\n", "add three");
    const data = {
      versions: [version(11, head, m2, "2026-01-01T09:00:00Z")],
      discussions: [comment("2026-01-01T15:00:00Z", head)],
    };
    await expect(run(data, { remote: join(root, "nowhere") })).rejects.toThrow("can't reach");
    expect(existsSync(join(out, "shop-7"))).toBe(false);
  });

  test("refuses a shallow clone", async () => {
    const shallow = join(root, "shallow");
    git(root, ["clone", "--quiet", "--depth", "1", `file://${remote}`, shallow]);
    const m2 = git(remote, ["rev-parse", "HEAD"]);
    await expect(
      collect(
        { project: "acme/shop", mr: 7, clone: shallow, out },
        {
          source: source({
            versions: [version(11, m2, m2, "2026-01-01T09:00:00Z")],
            discussions: [comment("2026-01-01T15:00:00Z", m2)],
          }),
        },
      ),
    ).rejects.toThrow("shallow");
  });

  test("excludes a draft and an MR nobody reviewed", async () => {
    const m2 = git(remote, ["rev-parse", "HEAD"]);
    const head = commit(remote, "app.ts", "one\ntwo\nthree\n", "add three");
    const versions = [version(11, head, m2, "2026-01-01T09:00:00Z")];
    expect(
      await run({ mr: mrData({ state: "opened", draft: true }), versions, discussions: [] }),
    ).toMatchObject({ status: "excluded", reason: "draft" });
    expect(
      await run({ versions, discussions: [comment("2026-01-01T15:00:00Z", head, "author")] }),
    ).toMatchObject({ status: "excluded", reason: "no-review" });
  });
});

describe("a set", () => {
  /** Two fixtures from the same pushes: !7 merged, !8 closed; each with a key of two must-fixes. */
  async function twoFixtures(): Promise<void> {
    const m2 = git(remote, ["rev-parse", "HEAD"]);
    const v1 = commit(remote, "app.ts", "one\nthree\n", "add three");
    const v2 = commit(remote, "app.ts", "one\ntwo\nthree\n", "keep two");
    const data = {
      versions: [
        version(11, v1, m2, "2026-01-01T09:00:00Z"),
        version(12, v2, m2, "2026-01-02T09:00:00Z"),
      ],
      discussions: [comment("2026-01-01T15:00:00Z", v1)],
    };
    await run(data);
    await run({ ...data, mr: mrData({ state: "closed" }) }, { mr: 8 });
    const issue = (id: string) => ({
      id,
      mechanism: "Line two is dropped, so anything reading it gets three instead.",
      visibleIn: "diff",
      severity: "must-fix",
      category: "correctness",
      scope: "change",
      locations: [{ path: "app.ts", start: 1, end: 2 }],
      confirmation: { basis: "fixed", version: 2, commit: v2 },
      sources: [{ discussion: "d1", note: 1 }],
    });
    for (const id of ["shop-7", "shop-8"]) {
      const key = {
        format: "awf.review-key/1",
        fixture: id,
        revision: 1,
        draftedBy: "test",
        procedure: "test",
        issues: [issue("K1"), issue("K2")],
        refuted: [],
        excluded: [],
      };
      await writeKey(join(out, id), key);
    }
  }

  const seal = (
    excluded = [{ project: "acme/shop", number: 3, reason: "draft: nobody reviewed it" }],
  ) => sealSet(out, { clone, builder: "test", procedure: "test", excluded });

  test("pins what's in it by digest, and says what was left out and why", async () => {
    await twoFixtures();
    const sealed = await seal();
    expect(sealed.status).toBe("sealed");
    const set = await Bun.file(join(out, "set.json")).json();
    expect(set).toMatchObject({
      name: "set",
      fixtures: [{ id: "shop-7", at: "2026-01-01T15:00:00Z" }],
      excluded: [
        { number: 3, reason: "draft: nobody reviewed it" },
        { number: 8, reason: "closed, not merged" },
      ],
    });
    expect(set.fixtures[0].digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(await verifySet(out, clone)).toEqual([]);

    // Sealing again with nothing new changes nothing, and an earlier exclusion is kept.
    expect((await seal([])).status).toBe("unchanged");
    expect(await Bun.file(join(out, "set.json")).json()).toEqual(set);
  });

  test("catches a fixture that changed, or appeared, after it was sealed", async () => {
    await twoFixtures();
    await seal();
    const request = join(out, "shop-7", "request.md");
    writeFileSync(request, "# Add three\n\nAdds three. Fixed in the next push.\n");
    mkdirSync(join(out, "shop-9"));
    mkdirSync(join(out, "shop-10.partial"));
    const problems = async () =>
      (await verifySet(out, clone)).map((p) => [p.path, p.message.split(":")[0]]);
    expect(await problems()).toEqual([
      ["shop-9", "is neither in set.json nor excluded; seal the set"],
      ["shop-7", "changed since the set was sealed"],
    ]);

    rmSync(join(out, "shop-9"), { recursive: true });
    await seal();
    const fixture = join(out, "shop-7", "fixture.json");
    const record = await Bun.file(fixture).json();
    writeFileSync(
      fixture,
      JSON.stringify({ ...record, source: { ...record.source, url: "https://x" } }),
    );
    expect(await problems()).toEqual([["shop-7", "changed since the set was sealed"]]);

    writeFileSync(fixture, JSON.stringify(record));
    const key = await Bun.file(join(out, "shop-7", "key", "key.json")).json();
    await writeKey(join(out, "shop-7"), { ...key, issues: key.issues.slice(0, 1) });
    expect(await problems()).toEqual([
      [
        "shop-7",
        "is in the set, but 1 must-fix or should-fix problem(s) the MR caused; a set needs two",
      ],
    ]);
  });

  test("refuses a fixture whose id isn't its folder's MR, and a broken set.json", async () => {
    await twoFixtures();
    const fixture = join(out, "shop-8", "fixture.json");
    const record = await Bun.file(fixture).json();
    writeFileSync(fixture, JSON.stringify({ ...record, source: { ...record.source, number: 9 } }));
    expect(await seal()).toMatchObject({
      status: "broken",
      detail: expect.stringContaining("fixture.json/id"),
    });
    writeFileSync(fixture, JSON.stringify(record));

    writeFileSync(join(out, "set.json"), '{"format": "awf.fixture-set/1", "na');
    expect(await seal()).toMatchObject({ status: "broken" });
    expect(await verifySet(out, clone)).toMatchObject([{ path: "set.json" }]);
  });

  test("leaves out a stale key, and won't seal while a fixture is broken", async () => {
    await twoFixtures();
    const stale = await sealSet(out, { clone, builder: "test", procedure: "newer" });
    expect(stale).toMatchObject({
      status: "sealed",
      set: {
        fixtures: [],
        excluded: [
          { number: 7, reason: "its key was drafted under older instructions" },
          { number: 8 },
        ],
      },
    });
    writeFileSync(join(out, "shop-7", "fixture.json"), "{}");
    expect(await seal()).toMatchObject({ status: "broken" });
    expect((await Bun.file(join(out, "set.json")).json()).fixtures).toEqual([]);
  });
});
