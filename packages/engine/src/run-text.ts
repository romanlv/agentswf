// How the commands that read runs show what a run wrote, what it cost, and when.
import { maskCredentials } from "@agentswf/harness";
import { usd } from "./accounting/format";

/** A field whose name says it holds a credential, whatever its value looks like. */
const SECRET_NAME =
  /password|passwd|passphrase|passcode|secret|token|credential|cookie|bearer|authorization|(?:api|access|private|session|ssh|signing|encryption)[_-]?key|^(?:pwd|pass|pin|auth)$/i;

/**
 * Every string in `value` masked, and everything under a credential's name hidden: a run's text,
 * errors and fields are its workflow's, its agents' and its tools'. Past `limit`, a string is cut.
 */
export function masked(value: unknown, limit = Number.POSITIVE_INFINITY, hidden = false): unknown {
  if (typeof value === "string") {
    if (hidden) return "***";
    const shown = maskCredentials(value);
    return shown.length > limit ? `${shown.slice(0, limit - 1)}…` : shown;
  }
  if (hidden && value !== null && typeof value !== "object") return "***";
  if (Array.isArray(value)) return value.map((each) => masked(each, limit, hidden));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, each]) => [
        key,
        masked(each, limit, hidden || SECRET_NAME.test(key)),
      ]),
    );
  }
  return value;
}

/**
 * Text a run wrote, as one masked line of about `limit` characters, so it can never pass for a
 * line of its own or fill a page. `@{handle} --full` prints it whole.
 */
export function said(text: string, limit = 120): string {
  const line = maskCredentials(text).replace(/\s*[\r\n]+\s*/g, " ⏎ ");
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

/**
 * As `usd` says it, and nothing for none; `?` after it when some cost is unknown, which makes it a
 * floor.
 */
export function money(estimate: number | undefined, unknown = 0): string[] {
  if (!estimate) return [];
  return [`${usd(estimate)}${unknown > 0 ? "?" : ""}`];
}

export function clockTime(at: number | string): string {
  const date = new Date(at);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}
