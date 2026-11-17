import { seriesOf } from "../../shared/version";

export { checkVersion, DEFAULT_VERSION, seriesOf } from "../../shared/version";

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
