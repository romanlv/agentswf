import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { AnswerKey, Fixture, Votes } from "./format";
import { ballotProblems, majority, settleSeverity } from "./grading";
import { renderSchemaFile, SCHEMA_FILES } from "./schema-files";
import { EXAMPLE_FINDINGS_RECORD, EXAMPLE_SCORE_RECORD } from "./testing";
import {
  checkAnswerKey,
  checkFindingsRecord,
  checkFixture,
  checkFixtureSet,
  checkReviewFindings,
  checkScoreRecord,
  type KeyFacts,
  keyProblems,
  votesProblems,
} from "./validate";

const SHA = "a".repeat(40);

const fixture: Fixture = {
  format: "awf.review-fixture/1",
  id: "shop-42",
  source: {
    forge: "gitlab",
    project: "acme/shop",
    number: 42,
    url: "https://gitlab.example/acme/shop/-/merge_requests/42",
    state: "merged",
  },
  snapshot: { version: 1, base: SHA, head: "b".repeat(40), at: "2026-01-01T00:00:00Z" },
  request: { asOf: "2026-01-01T01:00:00Z", removed: [] },
};

const key: AnswerKey = {
  format: "awf.review-key/1",
  fixture: "shop-42",
  revision: 1,
  draftedBy: "codex/gpt-6-sol",
  procedure: "abc123",
  issues: [
    {
      id: "K1",
      mechanism: "The loop stops one page early, so the last page of orders is never exported.",
      visibleIn: "diff",
      severity: "must-fix",
      category: "correctness",
      scope: "change",
      locations: [{ path: "export.ts", start: 10, end: 12 }],
      confirmation: { basis: "fixed", version: 2, commit: SHA },
      sources: [{ discussion: "d1", note: 1 }],
    },
  ],
  refuted: [],
  excluded: [{ sources: [{ discussion: "d2", note: 3 }], reason: "not-a-claim", claim: "Praise." }],
};

const facts: KeyFacts = {
  notes: new Map([
    ["d1", new Set([1, 2])],
    ["d2", new Set([3])],
  ]),
  mustAccount: ["d1", "d2"],
  snapshotVersion: 1,
  lines: new Map([["export.ts", 40]]),
  later: new Map([[2, new Set([SHA])]]),
};

describe("checkFixture", () => {
  test("accepts a valid fixture", () => {
    expect(checkFixture(fixture).ok).toBe(true);
  });

  test("rejects a missing field, a bad sha and an answer smuggled into fixture.json", () => {
    const { request: _, ...missing } = fixture;
    const bad = { ...fixture, snapshot: { ...fixture.snapshot, head: "HEAD" }, issues: [] };
    const missingResult = checkFixture(missing);
    const badResult = checkFixture(bad);
    expect(missingResult.ok).toBe(false);
    expect(badResult.ok).toBe(false);
    if (badResult.ok) return;
    const paths = badResult.problems.map((p) => p.path);
    expect(paths).toContain("/snapshot/head");
    expect(badResult.problems.some((p) => p.message.includes("additional"))).toBe(true);
  });
});

describe("checkAnswerKey", () => {
  test("accepts a valid key", () => {
    expect(checkAnswerKey(key).ok).toBe(true);
  });

  test("rejects a severity outside the scale, and an issue with no source", () => {
    expect(checkAnswerKey({ ...key, issues: [{ ...key.issues[0]!, severity: "major" }] }).ok).toBe(
      false,
    );
    expect(checkAnswerKey({ ...key, issues: [{ ...key.issues[0]!, sources: [] }] }).ok).toBe(false);
  });

  test("rejects a repeated id and a range that runs backwards", () => {
    const issue = key.issues[0]!;
    const result = checkAnswerKey({
      ...key,
      issues: [issue, { ...issue, locations: [{ path: "a.ts", start: 9, end: 3 }] }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const messages = result.problems.map((p) => p.message);
    expect(messages).toContain("id K1 is used twice");
    expect(messages).toContain("end is before start");
  });
});

describe("keyProblems", () => {
  test("accepts a key that fits its fixture", () => {
    expect(keyProblems(key, facts)).toEqual([]);
  });

  test("accepts a later push's commit as a source, and nothing else", () => {
    const issue = key.issues[0]!;
    const withCommit = (commit: string) =>
      keyProblems(
        { ...key, issues: [{ ...issue, sources: [...issue.sources, { commit }] }] },
        facts,
      );
    expect(withCommit(SHA)).toEqual([]);
    expect(withCommit("d".repeat(40)).map((p) => p.path)).toEqual(["/issues/0/sources/1"]);
  });

  test("rejects invented notes, lines and commits, and a discussion left out", () => {
    const issue = key.issues[0]!;
    const problems = keyProblems(
      {
        ...key,
        issues: [
          {
            ...issue,
            sources: [{ discussion: "d1", note: 9 }],
            locations: [
              { path: "export.ts", start: 38, end: 41 },
              { path: "gone.ts", start: 1, end: 1 },
            ],
            confirmation: { basis: "fixed", version: 2, commit: "c".repeat(40) },
          },
          { ...issue, id: "K2", confirmation: { basis: "fixed", version: 1, commit: SHA } },
          {
            ...issue,
            id: "K3",
            confirmation: { basis: "accepted", note: { discussion: "d9", note: 1 } },
          },
        ],
        excluded: [],
      },
      facts,
    );
    expect(problems.map((p) => p.path)).toEqual([
      "/issues/0/sources/0",
      "/issues/0/locations/0",
      "/issues/0/locations/1",
      "/issues/0/confirmation/commit",
      "/issues/1/confirmation/version",
      "/issues/2/confirmation/note",
      "/",
    ]);
    expect(problems.at(-1)!.message).toContain("d2");
  });
});

describe("votes", () => {
  test("need exactly one vote on every item asked about", () => {
    const asked = { issues: ["K1", "K2"], refuted: ["R1"] };
    const vote = (id: string) => ({ id });
    expect(
      ballotProblems({ issues: [vote("K1"), vote("K2")], refuted: [vote("R1")] }, asked),
    ).toEqual([]);
    expect(
      ballotProblems({ issues: [vote("K1"), vote("K1"), vote("K9")], refuted: [] }, asked),
    ).toEqual([
      "K1 has 2 votes",
      "K2 has 0 votes",
      "K9 is not one of the issues asked about",
      "R1 has 0 votes",
    ]);
  });

  test("settle to the median severity and a strict majority", () => {
    expect(settleSeverity(["must-fix", "should-fix", "must-fix"])).toBe("must-fix");
    expect(settleSeverity(["must-fix", "nit", "should-fix"])).toBe("should-fix");
    expect(settleSeverity(["must-fix", "could-fix"])).toBe("could-fix");
    expect(majority([true, true, false])).toBe(true);
    expect(majority([true, false])).toBe(false);
  });

  const cast = (real: boolean, severity: "must-fix" | "should-fix") => ({
    by: "x",
    real,
    severity,
    why: "",
  });
  const votes = (entry: Partial<Votes["issues"][number]> = {}): Votes => ({
    format: "awf.key-votes/1",
    procedure: "abc123",
    voters: ["x", "x", "x"],
    issues: [
      {
        id: "K1",
        real: true,
        severity: "should-fix",
        votes: [cast(true, "must-fix"), cast(true, "should-fix"), cast(false, "should-fix")],
        ...entry,
      },
    ],
    refuted: [],
  });
  const settled = { ...key, issues: [{ ...key.issues[0]!, severity: "should-fix" as const }] };

  test("accept a key that is what its votes settle to", () => {
    expect(votesProblems(settled, votes())).toEqual([]);
  });

  test("reject a key that doesn't follow from its votes", () => {
    expect(votesProblems(key, votes())).toHaveLength(1);
    expect(votesProblems(settled, votes({ severity: "must-fix" }))).toHaveLength(1);
    expect(
      votesProblems(
        settled,
        votes({ votes: [cast(true, "should-fix"), cast(false, "nit" as never)] }),
      ),
    ).not.toEqual([]);
    expect(votesProblems(settled, { ...votes(), issues: [] })).toHaveLength(1);
    expect(votesProblems(settled, { ...votes(), procedure: "old" })).toHaveLength(1);
    expect(votesProblems(settled, { ...votes(), voters: ["x", "x"] })).toHaveLength(1);
  });

  test("reject an issue most voters found not real that is still in the key", () => {
    const notReal = votes({
      real: false,
      votes: [cast(true, "should-fix"), cast(false, "should-fix"), cast(false, "should-fix")],
    });
    expect(votesProblems(settled, notReal)).toHaveLength(1);
    expect(votesProblems({ ...settled, issues: [] }, notReal)).toEqual([]);
  });
});

describe("checkFixtureSet", () => {
  test("rejects a fixture listed twice", () => {
    const entry = { id: "shop-42", at: "2026-01-01T00:00:00Z", digest: `sha256:${"0".repeat(64)}` };
    const set = {
      format: "awf.fixture-set/1",
      name: "draft",
      builtAt: "2026-01-02T00:00:00Z",
      builder: "collect",
      fixtures: [entry, entry],
      excluded: [],
    };
    expect(checkFixtureSet(set).ok).toBe(false);
    expect(checkFixtureSet({ ...set, fixtures: [entry] }).ok).toBe(true);
    expect(checkFixtureSet({ ...set, fixtures: [{ ...entry, digest: "x" }] }).ok).toBe(false);
  });
});

describe("schema files", () => {
  test("match format.ts; regenerate with bun packages/lab/src/write-schemas.ts", async () => {
    for (const name of Object.keys(SCHEMA_FILES) as (keyof typeof SCHEMA_FILES)[]) {
      const file = Bun.file(join(import.meta.dir, "..", "..", "..", "schema", name));
      expect(await file.json()).toEqual(JSON.parse(renderSchemaFile(name)));
    }
  });
});

describe("scoring records", () => {
  test("a review and its judging pass their checks", () => {
    expect(checkFindingsRecord(EXAMPLE_FINDINGS_RECORD)).toEqual({
      ok: true,
      value: EXAMPLE_FINDINGS_RECORD,
    });
    expect(checkScoreRecord(EXAMPLE_SCORE_RECORD).ok).toBe(true);
    const failed = {
      ...EXAMPLE_SCORE_RECORD,
      result: { status: "failed", reason: "no majority", problems: ["/labels: 3 labels"] },
    };
    expect(checkScoreRecord(failed).ok).toBe(true);
    expect(checkScoreRecord({ ...EXAMPLE_SCORE_RECORD, agreement: 2 }).ok).toBe(false);
  });

  test("a failed review has no findings, and a review without findings says why", () => {
    const timedOut = {
      ...EXAMPLE_FINDINGS_RECORD,
      run: { ...EXAMPLE_FINDINGS_RECORD.run, outcome: "timed-out" },
      findings: [],
    };
    expect(checkFindingsRecord(timedOut)).toEqual({
      ok: false,
      problems: [{ path: "/failure", message: "the run timed-out; say why there are no findings" }],
    });
    expect(checkFindingsRecord({ ...timedOut, failure: "the run timed out" }).ok).toBe(true);
    expect(checkFindingsRecord({ ...EXAMPLE_FINDINGS_RECORD, failure: "read threw" })).toEqual({
      ok: false,
      problems: [{ path: "/findings", message: "a failed review has none" }],
    });
  });

  test("what a variant's read returns: absent and undefined optionals pass, null fails", () => {
    expect(checkReviewFindings([{ text: "a", line: undefined }]).ok).toBe(true);
    expect(checkReviewFindings([{ text: "a", line: null }]).ok).toBe(false);
    expect(checkReviewFindings([{ text: "" }]).ok).toBe(false);
  });
});
