import type { Folder } from "../format/records";

// How the lab writes counts, money, time and folders, in every command's text.

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function seconds(ms: number): string {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`;
}

export const usd = (n: number) => `$${n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2)}`;

export function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** A folder of code: `this checkout`, or its path, with its branch, commit and changes. */
export function describeFolder(
  folder: Pick<Folder, "branch" | "commit" | "dirty"> & { path?: string | undefined },
): string {
  const parts = [
    folder.branch ? `branch ${folder.branch}` : "detached",
    ...(folder.commit ? [`commit ${folder.commit.slice(0, 7)}`] : []),
  ];
  return `${folder.path ?? "this checkout"}, ${parts.join(", ")}${folder.dirty ? ", with uncommitted changes" : ""}`;
}
