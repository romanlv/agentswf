import type { GitLabDiscussion, GitLabNote, GitLabVersion } from "./gitlab-types";

export type OrderedVersion = GitLabVersion & { ordinal: number };

const byTime = (a: string, b: string) => Date.parse(a) - Date.parse(b);

/** GitLab lists versions newest first; ours count pushes from 1. Ties go to the lower id. */
export function orderVersions(versions: readonly GitLabVersion[]): OrderedVersion[] {
  return versions
    .toSorted((a, b) => byTime(a.created_at, b.created_at) || a.id - b.id)
    .map((version, index) => ({ ...version, ordinal: index + 1 }));
}

export type CodeComment = {
  discussion: string;
  note: number;
  at: string;
  author: string;
  path: string | null;
  line: number | null;
  body: string;
};

export type ReviewStart =
  | { kind: "found"; version: OrderedVersion; first: CodeComment }
  | { kind: "no-review"; detail: string };

/** The latest push at or before `at`. */
export function versionAt<V extends { created_at: string }>(
  ordered: readonly V[],
  at: string,
): V | undefined {
  return ordered.filter((v) => Date.parse(v.created_at) <= Date.parse(at)).at(-1);
}

/** Where GitLab shows a note now; it moves notes to the newest version, so this can drift. */
export function placeOf(note: GitLabNote): { path: string | null; line: number | null } {
  return {
    path: note.position?.new_path ?? note.position?.old_path ?? null,
    line: note.position?.new_line ?? note.position?.old_line ?? null,
  };
}

/** A note written by someone other than the MR's author, person or bot. */
export function isReviewNote(note: GitLabNote, author: string): boolean {
  return !note.system && note.author.username !== author;
}

/** Comments on the code by anyone but the MR's author, oldest first. */
export function codeComments(
  discussions: readonly GitLabDiscussion[],
  author: string,
): CodeComment[] {
  return discussions
    .flatMap((discussion) =>
      discussion.notes
        .filter((note) => note.type === "DiffNote" && isReviewNote(note, author))
        .map((note) => toComment(discussion.id, note)),
    )
    .toSorted((a, b) => byTime(a.at, b.at) || a.note - b.note);
}

function toComment(discussion: string, note: GitLabNote): CodeComment {
  return {
    discussion,
    note: note.id,
    at: note.created_at,
    author: note.author.username,
    ...placeOf(note),
    body: note.body,
  };
}

/**
 * Review started on the last push before the first comment on the code. Review bots count: their
 * comments are review too, and later pushes may answer them. If a push landed just before the
 * comment, the reviewer may have been reading the one before; the answer key drafter checks each
 * problem is in the frozen code, so the later push is the safe choice.
 */
export function findReviewStart(
  ordered: readonly OrderedVersion[],
  comments: readonly CodeComment[],
): ReviewStart {
  const first = comments[0];
  if (!first) return { kind: "no-review", detail: "nobody but the author commented on the code" };
  const version = versionAt(ordered, first.at);
  if (!version) return { kind: "no-review", detail: "the first code comment predates every push" };
  return { kind: "found", version, first };
}
