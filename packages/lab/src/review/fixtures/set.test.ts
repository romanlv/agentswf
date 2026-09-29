import { describe, expect, test } from "bun:test";
import type { AnswerKey, Fixture, KnownIssue } from "../format/format";
import { canonicalJson, leftOut, mergeExcluded } from "./set";

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
  snapshot: { version: 1, base: "a".repeat(40), head: "b".repeat(40), at: "2026-01-01T00:00:00Z" },
  request: { asOf: "2026-01-01T01:00:00Z", removed: [] },
};

const issue = (severity: KnownIssue["severity"], scope: KnownIssue["scope"]): KnownIssue => ({
  id: "K1",
  mechanism: "Drops line two.",
  visibleIn: "diff",
  severity,
  category: "correctness",
  scope,
  locations: [],
  confirmation: { basis: "verified", how: "read it" },
  sources: [{ discussion: "d1", note: 1 }],
});

const key = (issues: KnownIssue[]): AnswerKey => ({
  format: "awf.review-key/1",
  fixture: "shop-42",
  revision: 1,
  draftedBy: "test",
  procedure: "test",
  issues,
  refuted: [],
  excluded: [],
});

describe("leftOut", () => {
  test("keeps a merged MR with two serious problems it caused", () => {
    const two = key([issue("must-fix", "change"), issue("should-fix", "change")]);
    expect(leftOut(fixture, two)).toBeNull();
  });

  test("leaves out an MR that wasn't merged, has no key, or too little the MR caused", () => {
    const closed = { ...fixture, source: { ...fixture.source, state: "closed" as const } };
    const two = key([issue("must-fix", "change"), issue("must-fix", "change")]);
    expect(leftOut(closed, two)).toBe("closed, not merged");
    expect(leftOut(fixture, undefined)).toBe("no answer key");
    const minor = key([
      issue("must-fix", "change"),
      issue("must-fix", "context"),
      issue("could-fix", "change"),
      issue("nit", "change"),
    ]);
    expect(leftOut(fixture, minor)).toContain("1 must-fix or should-fix");
  });
});

describe("canonical JSON", () => {
  test("doesn't depend on the order keys were written in", () => {
    const shuffled = Object.fromEntries(Object.entries(fixture).reverse()) as Fixture;
    expect(canonicalJson({ fixture: shuffled, request: "# T\n" })).toBe(
      canonicalJson({ fixture, request: "# T\n" }),
    );
    expect(canonicalJson({ b: [{ d: 1, c: 2 }], a: null })).toBe('{"a":null,"b":[{"c":2,"d":1}]}');
  });
});

describe("mergeExcluded", () => {
  test("keeps the first reason for each MR, in MR order", () => {
    const merged = mergeExcluded(
      [{ project: "acme/shop", number: 9, reason: "new" }],
      [
        { project: "acme/shop", number: 9, reason: "old" },
        { project: "acme/shop", number: 3, reason: "draft" },
      ],
    );
    expect(merged).toEqual([
      { project: "acme/shop", number: 3, reason: "draft" },
      { project: "acme/shop", number: 9, reason: "new" },
    ]);
  });
});
