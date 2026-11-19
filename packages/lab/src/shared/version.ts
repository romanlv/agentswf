/**
 * A versioned subject's version, in semver, as its file declares it: a grader, a comparison, the
 * criteria judge. Results belong to `{name}@{major}.{minor}`: a patch bump says the behaviour is the
 * same, so earlier results still count. What counts as the same is the author's call; nothing
 * checks it.
 */
export const DEFAULT_VERSION = "1.0.0";

export const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function checkVersion(version: string): string | undefined {
  return SEMVER.test(version) ? undefined : `version ${version} is not {major}.{minor}.{patch}`;
}

/** The `{major}.{minor}` results belong to, so a patch bump keeps them. */
export function minorOf(version: string): string;
export function minorOf(version: string | undefined): string | undefined;
export function minorOf(version: string | undefined): string | undefined {
  return version?.split(".").slice(0, 2).join(".");
}
