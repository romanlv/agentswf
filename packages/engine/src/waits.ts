import { stat } from "node:fs/promises";
import type { RunLine, Taken, WaitingJson, WaitTake } from "@agentswf/contract/records";
import type {
  AgentExecution,
  JsonValue,
  TurnOutcome,
  WorkflowEvent,
} from "@agentswf/contract/workflow";
import { DERIVED_IDS, endIdOf } from "./event-ids";
import { inSize, readIn } from "./in-lines";
import { type RunLines, readRunLines, runLinesFile } from "./run-lines";
import {
  acksOf,
  branchOf,
  firstReceive,
  firstSelect,
  foldWaits,
  hasWork,
  nextTimer,
  pendingTimes,
  type RestoredTurn,
  readyFor,
  restoredTurns,
  type TimerState,
  type WaitEvent,
  type WaitState,
} from "./run-policy/waits";

/** What `agent:ended` says of a turn: its id and meta, as `start()` was given them, and its outcome. */
export type TurnEnd = { turn: string; meta: JsonValue; outcome: TurnOutcome<JsonValue> };

/** What the waits see of a run at `now`: its `run.jsonl` and `in.jsonl`, folded. */
export async function readWaits(runDir: string, now: number): Promise<WaitState> {
  const [{ lines }, events] = await Promise.all([readRunLines(runDir), readIn(runDir)]);
  return foldWaits({ lines, events, now, ids: DERIVED_IDS });
}

/** What a `took` or `race` line names of `event`: its id, and which timer or time it was. */
function takenOf(event: WaitEvent): Taken {
  if (event.origin === "timer") return { id: event.id, timer: event.from };
  if (event.origin === "time") return { id: event.id, branch: event.from, due: event.at };
  return { id: event.id };
}

/** An event as a wait returns it. */
function eventOf(event: WaitEvent): WorkflowEvent<string, JsonValue> {
  return Object.freeze({
    id: event.id,
    name: event.name,
    data: event.data,
    from: event.from,
    at: event.at,
  });
}

/**
 * Thrown from a wait that parked the run: nothing waits to be taken, no turn runs, and the
 * attempt's `parked` ending is written. The runner ends the attempt with it.
 */
export class RunParked extends Error {
  constructor(readonly wait: WaitingJson) {
    super(`parked${wait.label === undefined ? "" : `: ${wait.label}`}`);
    this.name = "RunParked";
  }
}

/** How a run parks at a wait: whether it may, and the ending it writes when it does. */
export type Parking = {
  /**
   * Nothing of the run works but this wait, in `stage` if it is in one: so nothing but a new event
   * can change what the code would do.
   */
  idle(stage?: string): boolean;
  /**
   * With the run idle and nothing to take: calls one agent's due `onTimeout` and resolves true once
   * it returns, or false with none due. The signal stops waiting on it.
   */
  timeout(signal?: AbortSignal): Promise<boolean>;
  /** The end of the earliest agent window still open: the run stays live to it, not parked. */
  liveUntil(): number | undefined;
  /** Writes the attempt's `parked` ending, holding the run's lock, so a waker sees it at once. */
  park(wait: WaitingJson): Promise<void>;
  /**
   * The wait stays live to `until` for an agent's window rather than parking, called on each pass
   * that does: a test's hook, which sends what it scripted after a turn.
   */
  live?(until: number): Promise<void>;
  /**
   * With the run about to park and a timer it waits for due at `until`: moves the clock there, and
   * resolves true, rather than parking. A test's virtual clock; false parks.
   */
  skip?(until: number): Promise<boolean>;
};

/**
 * `in.jsonl`'s and `run.jsonl`'s sizes together, which a waiting run polls: a sender's event, or a
 * turn's end this attempt wrote, changes them.
 */
async function sizeOf(runDir: string): Promise<number> {
  const [events, lines] = await Promise.all([
    inSize(runDir),
    stat(runLinesFile(runDir)).then(
      (stats) => stats.size,
      () => 0,
    ),
  ]);
  return events + lines;
}

/** How often a wait looks at its files when no nudge comes: a nudge that failed still arrives. */
const POLL_MILLISECONDS = 1_000;

/**
 * A live run's waits. What they take is the merge of `in.jsonl`'s events, the turns' ends and the
 * timers due; what they took, and the timers and turns the code began, are the attempt's own lines
 * in `run.jsonl`, written through its writer. Parking holds the run's lock, which every sender
 * appends to `in.jsonl` under; a nudge, or the poll when one is lost, makes a waiting `receive`
 * read again.
 */
export class RunWaits {
  #first = true;
  readonly #parked = Promise.withResolvers<never>();
  /** Set once the run parked: its ending is `parked` whatever the code does after. */
  parked: RunParked | undefined;
  /** Rejects with the park, for the runner to race the workflow's body against. */
  readonly whenParked: Promise<never> = this.#parked.promise;

  /** One resolver per wait idle now: a nudge wakes every one, parallel branches' included. */
  readonly #wakes = new Set<() => void>();
  /** This attempt's turns begun, and those whose end is written: only this attempt writes either. */
  readonly #begun = new Set<string>();
  readonly #ended = new Set<string>();

  constructor(
    private readonly options: {
      runDir: string;
      /** The attempt's writer on `run.jsonl`. */
      lines: RunLines;
      /** Runs `work` holding the run's lock. */
      locked<T>(work: () => Promise<T>): Promise<T>;
      /** Absent, the run never parks: it waits in its process. */
      parking?: Parking;
      now?: () => number;
    },
  ) {
    // A run nobody races, such as a test's, leaves no rejection unhandled.
    this.#parked.promise.catch(() => undefined);
  }

  #now(): number {
    return this.options.now?.() ?? Date.now();
  }

  #at(): string {
    return new Date(this.#now()).toISOString();
  }

  get #attempt(): number {
    return this.options.lines.attempt;
  }

  #state(): Promise<WaitState> {
    return readWaits(this.options.runDir, this.#now());
  }

  /** Appends one of this attempt's lines. */
  #append(line: RunLine): Promise<void> {
    return this.options.lines.append(line);
  }

  /**
   * Records a turn `start()` begins, before its agent is launched. A turn id this attempt began
   * already is refused: its end is kept once, so a second turn under it would never end.
   */
  async beginTurn(
    agent: string,
    turn: string,
    meta: JsonValue,
    execution: AgentExecution,
  ): Promise<void> {
    const key = JSON.stringify([agent, turn]);
    if (this.#begun.has(key))
      throw new Error(
        `agent ${agent} began turn ${turn} already in this attempt; an id names one turn`,
      );
    this.#begun.add(key);
    await this.#append({
      kind: "turn-started",
      attempt: this.#attempt,
      at: this.#at(),
      agent,
      turn,
      meta,
      execution,
    });
  }

  /** Writes a turn's end once; then this run's wait reads again. */
  async endTurn(agent: string, end: TurnEnd): Promise<void> {
    const id = endIdOf(agent, end.turn, this.#attempt);
    if (!this.#ended.has(id)) {
      this.#ended.add(id);
      await this.#append({
        kind: "turn-ended",
        attempt: this.#attempt,
        at: this.#at(),
        id,
        agent,
        turn: end.turn,
        began: this.#attempt,
        end,
      });
    }
    this.nudge();
  }

  /** A new event was appended: a waiting `receive` reads again. */
  nudge(): void {
    for (const wake of this.#wakes) wake();
  }

  /** The events of the batch a wait in `stage` took; undefined when none did. */
  async batchOf(stage: string): Promise<WorkflowEvent<string, JsonValue>[] | undefined> {
    const state = await this.#state();
    const ids = state.batches.get(stage);
    return ids && this.#events(state, ids);
  }

  /**
   * The run's timers as set, for `setTimer` and `cancelTimer` to answer at once; whether one fired
   * is the lines' to say.
   */
  readonly #timers = new Map<string, TimerState>();
  /** Timer lines not yet written: each wait, and `flush`, waits for them. */
  #writes: Promise<void> = Promise.resolve();

  /** Each agent's turn an earlier attempt started whose end no wait took, once `open` has read it. */
  restored: ReadonlyMap<string, RestoredTurn> = new Map();

  /** Reads what earlier attempts left: once, before the code runs. */
  async open(): Promise<void> {
    const state = await this.#state();
    for (const timer of state.timers.values()) this.#timers.set(timer.name, { ...timer });
    if (state.started) this.started = eventOf(state.started);
    this.restored = restoredTurns(state);
  }

  /** The event that created the run, once `open` has read it. */
  started: WorkflowEvent<string, JsonValue> | undefined;

  /**
   * Timer `name`: the one recorded, or one set now, due at `due`, epoch ms, from `when` as the code
   * gave it. `asked` is a `when` that differs from the recorded one, which is kept. Its line is
   * written before the next wait.
   */
  setTimer(name: string, due: number, when: string): { timer: TimerState; asked?: string } {
    const known = this.#timers.get(name);
    if (known) return known.when === when ? { timer: known } : { timer: known, asked: when };
    const timer: TimerState = {
      name,
      due: new Date(due).toISOString(),
      when,
      cancelled: false,
      taken: false,
      fired: false,
    };
    this.#timers.set(name, timer);
    this.#queue({
      kind: "timer",
      attempt: this.#attempt,
      at: this.#at(),
      name,
      due: timer.due,
      when,
    });
    return { timer };
  }

  /** Cancels timer `name`: it won't fire, and if it is due and not taken, it is withdrawn. */
  async cancelTimer(name: string): Promise<void> {
    const timer = this.#timers.get(name);
    if (timer && !timer.cancelled) {
      timer.cancelled = true;
      this.#queue(this.#cancelled(timer));
    }
    await this.flush();
  }

  /** A timer's line again, cancelled. */
  #cancelled(timer: TimerState): RunLine {
    return {
      kind: "timer",
      attempt: this.#attempt,
      at: this.#at(),
      name: timer.name,
      due: timer.due,
      when: timer.when,
      cancelled: true,
    };
  }

  #queue(line: RunLine): void {
    const written = this.#writes.then(() => this.#append(line));
    // Its failure is the next wait's, which awaits it.
    written.catch(() => undefined);
    this.#writes = written;
  }

  /** Writes the timer lines set and not yet written. */
  async flush(): Promise<void> {
    await this.#writes;
  }

  /**
   * Acknowledges what the last call returned, then takes the events not yet acknowledged, waiting
   * for one when there is none. The attempt's first call, outside a stage, returns a batch an earlier
   * attempt took and never acknowledged, alone, and writes nothing. In a stage that has taken its
   * batch, as one that failed or died before its line did has, it returns that batch and writes
   * nothing.
   */
  async receive(
    label: string | undefined,
    stage?: string,
    /** Rejects the wait: the run ended, or the scope it waits in was cancelled. */
    signal?: AbortSignal,
  ): Promise<WorkflowEvent<string, JsonValue>[]> {
    if (stage !== undefined) {
      const batch = await this.batchOf(stage);
      if (batch) return batch;
    } else if (this.#first) {
      this.#first = false;
      const state = await this.#state();
      const held = firstReceive(state);
      if (held) return this.#events(state, held);
    }
    return this.#wait(
      {
        ...(label === undefined ? {} : { label }),
        take: "all",
        ...(stage === undefined ? {} : { stage }),
      },
      signal,
    );
  }

  /**
   * As `receive`, taking the oldest event `takes` names, alone: a select's next. After a crash, the
   * attempt's first call returns the one an earlier attempt took and never acknowledged.
   */
  async select(
    takes: readonly WaitTake[] | (() => readonly WaitTake[]),
    label: string | undefined,
    signal?: AbortSignal,
  ): Promise<WorkflowEvent<string, JsonValue>> {
    const read = typeof takes === "function" ? takes : undefined;
    const first = read ? read() : (takes as readonly WaitTake[]);
    let returns = false;
    if (this.#first) {
      this.#first = false;
      const held = firstSelect(await this.#state(), first);
      if ("event" in held) return eventOf(held.event);
      returns = held.returns;
    }
    const [event] = await this.#wait(
      {
        ...(label === undefined ? {} : { label }),
        take: "oldest",
        takes: [...first],
        ...(read ? { read } : {}),
        ...(returns ? { returns } : {}),
      },
      signal,
    );
    return event as WorkflowEvent<string, JsonValue>;
  }

  /**
   * Race `name`: what it took, recorded, or the first event its branches take, under the first
   * branch that takes it. Its own timers, by branch, are cancelled with the win when another branch
   * wins. It acknowledges nothing else, so a loop's batch stays held.
   */
  async race(
    name: string,
    branches: readonly (readonly [string, WaitTake])[],
    owned: ReadonlyMap<string, string>,
    label: string | undefined,
    signal?: AbortSignal,
  ): Promise<{ branch: string; event: WorkflowEvent<string, JsonValue> }> {
    await this.flush();
    const state = await this.#state();
    const won = state.races.get(name);
    const recorded = won && state.events.get(won.ids[0] as string);
    if (won && recorded) {
      // A crash between its win and its cancels left a loser to cancel now.
      for (const [branch, timer] of owned)
        if (branch !== won.branch && !state.timers.get(timer)?.cancelled)
          await this.cancelTimer(timer);
      return { branch: won.branch, event: eventOf(recorded) };
    }
    const [event] = await this.#wait(
      {
        ...(label === undefined ? {} : { label }),
        take: "oldest",
        takes: branches.map(([, take]) => take),
        race: { name, branches, owned },
      },
      signal,
    );
    const taken = event as WorkflowEvent<string, JsonValue>;
    return { branch: branchOf(branches, taken) as string, event: taken };
  }

  async #wait(
    spec: {
      label?: string;
      take: "all" | "oldest";
      takes?: WaitTake[];
      /** Reads the takes again at each pass: a select's times read from state. */
      read?: () => readonly WaitTake[];
      returns?: boolean;
      stage?: string;
      race?: {
        name: string;
        branches: readonly (readonly [string, WaitTake])[];
        owned: ReadonlyMap<string, string>;
      };
    },
    signal: AbortSignal | undefined,
  ): Promise<WorkflowEvent<string, JsonValue>[]> {
    const { label, take, read, returns, stage, race } = spec;
    let { takes } = spec;
    const { runDir } = this.options;
    await this.flush();
    // Outside a stage and a race, the wait acknowledges the held batch, unless it hands it back.
    const loop = stage === undefined && race === undefined;
    /** The wait's line: the first carries what it acknowledges, or `returns`; one rewritten neither. */
    const waitLine = (first: { acks?: string[] } | undefined): RunLine => ({
      kind: "wait",
      attempt: this.#attempt,
      at: this.#at(),
      ...(label === undefined ? {} : { label }),
      ...(takes === undefined ? {} : { takes }),
      ...(stage === undefined ? {} : { stage }),
      ...(race === undefined ? {} : { race: race.name }),
      ...(first?.acks ? { acks: first.acks } : {}),
      ...(first && returns ? { returns: true as const } : {}),
    });
    // What it acknowledges is read and written in one step, ordered with every took this attempt
    // writes: a wait beside it, in a parallel branch, can't hold a batch in between.
    await this.#serial(async () => {
      const acks = loop && !returns ? acksOf(await this.#state()) : undefined;
      await this.#append(waitLine(acks ? { acks } : {}));
    });
    /**
     * Takes what is ready now, read again on the chain every take is written on: a wait beside it,
     * in a parallel branch, can't have taken the same event in between. Undefined with none.
     */
    const took = (): Promise<WaitEvent[] | undefined> =>
      this.#serial(async () => {
        const state = await this.#state();
        const ready = readyFor(state, takes);
        if (ready.length === 0) return undefined;
        const ids = take === "oldest" ? ready.slice(0, 1) : ready;
        const events = ids.map((id) => state.events.get(id) as WaitEvent);
        await this.#took(events, stage, race);
        return events;
      });
    for (;;) {
      signal?.throwIfAborted();
      if (read) {
        // A time moved while it waited, by an agent's onTimeout or a parallel branch: a parked
        // run's `until`, and its wake, read the last wait line.
        const fresh = [...read()];
        if (JSON.stringify(fresh) !== JSON.stringify(takes)) {
          takes = fresh;
          await this.#append(waitLine(undefined));
        }
      }
      // Armed before reading, so a nudge between the read and the wait is not lost.
      let wake: () => void = () => undefined;
      const woken = new Promise<void>((resolve) => {
        wake = resolve;
      });
      this.#wakes.add(wake);
      try {
        // Before the read too: what is appended after the read changes it, nudged or not.
        const size = await sizeOf(runDir);
        const state = await this.#state();
        if (readyFor(state, takes).length > 0) {
          const events = await took();
          if (events) return events.map(eventOf);
          continue;
        }
        const time = pendingTimes(state, takes)[0];
        if (time && Date.parse(time.due) <= this.#now()) {
          const taken = await this.#takeTime(time, takes, read);
          if (taken) return [eventOf(taken)];
          continue;
        }
        const next = nextTimer(state, takes);
        if (next !== undefined && next <= this.#now()) continue;
        const { parking } = this.options;
        const idle = parking?.idle(stage) ?? false;
        // Before the handlers, on the same clock: a window that passes between the two is due by the
        // time `timeout` looks, never parked past.
        const live = parking && idle ? parking.liveUntil() : undefined;
        // Read again after a handler: what arrived meanwhile is taken first.
        if (parking && idle && (await parking.timeout(signal))) continue;
        if (parking && live !== undefined) await parking.live?.(live);
        else if (parking && idle) {
          if (next !== undefined && (await parking.skip?.(next))) continue;
          const wait: WaitingJson = {
            ...(label === undefined ? {} : { label }),
            ...(next === undefined ? {} : { until: new Date(next).toISOString() }),
          };
          // Checked once more under the lock, which every sender appends under: an event sent now is
          // either seen here, or sent after `parked` is written and continues the run.
          const parked = await this.options.locked(async () => {
            const now = this.#now();
            if (hasWork(await readWaits(runDir, now), takes)) return false;
            await parking.park(wait);
            return true;
          });
          if (parked) {
            this.parked = new RunParked(wait);
            this.#parked.reject(this.parked);
            throw this.parked;
          }
          continue;
        }
        // Only a nudge, the size poll or the next timer wakes it, or, with a turn running, its end,
        // which may let the run park: looked at each second. In a window, its end.
        const longest =
          parking && !idle
            ? POLL_MILLISECONDS
            : live !== undefined
              ? live - this.#now()
              : Number.POSITIVE_INFINITY;
        await this.#idle(
          woken,
          size,
          Math.min(longest, next === undefined ? longest : next - this.#now()),
          signal,
        );
      } finally {
        this.#wakes.delete(wake);
      }
    }
  }

  /** The wait lines and takes this attempt writes, one at a time. */
  #serialized: Promise<void> = Promise.resolve();

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const done = this.#serialized.then(work);
    this.#serialized = done.then(
      () => undefined,
      () => undefined,
    );
    return done;
  }

  /** Writes what a wait took: a `took`, in its stage if it is in one, or a race's win and its cancels. */
  async #took(
    events: readonly WaitEvent[],
    stage: string | undefined,
    race:
      | {
          name: string;
          branches: readonly (readonly [string, WaitTake])[];
          owned: ReadonlyMap<string, string>;
        }
      | undefined,
  ): Promise<void> {
    const entries = events.map(takenOf);
    const at = this.#at();
    if (!race) {
      await this.#append({
        kind: "took",
        attempt: this.#attempt,
        at,
        took: entries,
        ...(stage === undefined ? {} : { stage }),
      });
      return;
    }
    const branch = branchOf(race.branches, events[0] as WaitEvent) as string;
    await this.#append({
      kind: "race",
      attempt: this.#attempt,
      at,
      name: race.name,
      branch,
      took: entries,
    });
    // A crash before these leaves them to the rerun, which answers from the win and cancels them.
    for (const [owner, timer] of race.owned) {
      const known = this.#timers.get(timer);
      if (owner === branch || !known || known.cancelled) continue;
      known.cancelled = true;
      await this.#append(this.#cancelled(known));
    }
  }

  /**
   * A select's time read from state, due with no event ready: taken, its `took` naming its branch and
   * time. Undefined when it moved meanwhile, or an event came, which goes first.
   */
  async #takeTime(
    time: { branch: string; due: string },
    takes: readonly WaitTake[] | undefined,
    read: (() => readonly WaitTake[]) | undefined,
  ): Promise<WaitEvent | undefined> {
    // Read again on the takes' chain: a wait beside it may have taken it, or an event come.
    return this.#serial(async () => {
      const again = await readWaits(this.options.runDir, this.#now());
      // Code beside the wait may have moved it while the lines were read.
      if (read && !read().some((take) => take.from === time.branch && take.due === time.due))
        return undefined;
      const id = DERIVED_IDS.at(time.branch, time.due);
      if (again.events.has(id) || readyFor(again, takes).length > 0) return undefined;
      const event: WaitEvent = {
        id,
        name: "at:due",
        data: {},
        from: time.branch,
        at: time.due,
        origin: "time",
      };
      await this.#took([event], undefined, undefined);
      return event;
    });
  }

  async #idle(
    woken: Promise<void>,
    size: number,
    ms: number,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      await Promise.race([
        woken,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, Math.max(0, Math.min(ms, 2 ** 31 - 1)));
        }),
        new Promise<void>((resolve) => {
          poll = setInterval(() => {
            void sizeOf(this.options.runDir).then((now) => {
              if (now !== size) resolve();
            });
          }, POLL_MILLISECONDS);
        }),
        new Promise<void>((_, reject) => {
          if (!signal) return;
          onAbort = () => reject(signal.reason);
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
    } finally {
      clearTimeout(timer);
      clearInterval(poll);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
  }

  #events(state: WaitState, ids: readonly string[]): WorkflowEvent<string, JsonValue>[] {
    return ids.flatMap((id) => {
      const event = state.events.get(id);
      return event ? [eventOf(event)] : [];
    });
  }
}
