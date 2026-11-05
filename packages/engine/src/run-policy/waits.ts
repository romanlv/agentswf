import type { EventLine, RunLine, Taken, WaitTake } from "@agentswf/contract/records";
import { type AgentEnded, awfEventOf, type JsonValue } from "@agentswf/contract/workflow";

type LineOf<K extends RunLine["kind"]> = Extract<RunLine, { kind: K }>;
export type WaitLine = LineOf<"wait">;
export type TurnStartedLine = LineOf<"turn-started">;

/**
 * Where an event a wait can take comes from, which orders those at one time: a timer due, then a
 * turn's end, then a sender's event; a time read from state comes after every ready event.
 */
export type Origin = "timer" | "end" | "event" | "time";
const RANK: Record<Origin, number> = { timer: 0, end: 1, event: 2, time: 3 };

/** An event a wait can take, as it would be handed to the code, and where it came from. */
export type WaitEvent = {
  id: string;
  name: string;
  data: JsonValue;
  from: string;
  at: string;
  origin: Origin;
  /** The event that created the run. */
  starts?: true;
  /** A turn's end: the attempt that began the turn. */
  began?: number;
};

/** The ids awf derives for what it never writes as an event: a timer's, and a time read from state's. */
export type DerivedIds = {
  timer(name: string): string;
  at(branch: string, due: string): string;
};

/** A timer as the lines have it: when it is due, an ISO time, and what became of it. */
export type TimerState = {
  name: string;
  due: string;
  /** As the code gave it: a duration, or an ISO time. */
  when: string;
  cancelled: boolean;
  /** A wait or a race took it. */
  taken: boolean;
  /** Taken, or due by the time the lines were read: no longer a deadline to wait for. */
  fired: boolean;
};

/** What a wait can take and what the waits have done, from `run.jsonl` and `in.jsonl` at a time. */
export type WaitState = {
  /** Every event a wait could take or took, by id: the first under an id is kept. */
  events: ReadonlyMap<string, WaitEvent>;
  /** Event ids no wait has acknowledged and none holds, in the order a wait takes them. */
  unacknowledged: string[];
  /** What the last wait outside a stage took that no later wait outside one acknowledged. */
  held?: string[];
  /** What the wait that took `held` takes: absent for a `receive`'s batch. */
  heldTakes?: WaitTake[];
  /** The last wait called, and whether it is still waiting: nothing taken after it. */
  lastWait?: WaitLine & { waiting: boolean };
  /** Each stage's batch, as a wait in it took it. */
  batches: ReadonlyMap<string, string[]>;
  /** Every turn `start()` began, in order. */
  turns: readonly TurnStartedLine[];
  /** Every timer by name, as first set. */
  timers: ReadonlyMap<string, TimerState>;
  /** What each race took, by its name: the branch that won and the event. */
  races: ReadonlyMap<string, { branch: string; ids: string[] }>;
  /** The event that created the run. */
  started?: WaitEvent;
  /** The clock it was folded at, which says which timers are due. */
  now: number;
  /** How it derives a timer's and a time's id. */
  ids: DerivedIds;
};

/**
 * The lines a reader acts on: a line of an attempt before the latest `claimed` is a stale writer's,
 * ignored, as `readRun` ignores it.
 */
export function unfenced(lines: readonly RunLine[]): RunLine[] {
  let claimed = 0;
  return lines.filter((line) => {
    if (line.attempt < claimed) return false;
    if (line.kind === "claimed") claimed = line.attempt;
    return true;
  });
}

/**
 * What the waits see: `in.jsonl`'s events, the turns' ends and the timers due by `now`, merged, and
 * what the `wait`, `took` and `race` lines did with them. A wait outside a stage and a race
 * acknowledges its `acks` and ends the held batch; a `took` in a stage, and a race, acknowledge
 * their own, which the stage or race holds. A cancelled timer counts as acknowledged.
 */
export function foldWaits(given: {
  lines: readonly RunLine[];
  events: readonly EventLine[];
  now: number;
  ids: DerivedIds;
}): WaitState {
  const { ids, now } = given;
  const events = new Map<string, WaitEvent>();
  /** The order each id was met in, which breaks a tie of time and origin. */
  const met = new Map<string, number>();
  const add = (event: WaitEvent) => {
    if (events.has(event.id)) return;
    events.set(event.id, event);
    met.set(event.id, met.size);
  };
  for (const line of given.events)
    add({
      id: line.id,
      name: line.name,
      data: line.data,
      from: line.from,
      at: line.at,
      origin: "event",
      ...(line.starts ? { starts: true as const } : {}),
    });
  const acknowledged = new Set<string>();
  const batches = new Map<string, string[]>();
  const races = new Map<string, { branch: string; ids: string[] }>();
  const timers = new Map<string, TimerState>();
  const turns: TurnStartedLine[] = [];
  let held: string[] | undefined;
  let heldTakes: WaitTake[] | undefined;
  let lastWait: (WaitLine & { waiting: boolean }) | undefined;
  const took = (entries: readonly Taken[], at: string): string[] =>
    entries.map((entry) => {
      if (entry.timer !== undefined) {
        const timer = timers.get(entry.timer);
        if (timer) timer.taken = true;
        add(timerEvent(entry.id, entry.timer, timer?.due ?? at));
      } else if (entry.branch !== undefined && entry.due !== undefined) {
        add(timeEvent(entry.id, entry.branch, entry.due));
      }
      return entry.id;
    });
  for (const line of unfenced(given.lines)) {
    switch (line.kind) {
      case "timer": {
        let timer = timers.get(line.name);
        if (!timer) {
          timer = {
            name: line.name,
            due: line.due,
            when: line.when,
            cancelled: false,
            taken: false,
            fired: false,
          };
          timers.set(line.name, timer);
        }
        if (line.cancelled) {
          timer.cancelled = true;
          acknowledged.add(ids.timer(line.name));
        }
        break;
      }
      case "wait":
        // A wait in a stage or a race leaves the loop's batch to the loop.
        if (line.stage === undefined && line.race === undefined) {
          for (const id of line.acks ?? []) acknowledged.add(id);
          held = undefined;
        }
        lastWait = { ...line, waiting: true };
        break;
      case "took": {
        const taken = took(line.took, line.at);
        if (lastWait) lastWait.waiting = false;
        if (line.stage !== undefined) {
          for (const id of taken) acknowledged.add(id);
          batches.set(line.stage, taken);
        } else {
          held = taken.length > 0 ? taken : undefined;
          heldTakes = lastWait?.takes;
        }
        break;
      }
      case "race": {
        const taken = took(line.took, line.at);
        if (lastWait) lastWait.waiting = false;
        for (const id of taken) acknowledged.add(id);
        if (!races.has(line.name)) races.set(line.name, { branch: line.branch, ids: taken });
        break;
      }
      case "turn-started":
        turns.push(line);
        break;
      case "turn-ended":
        add({
          id: line.id,
          name: "agent:ended",
          data: line.end as unknown as JsonValue,
          from: line.agent,
          at: line.at,
          origin: "end",
          began: line.began,
        });
        break;
    }
  }
  for (const timer of timers.values()) {
    timer.fired = timer.taken || Date.parse(timer.due) <= now;
    if (!timer.cancelled && !timer.taken && Date.parse(timer.due) <= now)
      add(timerEvent(ids.timer(timer.name), timer.name, timer.due));
  }
  const taken = new Set(held);
  const order = (a: string, b: string) => {
    const x = events.get(a) as WaitEvent;
    const y = events.get(b) as WaitEvent;
    return (
      Date.parse(x.at) - Date.parse(y.at) ||
      RANK[x.origin] - RANK[y.origin] ||
      (met.get(a) as number) - (met.get(b) as number)
    );
  };
  const started = [...events.values()].find((event) => event.starts);
  return {
    events,
    unacknowledged: [...events.keys()]
      .filter((id) => !acknowledged.has(id) && !taken.has(id))
      .sort(order),
    ...(held ? { held } : {}),
    ...(held && heldTakes ? { heldTakes } : {}),
    ...(lastWait ? { lastWait } : {}),
    batches,
    turns,
    timers,
    races,
    ...(started ? { started } : {}),
    now,
    ids,
  };
}

function timerEvent(id: string, name: string, due: string): WaitEvent {
  return { id, name: "timer:due", data: { name }, from: name, at: due, origin: "timer" };
}

function timeEvent(id: string, branch: string, due: string): WaitEvent {
  return { id, name: "at:due", data: {}, from: branch, at: due, origin: "time" };
}

/** The events not acknowledged that a wait taking `takes` would take, in order. */
export function readyFor(state: WaitState, takes: readonly WaitTake[] | undefined): string[] {
  return state.unacknowledged.filter((id) => {
    const event = state.events.get(id);
    return event !== undefined && wouldTake(event, takes);
  });
}

/** Whether `ids`, a crash's held batch, is a select's time read from state, alone. */
function isTimeRead(state: WaitState, ids: readonly string[]): boolean {
  return ids.length === 1 && state.events.get(ids[0] as string)?.origin === "time";
}

/** Timers neither fired nor cancelled, earliest first. */
function pendingTimers(state: WaitState): TimerState[] {
  return [...state.timers.values()]
    .filter((timer) => !timer.fired && !timer.cancelled)
    .sort((a, b) => Date.parse(a.due) - Date.parse(b.due));
}

/**
 * A select's times read from state that it hasn't returned, earliest first, and of two at once the
 * branch declared first. A time returned is no deadline, so state left as it was doesn't spin.
 */
export function pendingTimes(
  state: WaitState,
  takes: readonly WaitTake[] | undefined,
): { branch: string; due: string }[] {
  return (takes ?? [])
    .flatMap((take, order) =>
      take.name === "at:due" &&
      take.from !== undefined &&
      take.due !== undefined &&
      !state.events.has(state.ids.at(take.from, take.due))
        ? [{ branch: take.from, due: take.due, order }]
        : [],
    )
    .sort((a, b) => Date.parse(a.due) - Date.parse(b.due) || a.order - b.order)
    .map(({ branch, due }) => ({ branch, due }));
}

/**
 * When the earliest timer, or time read from state, a wait taking `takes` would take is due, epoch
 * ms; undefined with none.
 */
export function nextTimer(
  state: WaitState,
  takes: readonly WaitTake[] | undefined,
): number | undefined {
  const timer = pendingTimers(state).find((each) =>
    wouldTake({ name: "timer:due", from: each.name }, takes),
  );
  const time = pendingTimes(state, takes)[0];
  const dues = [timer?.due, time?.due].flatMap((due) => (due ? [Date.parse(due)] : []));
  return dues.length > 0 ? Math.min(...dues) : undefined;
}

/**
 * Whether a wait taking `takes` has something to take by the clock `state` was folded at: an
 * event, or a timer due. The one test for taking, parking, and waking a parked run.
 */
export function hasWork(state: WaitState, takes: readonly WaitTake[] | undefined): boolean {
  if (readyFor(state, takes).length > 0) return true;
  const due = nextTimer(state, takes);
  return due !== undefined && due <= state.now;
}

/**
 * What would wake a run parked at a wait taking `takes`, by the clock `state` was folded at: an
 * event it takes, a timer of its due, or nothing.
 */
export function wakeCause(
  state: WaitState,
  takes: readonly WaitTake[] | undefined,
): "event" | "timer" | undefined {
  const ready = readyFor(state, takes);
  if (ready.some((id) => state.events.get(id)?.origin !== "timer")) return "event";
  return ready.length > 0 || hasWork(state, takes) ? "timer" : undefined;
}

/**
 * What an attempt's first `receive` outside a stage returns without waiting: the batch an earlier
 * attempt took and never acknowledged. A select's time read from state is the select's: the
 * receive acknowledges it instead.
 */
export function firstReceive(state: WaitState): string[] | undefined {
  return state.held && !isTimeRead(state, state.held) ? state.held : undefined;
}

/**
 * What an attempt's first `select` does with the held batch: returns the held event when it is the
 * select's own and still taken by `takes`, or waits, `returns` when what it leaves held goes back
 * to waiting rather than being acknowledged. A held time read from state whose state has moved is
 * acknowledged, not returned.
 */
export function firstSelect(
  state: WaitState,
  takes: readonly WaitTake[],
): { event: WaitEvent } | { returns: boolean } {
  // A select's own, not a receive's batch of one.
  const held =
    state.held?.length === 1 && state.heldTakes
      ? state.events.get(state.held[0] as string)
      : undefined;
  if (held?.origin === "time") {
    const still = takes.some(
      (take) => take.name === "at:due" && take.from === held.from && take.due === held.at,
    );
    return still ? { event: held } : { returns: false };
  }
  if (held && wouldTake(held, takes)) return { event: held };
  return { returns: state.held !== undefined };
}

/** What a wait outside a stage and a race acknowledges as it asks for the next: the held batch. */
export function acksOf(state: WaitState): string[] | undefined {
  return state.held;
}

/** Of the events none took when the run returned, those that aren't the one that started it. */
export function untakenAtReturn(state: WaitState): number {
  return state.unacknowledged.filter((id) => id !== state.started?.id).length;
}

/** A turn's three parts: code rerun from the top begins the same turn again, a turn of its own. */
function turnKey(turn: { agent: string; turn: string }, began: number): string {
  return JSON.stringify([turn.agent, turn.turn, began]);
}

/**
 * The turns `start()` began that have no end: an attempt ended with them in flight, and the next
 * claim ends each, before any wait. Read from the lines the claim acts on.
 */
export function unendedTurns(lines: readonly RunLine[]): TurnStartedLine[] {
  const kept = unfenced(lines);
  const ended = new Set(
    kept.flatMap((line) => (line.kind === "turn-ended" ? [turnKey(line, line.began)] : [])),
  );
  return kept.flatMap((line) =>
    line.kind === "turn-started" && !ended.has(turnKey(line, line.attempt)) ? [line] : [],
  );
}

/** An agent's turn an earlier attempt started whose end no wait took: its id and meta. */
export type RestoredTurn = { turn: string; meta: JsonValue };

/** Each agent's last turn whose end no wait has taken: what `agent.turn` is when the agent opens. */
export function restoredTurns(state: WaitState): Map<string, RestoredTurn> {
  const untaken = new Set([...state.unacknowledged, ...(state.held ?? [])]);
  const ends = new Map<string, string>();
  for (const [id, event] of state.events)
    if (event.origin === "end" && event.began !== undefined)
      ends.set(
        turnKey({ agent: event.from, turn: (event.data as AgentEnded).turn }, event.began),
        id,
      );
  const restored = new Map<string, RestoredTurn>();
  for (const turn of state.turns) {
    const id = ends.get(turnKey(turn, turn.attempt));
    if (id !== undefined && untaken.has(id))
      restored.set(turn.agent, { turn: turn.turn, meta: turn.meta });
  }
  return restored;
}

/** Each attempt's last wait label: what a parked attempt was waiting for. */
export function waitLabels(lines: readonly RunLine[]): Map<number, string> {
  const labels = new Map<number, string>();
  for (const line of unfenced(lines))
    if (line.kind === "wait" && line.label !== undefined) labels.set(line.attempt, line.label);
  return labels;
}

/**
 * The name awf records an event under: awf's keep `agent:ended` and `participant:reply`, from their
 * key, whatever name the workflow declares and is handed, `{key}:ended` or `{key}:reply`.
 */
export function recordName(event: { name: string; from: string }): string {
  const awf = awfEventOf(event.name);
  if (!awf || awf.key !== event.from) return event.name;
  return awf.kind === "ended" ? "agent:ended" : "participant:reply";
}

/** Whether a wait that takes `take` takes `event`, under its recorded name or its declared one. */
export function matches(
  event: { name: string; from: string; data?: unknown },
  take: WaitTake,
): boolean {
  if (recordName(event) !== take.name) return false;
  if (take.from !== undefined && event.from !== take.from) return false;
  if (take.turn === undefined) return true;
  const data = event.data as { turn?: unknown } | null | undefined;
  return typeof data === "object" && data !== null && data.turn === take.turn;
}

/** Whether a wait taking `wanted`, or everything when it names nothing, takes `event`. */
export function wouldTake(
  event: { name: string; from: string; data?: unknown },
  wanted: readonly WaitTake[] | undefined,
): boolean {
  return wanted === undefined || wanted.some((take) => matches(event, take));
}

/** The first of `branches` that takes `event`. */
export function branchOf(
  branches: readonly (readonly [string, WaitTake])[],
  event: { name: string; from: string; data?: unknown },
): string | undefined {
  return branches.find(([, take]) => matches(event, take))?.[0];
}
