import { checkSchema } from "../../shared/validate";
import type { Errored } from "../format/records";
import type { Fact } from "../format/settings";
import type { EnvValue } from "../format/trial-env";
import { type Phase, type Refused, type TrialLine, TrialLineSchema } from "../format/trial-file";

/** The trial file's lines, each checked; a line that isn't one is the lab's to report. */
export function readTrialLines(text: string): { lines: TrialLine[]; bad: number } {
  const lines: TrialLine[] = [];
  let bad = 0;
  for (const raw of text.split("\n")) {
    if (raw.trim() === "") continue;
    try {
      const checked = checkSchema(TrialLineSchema, JSON.parse(raw));
      if (checked.ok) lines.push(checked.value);
      else bad++;
    } catch {
      bad++;
    }
  }
  return { lines, bad };
}

/** What `awf run` gave back, as far as blame needs it. */
export type RunEnding = {
  /** Absent: awf printed no record. */
  outcome?: string;
  reason?: string;
  value?: unknown;
  stderr: string;
  /** The run was refused at its first agent for a missing login, with no agent opened. */
  loginRefused: boolean;
};

export type Blamed = {
  errored?: Errored;
  workflowError?: string;
  stopped?: string;
  workflow?: { name: string; version?: string };
  result?: unknown;
  facts?: Record<string, Fact>;
  stages?: Record<string, unknown>;
  given?: string[];
  until?: string;
  neverReached?: string[];
  unused: string[];
  refused: Refused[];
};

const tail = (text: string) => text.trim().split("\n").slice(-5).join(" ").trim();

/**
 * Whose doing a trial's ending was, from the trial file and the run's record. An error or a
 * timeout is the workflow's only inside the body; anything before the trial file's first line,
 * a refused call, and `setup`, `observe` or teardown are the dataset's, and the dataset's error
 * wins over the workflow's whatever their order. A cancelled run is the lab's: no one's code
 * decided its ending.
 */
export function blame(allLines: readonly TrialLine[], ending: RunEnding): Blamed {
  const cut = allLines.findIndex((line) => "timedOut" in line);
  const lines = cut === -1 ? allLines : allLines.slice(0, cut + 1);
  let phase: Phase | undefined;
  const refused: Refused[] = [];
  let unused: string[] = [];
  let workflow: Blamed["workflow"];
  let datasetError: Extract<TrialLine, { error: unknown }>["error"] | undefined;
  let workflowError: Extract<TrialLine, { error: unknown }>["error"] | undefined;
  let cancelled: Phase | undefined;
  let timedOut: Phase | undefined;
  let stopped: string | undefined;
  let end: Extract<TrialLine, { end: unknown }>["end"] | undefined;
  for (const line of lines) {
    if ("phase" in line) phase = line.phase === "teardown" ? (phase ?? line.phase) : line.phase;
    else if ("refused" in line) refused.push(line.refused);
    else if ("unused" in line) unused = line.unused;
    else if ("workflow" in line) workflow = line.workflow;
    else if ("error" in line) {
      if (line.error.by === "dataset") datasetError ??= line.error;
      else workflowError ??= line.error;
    } else if ("cancelled" in line) cancelled ??= line.cancelled;
    else if ("timedOut" in line) timedOut = line.timedOut;
    else if ("stopped" in line) stopped = line.stopped.reason;
    else if ("end" in line) end = line.end;
  }
  const value =
    ending.outcome === "completed" ? (ending.value as Partial<EnvValue> | undefined) : undefined;
  const base: Blamed = {
    unused: value?.unused ?? unused,
    refused: refused.length > 0 ? refused : (value?.refused ?? []),
    ...((value?.workflow ?? workflow) ? { workflow: value?.workflow ?? workflow } : {}),
  };
  const dataset = (at: Phase | "after", code: Errored["code"], reason: string): Blamed => ({
    ...base,
    errored: { by: "dataset", phase: at, ...(code ? { code } : {}), reason },
  });

  if (cancelled !== undefined || ending.outcome === "cancelled") {
    return {
      ...base,
      errored: {
        by: "lab",
        phase: cancelled ?? phase ?? "body",
        reason: `the run was cancelled${ending.reason ? `: ${ending.reason}` : ""}`,
      },
    };
  }
  if (ending.loginRefused) {
    return {
      ...base,
      errored: {
        by: "provider",
        phase: phase ?? "body",
        code: "login",
        reason: ending.reason ?? "",
      },
    };
  }
  if (base.refused.length > 0) {
    const first = base.refused[0]!;
    return dataset(first.phase, "refused", first.message);
  }
  if (datasetError) return dataset(datasetError.phase, datasetError.code, datasetError.reason);
  if (timedOut) {
    return timedOut === "body"
      ? { ...base, workflowError: "timed out in body" }
      : dataset(timedOut, "timed-out", `timed out in ${timedOut}`);
  }
  if (workflowError) return { ...base, workflowError: workflowError.reason };
  if (lines.length === 0 && ending.outcome !== "completed") {
    // Died before defineEnv wrote anything: env.ts or what it imports statically, the fix is there.
    const said = tail(ending.stderr) || ending.reason || "awf run printed nothing";
    return dataset("setup", "threw", said);
  }

  const facts = value?.facts ?? end?.facts;
  if (facts) {
    const graded: Blamed = {
      ...base,
      ...(value && "result" in value ? { result: value.result } : {}),
      facts,
      stages: value?.stages ?? end?.stages ?? {},
      given: value?.given ?? end?.given ?? [],
      ...(end?.until ? { until: end.until } : {}),
      ...(end?.neverReached?.length ? { neverReached: end.neverReached } : {}),
    };
    if (stopped && !end?.until) return { ...graded, stopped };
    const flat = Object.entries(facts).find(([, fact]) => !isFlat(fact));
    if (flat) {
      return dataset(
        "observe",
        "fact-type",
        `fact ${flat[0]} is not a string, number, boolean or null`,
      );
    }
    const said = facts.error;
    if (typeof said === "string" && said !== "") return { ...graded, workflowError: said };
    return graded;
  }
  if (stopped) return { ...base, stopped };
  if (ending.outcome === "completed") {
    return dataset("observe", "facts-missing", "the run completed with no facts");
  }
  const reason = ending.reason ?? (tail(ending.stderr) || `awf run printed no record`);
  if (phase === "body") return { ...base, workflowError: reason };
  const code = ending.outcome === "timed-out" ? "timed-out" : "threw";
  return dataset(phase ?? "setup", code, reason);
}

function isFlat(value: unknown): value is Fact {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}
