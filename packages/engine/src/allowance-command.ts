import {
  ALLOWANCE_VERSION,
  type AllowanceReport,
  type AllowanceWindow,
  type HarnessAllowance,
} from "@agentswf/contract/records";
import { HARNESS_NAMES, type Harness } from "@agentswf/harness";

export const allowanceUsage = [
  "usage: awf allowance [harness...] [--json]",
  "",
  "What is left of each harness's plan, as the harness itself shows it: claude's /usage, codex's",
  "/status, and cursor's /usage, read in a Herdr pane. Nothing asks a model. Every harness when",
  `none is named: ${HARNESS_NAMES.join(", ")}.`,
  "",
  `--json prints an ${ALLOWANCE_VERSION} record, the interface for scripts; what it prints`,
  "otherwise is for reading. A harness that could not be read says why. Exits 0 once every",
  "harness was asked, 2 on a usage error.",
].join("\n");

export type AllowanceCommand = { harnesses: Harness[]; json: boolean } | "help";

export function parseAllowanceCommand(argv: readonly string[]): AllowanceCommand {
  const harnesses: Harness[] = [];
  let json = false;
  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") return "help";
    if (arg === "--json") json = true;
    else if ((HARNESS_NAMES as readonly string[]).includes(arg)) {
      if (!harnesses.includes(arg as Harness)) harnesses.push(arg as Harness);
    } else throw new Error(`unknown harness or option: ${arg}`);
  }
  return { harnesses: harnesses.length > 0 ? harnesses : [...HARNESS_NAMES], json };
}

/** Every harness asked at once: cursor's pane takes seconds the others need not wait for. */
export async function readReport(
  harnesses: readonly Harness[],
  read: (harness: Harness) => Promise<HarnessAllowance>,
  now: number,
): Promise<AllowanceReport> {
  return {
    version: ALLOWANCE_VERSION,
    readAt: new Date(now).toISOString(),
    harnesses: await Promise.all(harnesses.map(read)),
  };
}

/** A line per harness, its windows in the order it shows them; a reset they share, said once. */
export function describeReport(report: AllowanceReport, timeZone?: string): string {
  const width = Math.max(...report.harnesses.map((each) => each.harness.length)) + 2;
  const now = Date.parse(report.readAt);
  return report.harnesses
    .map((each) => {
      const said =
        each.read === "none"
          ? `no allowance: ${each.reason}`
          : [
              ...(each.plan ? [each.plan] : []),
              ...sharingReset(each.windows).map((windows) => {
                const used = windows.map((w) => `${w.label} ${w.usedPercent}%`).join(", ");
                const resetsAt = windows[0]?.resetsAt;
                return resetsAt
                  ? `${used}, resets ${describeTime(Date.parse(resetsAt), now, timeZone)}`
                  : used;
              }),
            ].join(" · ");
      return `${each.harness.padEnd(width)}${said}`;
    })
    .join("\n");
}

/** Runs of windows, in order, that reset at the same time. */
function sharingReset(windows: readonly AllowanceWindow[]): AllowanceWindow[][] {
  const runs: AllowanceWindow[][] = [];
  for (const window of windows) {
    const last = runs.at(-1);
    if (last && last[0]?.resetsAt === window.resetsAt) last.push(window);
    else runs.push([window]);
  }
  return runs;
}

/** The time alone today, the day alone at midnight, as a day only resets there. */
function describeTime(at: number, now: number, timeZone?: string): string {
  const format = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("en-US", { ...options, ...(timeZone ? { timeZone } : {}) }).format;
  const day = format({ month: "short", day: "numeric" });
  const time = format({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" })(at);
  if (day(at) === day(now)) return time;
  return time === "00:00" ? day(at) : `${day(at)} ${time}`;
}
