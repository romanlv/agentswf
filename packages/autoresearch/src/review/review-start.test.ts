import { describe, expect, test } from "bun:test";
import type { GitLabDiscussion, GitLabVersion } from "./gitlab-types";
import { codeComments, findReviewStart, orderVersions } from "./review-start";

const sha = (n: number) => n.toString(16).padStart(40, "0");

function version(id: number, at: string): GitLabVersion {
  return {
    id,
    head_commit_sha: sha(id),
    base_commit_sha: sha(100),
    start_commit_sha: sha(100),
    created_at: at,
  };
}

function diffNote(id: number, at: string, system = false): GitLabDiscussion {
  return {
    id: `d${id}`,
    notes: [
      {
        id,
        type: system ? null : "DiffNote",
        body: `comment ${id}`,
        system,
        created_at: at,
        author: { username: "reviewer" },
        position: { head_sha: sha(2), new_path: "a.ts", new_line: 3 },
      },
    ],
  };
}

describe("orderVersions", () => {
  test("numbers pushes from 1 by time, whatever order GitLab lists them in", () => {
    const ordered = orderVersions([
      version(30, "2026-01-03T00:00:00Z"),
      version(10, "2026-01-01T00:00:00Z"),
      version(20, "2026-01-02T00:00:00Z"),
    ]);
    expect(ordered.map((v) => [v.ordinal, v.id])).toEqual([
      [1, 10],
      [2, 20],
      [3, 30],
    ]);
  });
});

describe("findReviewStart", () => {
  const versions = orderVersions([
    version(1, "2026-01-01T10:00:00Z"),
    version(2, "2026-01-01T12:00:00Z"),
    version(3, "2026-01-02T09:00:00Z"),
  ]);

  test("is the last push before the first code comment", () => {
    const start = findReviewStart(
      versions,
      codeComments(
        [diffNote(8, "2026-01-02T10:00:00Z"), diffNote(7, "2026-01-01T15:00:00Z")],
        "author",
      ),
    );
    expect(start.kind).toBe("found");
    if (start.kind !== "found") return;
    expect(start.version.ordinal).toBe(2);
    expect(start.first.note).toBe(7);
  });

  test("ignores system notes and general comments", () => {
    const general: GitLabDiscussion = {
      id: "g",
      notes: [
        {
          id: 5,
          type: null,
          body: "looks good",
          system: false,
          created_at: "2026-01-01T10:30:00Z",
          author: { username: "reviewer" },
        },
      ],
    };
    const start = findReviewStart(
      versions,
      codeComments(
        [general, diffNote(6, "2026-01-01T10:40:00Z", true), diffNote(7, "2026-01-02T10:00:00Z")],
        "author",
      ),
    );
    expect(start.kind === "found" && start.version.ordinal).toBe(3);
  });

  test("an MR nobody commented on has no review start", () => {
    expect(findReviewStart(versions, []).kind).toBe("no-review");
  });

  test("numbers tied pushes by id, so the older push stays version 1", () => {
    const tied = orderVersions([
      version(9, "2026-01-01T10:00:00Z"),
      version(8, "2026-01-01T10:00:00Z"),
    ]);
    expect(tied.map((v) => v.id)).toEqual([8, 9]);
  });
});
