import type { GitLabDiscussion } from "./gitlab-types";
import { isReviewNote, type OrderedVersion, placeOf, versionAt } from "./review-start";

export type ThreadNote = {
  note: number;
  author: string;
  at: string;
  /** The latest push when the note was written. */
  onVersion: number | null;
  system: boolean;
  body: string;
};

/** One discussion as the key drafter reads it. */
export type Thread = {
  discussion: string;
  /** Where GitLab shows it now; it moves comments to the newest version, so this can drift. */
  path: string | null;
  line: number | null;
  resolved: boolean | null;
  /** The key has to say what became of it. */
  mustAccount: boolean;
  notes: ThreadNote[];
};

/**
 * Discussions with at least one human or bot note, oldest note first. System notes inside them stay:
 * "changed this line in version 3" is how GitLab ties a comment to its fix. Discussions made only of
 * system notes, like pushes, are left out.
 */
export function threads(
  discussions: readonly GitLabDiscussion[],
  versions: readonly OrderedVersion[],
  author: string,
): Thread[] {
  return discussions
    .filter((discussion) => discussion.notes.some((note) => !note.system))
    .map((discussion) => {
      const placed = discussion.notes.find((note) => note.position) ?? discussion.notes[0]!;
      const resolvable = discussion.notes.filter((note) => note.resolvable);
      return {
        discussion: discussion.id,
        ...placeOf(placed),
        resolved: resolvable.length > 0 ? resolvable.every((note) => note.resolved) : null,
        mustAccount: accountable(discussion, author),
        notes: discussion.notes.map((note) => ({
          note: note.id,
          author: note.author.username,
          at: note.created_at,
          onVersion: versionAt(versions, note.created_at)?.ordinal ?? null,
          system: note.system,
          body: note.body,
        })),
      };
    })
    .toSorted((a, b) => Date.parse(a.notes[0]!.at) - Date.parse(b.notes[0]!.at));
}

/** A discussion someone other than the author wrote in: it may raise a problem. */
export function accountable(discussion: GitLabDiscussion, author: string): boolean {
  return discussion.notes.some((note) => isReviewNote(note, author));
}
