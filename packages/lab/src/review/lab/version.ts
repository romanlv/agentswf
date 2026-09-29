/**
 * A variant's or scorer's version, in semver, as its file declares it. Results belong to
 * `{name}@{major}.{minor}`: a patch bump says the behaviour is the same, so earlier results still
 * count. What counts as the same is the researcher's call; nothing checks it.
 */
export const DEFAULT_VERSION = "1.0.0";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function checkVersion(version: string): string | undefined {
  return SEMVER.test(version) ? undefined : `version ${version} is not {major}.{minor}.{patch}`;
}

/** The `{major}.{minor}` results belong to. */
export function seriesOf(version: string): string {
  const [major, minor] = version.split(".");
  return `${major}.${minor}`;
}

/** Whose results a record or subject is: `{name}@{major}.{minor}`, its results folder's name. */
export const keyOf = (identity: { name: string; version: string }) =>
  `${identity.name}@${seriesOf(identity.version)}`;

/** A key back into its name and series: `panel@1.2` is `panel` and `1.2`. */
export function parseKey(key: string): { name: string; series: string } | undefined {
  const at = key.lastIndexOf("@");
  const series = key.slice(at + 1);
  return at > 0 && /^\d+\.\d+$/.test(series) ? { name: key.slice(0, at), series } : undefined;
}

/** Whether a version or its prefix, as a command names it (`1`, `1.2`, `1.2.3`), covers a series. */
export const covers = (series: string, prefix: string) =>
  `${series}.`.startsWith(`${prefix}.`) || series === seriesOf(`${prefix}.0`);
