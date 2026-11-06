import { relative, resolve } from "node:path";
import { isInside } from "./files";

/**
 * `path` as typed from `cwd`: relative under it, absolute elsewhere, so it works from anywhere; with
 * `home`, one under that home folder from `~`, shorter to read, though a quoted shell word won't
 * expand it.
 */
export function pathFrom(cwd: string, path: string, options: { home?: string } = {}): string {
  const absolute = resolve(cwd, path);
  if (isInside(cwd, absolute)) return relative(cwd, absolute);
  const { home } = options;
  return home !== undefined && absolute.startsWith(`${home}/`)
    ? `~${absolute.slice(home.length)}`
    : absolute;
}
