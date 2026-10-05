import type { AllowanceReport, AllowanceWindow } from "@agentswf/contract/records";
import type { Runner } from "./runner";

/**
 * The harnesses `awf allowance` knows, as `awf allowance --help` lists them: the lab may not import
 * the harness package. A harness added there and not here is not waited on.
 */
const HARNESSES = new Set(["claude", "codex", "pi", "cursor"]);

/** How long a read stands for every run that asks: a cursor read opens a pane. */
const FRESH_MS = 60_000;
/** How often a full window that shows no reset is read again. */
const POLL_MS = 30 * 60_000;
/**
 * The longest single sleep: the wait is measured on the wall clock between them, so a machine that
 * slept through a reset wakes to it, not to a timer that stood still.
 */
const NAP_MS = 10 * 60_000;
/** A reset is read a minute after it, so the harness shows the new window. */
const AFTER_RESET_MS = 60_000;
/** The least a full window waits before it is read again. */
const RECHECK_MS = 5 * 60_000;

/** `awf allowance --json` for these harnesses, or every one when none is named. */
export type AllowanceSource = (
  harnesses: readonly string[],
) => Promise<AllowanceReport | undefined>;

type Runtime = { harness: string; model: string };

/** Every `harness/model` among a run's arguments, as `--runtime` and `--proposer` give them. */
export function runtimesIn(argv: readonly string[]): Runtime[] {
  return argv.flatMap((arg) => {
    const match = arg.replace(/^--[\w-]+=/, "").match(/^([a-z]+)\/(\S+)$/);
    return match && HARNESSES.has(match[1]!) ? [{ harness: match[1]!, model: match[2]! }] : [];
  });
}

/**
 * Windows at or past `limit` that a run on `runtimes` draws on: every window of their harnesses, a
 * window scoped to some models only when one of theirs names it.
 */
export function blocking(
  report: AllowanceReport,
  runtimes: readonly Runtime[],
  limit: number,
): { harness: string; window: AllowanceWindow }[] {
  return report.harnesses.flatMap((each) => {
    if (each.read !== "plan") return [];
    const models = runtimes.filter((r) => r.harness === each.harness).map((r) => r.model);
    if (models.length === 0) return [];
    return each.windows
      .filter((window) => window.usedPercent >= limit)
      .filter(
        (window) =>
          window.models === undefined ||
          window.models.some((scope) => models.some((model) => names(model, scope))),
      )
      .map((window) => ({ harness: each.harness, window }));
  });
}

/** Whether a model's id names a scope's words, `claude-opus-4-7` names `Opus 4.7`. */
function names(model: string, scope: string): boolean {
  const words = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return `-${words(model)}-`.includes(`-${words(scope)}-`);
}

/**
 * `runner`, holding each run until every plan window it draws on is under `limit` percent used:
 * a window at it waits for its reset and is read again then, or every half hour where it shows
 * none. A run that names no `harness/model`, as a scorer on its workflow's default, and a plan that
 * can't be read hold nothing; each is said once. A waiting run keeps the job slot and the budget
 * its plan admitted it with. A run already started is not stopped.
 */
export function waitingOnAllowance(
  runner: Runner,
  read: AllowanceSource,
  options: {
    limit: number;
    log: (line: string) => void;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  },
): Runner {
  const { limit, log } = options;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((wake) => setTimeout(wake, ms)));
  /** A read in flight is shared; a settled one stands `FRESH_MS` from when it settled. */
  const reads = new Map<
    string,
    { settled?: number; report: Promise<AllowanceReport | undefined> }
  >();
  const said = new Set<string>();
  const once = (line: string) => {
    if (said.has(line)) return;
    said.add(line);
    log(line);
  };
  const reportFor = (harnesses: readonly string[]) => {
    const key = [...harnesses].sort().join(",");
    const held = reads.get(key);
    if (held && (held.settled === undefined || now() - held.settled < FRESH_MS)) {
      return held.report;
    }
    const entry: { settled?: number; report: Promise<AllowanceReport | undefined> } = {
      report: read(harnesses)
        .catch(() => undefined)
        .finally(() => {
          entry.settled = now();
        }),
    };
    reads.set(key, entry);
    return entry.report;
  };
  return async (request) => {
    const runtimes = runtimesIn(request.argv);
    const harnesses = [...new Set(runtimes.map((r) => r.harness))];
    if (harnesses.length === 0) {
      once("allowance: a run that names no harness/model is not waited on");
      return runner(request);
    }
    let behind = 0;
    for (;;) {
      const report = await reportFor(harnesses);
      if (!report) {
        once("allowance: `awf allowance` gave no record; runs go ahead without it");
        break;
      }
      for (const each of report.harnesses) {
        if (each.read === "none" && harnesses.includes(each.harness))
          once(`allowance: ${each.harness} not read, so not waited on: ${each.reason}`);
      }
      const full = blocking(report, runtimes, limit);
      if (full.length === 0) break;
      const resets = full.map(({ window }) =>
        window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN,
      );
      const after = Math.max(...resets) + AFTER_RESET_MS;
      // A reset already behind the read is a screen not yet redrawn, or a reset shown only to the
      // day: looked at again shortly, then less often, up to the poll.
      const until = resets.some(Number.isNaN)
        ? now() + POLL_MS
        : after > now() + RECHECK_MS
          ? after
          : now() + Math.min(RECHECK_MS * 2 ** behind++, POLL_MS);
      const which = full
        .map(({ harness, window }) => `${harness}'s ${window.label} is ${window.usedPercent}%`)
        .join(", ");
      const when = new Date(until).toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      });
      once(`allowance: ${which} used, at or past ${limit}%; waiting until ${when}`);
      while (now() < until) await sleep(Math.min(until - now(), NAP_MS));
      reads.clear();
    }
    return runner(request);
  };
}
