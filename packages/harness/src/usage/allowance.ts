import { homedir } from "node:os";
import { join } from "node:path";
import type { AllowanceWindow, HarnessAllowance } from "@agentswf/contract/records";
import type { RunProcess } from "../command";
import { jsonLines, parseRow, type Row, record, reported, text } from "../json";
import { STATUS_TIMEOUT_MS } from "./billing";

/** A harness's allowance before it is named: what its reader saw. */
export type AllowanceRead = HarnessAllowance extends infer A
  ? A extends HarnessAllowance
    ? Omit<A, "harness">
    : never
  : never;

const READ_TIMEOUT_MS = 30_000;

const none = (reason: string): AllowanceRead => ({ read: "none", reason });

/**
 * `claude -p /usage`: claude runs the command itself, with no model turn, and prints what its TUI
 * shows. Its runs are not kept, so nothing is added to the operator's session list.
 */
export async function readClaudeAllowance(
  run: RunProcess,
  now: number,
  accountFile = claudeAccountFile(),
): Promise<AllowanceRead> {
  const [result, status, account] = await Promise.all([
    run({
      argv: ["claude", "-p", "/usage", "--output-format", "json", "--no-session-persistence"],
      timeoutMs: READ_TIMEOUT_MS,
    }),
    run({ argv: ["claude", "auth", "status", "--json"], timeoutMs: STATUS_TIMEOUT_MS }),
    Bun.file(accountFile)
      .text()
      .catch(() => ""),
  ]);
  if (result.timedOut) return none("`claude -p /usage` did not answer in time");
  const read = claudeAllowance(
    result.stdout,
    now,
    `exited ${result.exitCode}: ${result.stderr.trim()}`,
  );
  if (read.read === "none") return read;
  const { plan, tier } = claudePlan(status.exitCode === 0 ? status.stdout : "", account);
  return { ...read, ...(plan ? { plan } : {}), ...(tier ? { tier } : {}) };
}

/**
 * Where claude keeps its account, beside its state when `CLAUDE_CONFIG_DIR` moves it, else in the
 * home directory itself: `~/.claude.json`, not under `~/.claude`.
 */
export function claudeAccountFile(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const moved = environment.CLAUDE_CONFIG_DIR?.trim();
  return moved ? join(moved, ".claude.json") : join(environment.HOME ?? homedir(), ".claude.json");
}

/**
 * The plan `claude auth status` names, `pro` or `max`, and its tier, which only the account claude
 * keeps tells: `default_claude_max_20x`. The account's format is claude's own and undocumented.
 */
export function claudePlan(status: string, account: string): { plan?: string; tier?: string } {
  const plan = text(parseRow(status)?.subscriptionType);
  const oauth = record(parseRow(account)?.oauthAccount);
  const tier = text(oauth?.organizationRateLimitTier) ?? text(oauth?.userRateLimitTier);
  return { ...(plan ? { plan } : {}), ...(tier ? { tier } : {}) };
}

const CLAUDE_WINDOW = /^Current (.+?): (\d+(?:\.\d+)?)% used(?: · resets (.+))?$/;

/**
 * Claude's `/usage` text: a line per window, `Current week (Fable): 12% used · resets Oct 8 at 12pm
 * (America/Toronto)`. A window `(all models)` limits every model; another's parenthesis names the
 * models it limits.
 */
export function claudeAllowance(stdout: string, now: number, failed = ""): AllowanceRead {
  const output = parseRow(stdout.trim());
  const said = text(output?.result);
  if (!output || !said)
    return none(`\`claude -p /usage\` printed no result${failed && `; ${failed}`}`);
  if (output.is_error === true) return none(`claude: ${firstLine(said)}`);
  const windows = said.split("\n").flatMap((line): AllowanceWindow[] => {
    const match = line.trim().match(CLAUDE_WINDOW);
    if (!match) return [];
    const [, label = "", used = "", resets] = match;
    const scoped = label.match(/^(.*?) \((.+)\)$/);
    const base = scoped?.[1] ?? label;
    const models = scoped?.[2] === "all models" ? undefined : scoped?.[2]?.replace(/ only$/, "");
    const resetsAt = resets ? claudeReset(resets, now) : undefined;
    return [
      {
        id: models ? `${slug(base)}-${slug(models)}` : slug(base),
        label,
        usedPercent: Number(used),
        ...(resetsAt ? { resetsAt } : {}),
        ...(models ? { models: [models] } : {}),
      },
    ];
  });
  if (windows.length === 0) return none(`claude's /usage showed no plan: ${firstLine(said)}`);
  return { read: "plan", source: "claude /usage", windows };
}

const CLAUDE_RESET =
  /^(?:([A-Z][a-z]{2,3}) (\d{1,2})(?:,? at |, | ))?(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?: \((.+)\))?$/i;

/**
 * `Oct 5 at 5:19pm (America/Toronto)`, or a time alone. A time alone is the next one: today's, or
 * tomorrow's once today's has passed. A date names no year: the reset is in the year that puts it
 * nearest the read, which a stale screen may leave just behind it.
 */
export function claudeReset(said: string, now: number): string | undefined {
  const match = said.trim().match(CLAUDE_RESET);
  if (!match) return undefined;
  const [, month, day, hour = "", minute, half = "", zone] = match;
  const hours = (Number(hour) % 12) + (half.toLowerCase() === "pm" ? 12 : 0);
  const timeZone = zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  let today: { year: number; month: number; day: number };
  try {
    today = partsIn(now, timeZone);
  } catch {
    return undefined;
  }
  const monthIndex = month ? MONTHS.indexOf(month.slice(0, 3).toLowerCase()) : today.month - 1;
  if (monthIndex < 0) return undefined;
  const at = (year: number, dayOfMonth: number) =>
    zonedTime(year, monthIndex, dayOfMonth, hours, Number(minute ?? 0), timeZone);
  if (!day) {
    const later = at(today.year, today.day);
    // Printed to the minute, so a reset this minute reads as just behind.
    return new Date(later >= now - MINUTE_MS ? later : at(today.year, today.day + 1)).toISOString();
  }
  const nearest = [today.year - 1, today.year, today.year + 1]
    .map((year) => at(year, Number(day)))
    .reduce((best, each) => (Math.abs(each - now) < Math.abs(best - now) ? each : best));
  return new Date(nearest).toISOString();
}

/**
 * `codex app-server`'s `account/rateLimits/read`, the snapshot its TUI's `/status` shows. It asks
 * no model, and exits once its stdin closes.
 */
export async function readCodexAllowance(run: RunProcess): Promise<AllowanceRead> {
  const answered = (row: Row | undefined) => row?.id === 2;
  const result = await run({
    argv: ["codex", "app-server", "--listen", "stdio://"],
    stdin: `${[
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { clientInfo: { name: "awf", version: "0" } },
      }),
      JSON.stringify({ jsonrpc: "2.0", method: "initialized" }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "account/rateLimits/read",
        params: { excludeResetCreditDetails: true },
      }),
    ].join("\n")}\n`,
    holdStdinUntil: (line) => answered(parseRow(line)),
    timeoutMs: READ_TIMEOUT_MS,
  });
  const response = jsonLines(result.stdout).find(answered);
  if (!response) {
    return none(
      result.timedOut
        ? "codex's app-server did not answer in time"
        : `codex's app-server did not answer: exited ${result.exitCode}: ${result.stderr.trim()}`,
    );
  }
  return codexAllowance(response);
}

/**
 * Every limit codex reports, each with up to two windows. The main limit's windows are named by
 * their length alone; a model's own limit by its name first, and it limits only that model.
 */
export function codexAllowance(response: Row): AllowanceRead {
  const refused = text(record(response.error)?.message);
  if (refused) return none(`codex: ${refused}`);
  const result = record(response.result);
  const byId = Object.values(record(result?.rateLimitsByLimitId) ?? {});
  const limits = byId.length > 0 ? byId : [result?.rateLimits];
  let plan: string | undefined;
  const windows = limits.flatMap((value): AllowanceWindow[] => {
    const limit = record(value);
    if (!limit) return [];
    plan ??= text(limit.planType);
    const limitId = text(limit.limitId) ?? "codex";
    const named = limitId === "codex" ? undefined : (text(limit.limitName) ?? limitId);
    const models = text(limit.normalModelSlug);
    return [limit.primary, limit.secondary].flatMap((side): AllowanceWindow[] => {
      const window = record(side);
      const usedPercent = reported(window?.usedPercent);
      if (!window || usedPercent === undefined) return [];
      const length = windowLength(reported(window.windowDurationMins));
      const resets = reported(window.resetsAt);
      return [
        {
          id: named ? `${slug(named)}-${length}` : length,
          label: named ? `${named} ${length}` : length,
          usedPercent,
          ...(resets === undefined ? {} : { resetsAt: new Date(resets * 1000).toISOString() }),
          ...(models ? { models: [models] } : {}),
        },
      ];
    });
  });
  if (windows.length === 0) return none("codex reported no plan limits");
  return {
    read: "plan",
    source: "codex account/rateLimits/read",
    ...(plan ? { plan } : {}),
    windows,
  };
}

function windowLength(minutes: number | undefined): string {
  if (minutes === undefined) return "window";
  if (minutes === 10_080) return "week";
  if (minutes % 1_440 === 0) return `${minutes / 1_440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

const CURSOR_ROW = /^\s*([A-Za-z][\w ]*?)\s{2,}(\d+(?:\.\d+)?)% used\b/;

/**
 * Cursor's `/usage` panel: `Usage • Team`, `Resets Oct 21`, then a row per pool, `Included 1%
 * used`, its parts indented under it. It shows the day of the reset only, in the operator's zone.
 */
export function cursorAllowance(screen: string, now: number): AllowanceRead {
  const lines = screen.split("\n");
  const header = lines.findLast((line) => /^\s*Usage • /.test(line));
  if (header === undefined) return none(`cursor's /usage did not show: ${lastLine(screen)}`);
  const plan = header.match(/Usage • (.+?)(?:\s{2,}|$)/)?.[1]?.trim();
  const resets = header.match(/Resets ([A-Z][a-z]{2,4}) (\d{1,2})/);
  const resetsAt = resets ? cursorReset(resets[1]!.slice(0, 3), Number(resets[2]), now) : undefined;
  const windows = lines.slice(lines.lastIndexOf(header)).flatMap((line): AllowanceWindow[] => {
    const match = line.match(CURSOR_ROW);
    if (!match) return [];
    const [, label = "", used = ""] = match;
    return [
      { id: slug(label), label, usedPercent: Number(used), ...(resetsAt ? { resetsAt } : {}) },
    ];
  });
  if (windows.length === 0) return none(`cursor's /usage showed no pools: ${lastLine(screen)}`);
  return { read: "plan", source: "cursor /usage", ...(plan ? { plan } : {}), windows };
}

function cursorReset(month: string, day: number, now: number): string | undefined {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const monthIndex = MONTHS.indexOf(month.toLowerCase());
  if (monthIndex < 0) return undefined;
  const { year } = partsIn(now, timeZone);
  const nearest = [year - 1, year, year + 1]
    .map((each) => zonedTime(each, monthIndex, day, 0, 0, timeZone))
    .reduce((best, each) => (Math.abs(each - now) < Math.abs(best - now) ? each : best));
  return new Date(nearest).toISOString();
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MINUTE_MS = 60_000;

function partsIn(at: number, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    })
      .formatToParts(at)
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: parts.year!,
    month: parts.month!,
    day: parts.day!,
    hour: parts.hour!,
    minute: parts.minute!,
    second: parts.second!,
  };
}

/** The instant a wall-clock time in `timeZone` names; corrected once for an offset that changes. */
function zonedTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  const wall = Date.UTC(year, month, day, hour, minute);
  const offset = (at: number) => {
    const p = partsIn(at, timeZone);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - at;
  };
  const guess = wall - offset(wall);
  return wall - offset(guess);
}

function slug(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-|-$/g, "");
}

function firstLine(said: string): string {
  return said.trim().split("\n")[0] ?? "";
}

function lastLine(screen: string): string {
  return (
    screen
      .split("\n")
      .map((line) => line.trim())
      .findLast((line) => line !== "") ?? "an empty screen"
  );
}
