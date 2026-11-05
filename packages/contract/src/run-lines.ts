import type { RunLine } from "./records";
import type { AgentKey } from "./workflow/agents";
import type { JsonValue } from "./workflow/json";
import type { StageOutcome } from "./workflow/workflow";

type RunLineKind = RunLine["kind"];
type LineOf<K extends RunLineKind> = Extract<RunLine, { kind: K }>;

/** A stage's end, a line of `run.jsonl`. Tier: public, stable. */
export type StageLine = LineOf<"stage">;

export type StageView = {
  /** Its latest line, of any outcome: a failed stage, told from one never run. */
  last: StageLine;
  /** Its latest succeeded line, provided ones included: what a continue may reuse. */
  settled?: StageLine;
  /** Every line under its name, in order, failures included. */
  history: StageLine[];
};

/** A timer's latest line, and whether a wait or a race took it. Due is for the reader's clock. */
export type TimerView = LineOf<"timer"> & { taken: boolean };

/** `run.jsonl` as a reader outside the engine needs it. What a continue reuses is the engine's. */
export type RunView = {
  stages: Record<string, StageView>;
  /**
   * The latest stage line with `redo`, the stage its attempt started at: from that attempt on, a
   * stage entered after it whose line is older reruns.
   */
  redo?: { attempt: number; stage: string };
  races: Record<string, LineOf<"race">>;
  timers: Record<string, TimerView>;
  /** Each name's latest saved value. */
  state: Record<string, JsonValue>;
  /** The latest wait. */
  wait?: LineOf<"wait">;
  sessions: { latest: Record<AgentKey, LineOf<"session">>; all: LineOf<"session">[] };
  /** Diagnostic: lines dropped because a later attempt had claimed the run before them. */
  fenced: number;
};

type Field = "string" | "string?" | "strings?" | "array?";

/** Every kind, with the fields this reading relies on or returns, and their types. */
const KINDS: Record<RunLineKind, Record<string, Field>> = {
  claimed: {},
  stage: {
    name: "string",
    outcome: "string",
    started: "string",
    reason: "string?",
    summary: "string?",
  },
  race: { name: "string", branch: "string" },
  timer: { name: "string", due: "string", when: "string" },
  took: { stage: "string?" },
  wait: {
    label: "string?",
    stage: "string?",
    race: "string?",
    acks: "strings?",
    takes: "array?",
  },
  "turn-started": {},
  "turn-ended": {},
  session: {
    agent: "string",
    harness: "string",
    session: "string",
    operation: "string?",
    home: "string?",
  },
};

const STAGE_OUTCOMES: Record<StageOutcome, true> = { succeeded: true, stopped: true, failed: true };

const FLAGS = ["provided", "redo", "cancelled", "returns"];

function fits(value: unknown, field: Field): boolean {
  if (field === "string") return typeof value === "string";
  if (value === undefined) return true;
  if (field === "string?") return typeof value === "string";
  if (field === "strings?") {
    return Array.isArray(value) && value.every((item) => typeof item === "string");
  }
  return Array.isArray(value);
}

function checked(value: unknown, n: number): RunLine {
  const refuse = (why: string): never => {
    throw new Error(`run.jsonl line ${n}: ${why}`);
  };
  if (!isObject(value)) return refuse("not an object");
  const line = value;
  if (typeof line.kind !== "string") refuse("no kind");
  const kind = line.kind as string;
  if (!Object.hasOwn(KINDS, kind)) refuse(`unknown kind "${kind}"`);
  if (!Number.isInteger(line.attempt) || (line.attempt as number) < 1) {
    refuse(`${kind} without a positive attempt`);
  }
  if (typeof line.at !== "string") refuse(`${kind} without at`);
  for (const [name, field] of Object.entries(KINDS[kind as RunLineKind])) {
    if (fits(line[name], field)) continue;
    refuse(field === "string" ? `${kind} without ${name}` : `${kind} with malformed ${name}`);
  }
  if (kind === "stage" && !Object.hasOwn(STAGE_OUTCOMES, line.outcome as string)) {
    refuse(`stage with unknown outcome "${line.outcome}"`);
  }
  for (const flag of FLAGS) {
    if (line[flag] !== undefined && line[flag] !== true) refuse(`${kind} with ${flag} not true`);
  }
  if (line.provided && line.outcome !== "succeeded") refuse(`${kind} provided but not succeeded`);
  if (kind === "race" || kind === "took") {
    if (!Array.isArray(line.took) || !line.took.every(isTaken)) {
      refuse(`${kind} with malformed took`);
    }
  }
  if (line.state !== undefined) {
    const state = line.state;
    const entry = (item: unknown) =>
      isObject(item) && typeof item.name === "string" && Object.hasOwn(item, "value");
    if (!Array.isArray(state) || !state.every(entry)) refuse(`${kind} with malformed state`);
  }
  return line as RunLine;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A string `id`; a timer's names its `timer`, a time read from state's its `branch` and `due`. */
function isTaken(item: unknown): boolean {
  if (!isObject(item) || typeof item.id !== "string") return false;
  const optional = ["timer", "branch", "due"].every(
    (field) => item[field] === undefined || typeof item[field] === "string",
  );
  if (!optional) return false;
  if (item.id.startsWith("awf.timer.")) return typeof item.timer === "string";
  if (item.id.startsWith("awf.at.")) {
    return typeof item.branch === "string" && typeof item.due === "string";
  }
  return true;
}

/**
 * Reads `run.jsonl`'s lines, each as `JSON.parse` returned it, in file order. Refuses a line it
 * doesn't know rather than skip it, since a skipped stage line misreports what a continue reuses.
 */
export function readRun(lines: readonly unknown[]): RunView {
  const view: RunView = {
    stages: Object.create(null),
    races: Object.create(null),
    timers: Object.create(null),
    state: Object.create(null),
    sessions: { latest: Object.create(null), all: [] },
    fenced: 0,
  };
  const taken = new Set<string>();
  let claimed = 0;
  lines.forEach((value, index) => {
    const line = checked(value, index + 1);
    if (line.attempt < claimed) {
      view.fenced++;
      return;
    }
    switch (line.kind) {
      case "claimed":
        claimed = line.attempt;
        break;
      case "stage": {
        const stage = view.stages[line.name];
        if (stage) {
          stage.last = line;
          stage.history.push(line);
        } else {
          view.stages[line.name] = { last: line, history: [line] };
        }
        if (line.outcome === "succeeded") view.stages[line.name]!.settled = line;
        if (line.redo) view.redo = { attempt: line.attempt, stage: line.name };
        for (const { name, value } of line.state ?? []) view.state[name] = value;
        break;
      }
      case "race":
        view.races[line.name] = line;
        for (const { timer } of line.took) if (timer !== undefined) taken.add(timer);
        break;
      case "timer":
        view.timers[line.name] = { ...line, taken: false };
        break;
      case "took":
        for (const { timer } of line.took) if (timer !== undefined) taken.add(timer);
        break;
      case "wait":
        view.wait = line;
        for (const { name, value } of line.state ?? []) view.state[name] = value;
        break;
      case "session":
        view.sessions.latest[line.agent] = line;
        view.sessions.all.push(line);
        break;
    }
  });
  for (const timer of Object.values(view.timers)) timer.taken = taken.has(timer.name);
  return view;
}
