import type { DescriptionVersion } from "../fixtures/gitlab-types";

export type TextAt = { text: string; asOf: string };

/**
 * The description as it was at `time`. GitLab keeps the text after each edit, and the text before
 * the first edit only inside that edit's diff. Without a readable diff the current text is the
 * best there is, and `asOf` says so.
 */
export function descriptionAt(
  time: string,
  current: { text: string; updatedAt: string },
  versions: readonly DescriptionVersion[],
): TextAt {
  const ordered = versions.toSorted((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  // GitLab dates description edits to the second and comments to the millisecond, so an edit
  // counts as before `time` only if its whole second is.
  const cutoff = Date.parse(time);
  const last = ordered.filter((version) => Date.parse(version.createdAt) + 1000 <= cutoff).at(-1);
  if (last) return { text: last.description, asOf: time };
  const firstEdit = ordered[0];
  if (!firstEdit) return { text: current.text, asOf: time };
  if (firstEdit.diff !== null) return { text: textBeforeDiff(firstEdit.diff), asOf: time };
  return { text: current.text, asOf: current.updatedAt };
}

const SPAN = /<span class="idiff( addition| deletion)?">([\s\S]*?)<\/span>/g;

/** The earlier side of GitLab's inline description diff: unchanged and deleted runs, unescaped. */
export function textBeforeDiff(diff: string): string {
  let text = "";
  for (const match of diff.matchAll(SPAN)) {
    if (match[1] === " addition") continue;
    text += match[2];
  }
  return unescapeHtml(text.replaceAll("↵", ""));
}

function unescapeHtml(text: string): string {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}

const TITLE_CHANGE_HTML = /changed title from <code[^>]*>([\s\S]*?)<\/code> to <code/;
const TITLE_CHANGE_MARKDOWN = /^changed title from \*\*([\s\S]*)\*\* to \*\*([\s\S]*)\*\*$/;

/** The title before a "changed title" system note, from GitLab's HTML or its older markdown. */
export function titleBefore(body: string): string | undefined {
  const html = TITLE_CHANGE_HTML.exec(body);
  if (html) {
    return unescapeHtml(
      html[1]!
        .replace(/<span class="idiff[^"]*\baddition\b[^"]*">[\s\S]*?<\/span>/g, "")
        .replace(/<[^>]+>/g, ""),
    );
  }
  const markdown = TITLE_CHANGE_MARKDOWN.exec(body);
  if (!markdown) return undefined;
  return markdown[1]!.replace(/\{-([\s\S]*?)-\}/g, "$1").replace(/\{\+[\s\S]*?\+\}/g, "");
}

/** The title at `time`, undoing later "changed title" system notes. */
export function titleAt(
  time: string,
  current: string,
  systemNotes: readonly { created_at: string; body: string }[],
): string {
  const cutoff = Date.parse(time);
  const later = systemNotes
    .filter((note) => Date.parse(note.created_at) > cutoff && titleBefore(note.body) !== undefined)
    .toSorted((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))[0];
  return later ? titleBefore(later.body)! : current;
}

export type Removed = { by: string; what: string };

/**
 * Blocks bots mark with HTML comments: `<!-- NAME -->…<!-- /NAME -->`, and CodeRabbit's
 * "auto-generated comment" pairs. Unmarked bot text stays.
 */
const MARKED_BLOCKS = [
  /<!-- ([A-Z][A-Z0-9_]*) -->[\s\S]*?<!-- \/\1 -->/g,
  /<!-- This is an auto-generated comment: ([^>]*?) -->[\s\S]*?<!-- end of auto-generated comment: \1 -->/g,
];

export function stripMarkedBlocks(text: string): { text: string; removed: Removed[] } {
  const removed: Removed[] = [];
  let result = text;
  for (const pattern of MARKED_BLOCKS) {
    result = result.replace(pattern, (block, name: string) => {
      removed.push({ by: name.trim(), what: block });
      return "";
    });
  }
  return { text: tidy(result), removed };
}

function tidy(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n").trim();
}
