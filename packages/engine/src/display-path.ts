import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

/**
 * `path` as typed from `cwd`: relative under it, absolute elsewhere, so it works from anywhere; with
 * `home`, one under the home folder from `~`, shorter to read, though a quoted shell word won't
 * expand it.
 */
export function pathFrom(cwd: string, path: string, options: { home?: boolean } = {}): string {
  const absolute = resolve(cwd, path);
  const inside = relative(cwd, absolute);
  if (inside && !inside.startsWith("..") && !isAbsolute(inside)) return inside;
  const home = homedir();
  return options.home && absolute.startsWith(`${home}/`)
    ? `~${absolute.slice(home.length)}`
    : absolute;
}
