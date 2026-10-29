import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  MAILBOX_RECORD_VERSION,
  type MailboxRecord,
  type WaitingJson,
  type WaitTake,
} from "@agentswf/contract/records";
import {
  type AgentExecution,
  AWF_ID_PREFIX,
  type JsonValue,
  type OperationRecord,
  type ReceiveOptions,
  type TurnOutcome,
  type WorkflowEvent,
} from "@agentswf/contract/workflow";
import { appendLine, endTornLine, readLines } from "./jsonl";
import { matches, wouldTake } from "./sources";

/** `mailbox.jsonl`: a run's events, and what its waits did with them. */
export function mailboxFile(runDir: string): string {
  return join(runDir, "mailbox.jsonl");
}

/** The run's mailbox in the order written, less a line a crash tore and kinds this awf doesn't know. */
export async function readMailbox(runDir: string): Promise<MailboxRecord[]> {
  const lines = await readLines<MailboxRecord>(mailboxFile(runDir));
  return lines.filter((line) => line.version === MAILBOX_RECORD_VERSION && KINDS.has(line.kind));
}

const KINDS = new Set<string>([
  "event",
  "wait",
  "took",
  "turn",
  "launch-failed",
  "timer",
  "timer-cancelled",
]);

/** Appends a record; the caller holds the run's lock. */
export async function appendMailbox(runDir: string, record: MailboxRecord): Promise<void> {
  await endTornLine(mailboxFile(runDir));
  await appendLine(mailboxFile(runDir), JSON.stringify(record));
}

type EventRecord = Extract<MailboxRecord, { kind: "event" }>;
type TurnRecord = Extract<MailboxRecord, { kind: "turn" }>;

type WaitRecord = Extract<MailboxRecord, { kind: "wait" }>;

/** The id of timer `name`'s `timer:due`: made from its name, so it fires once. */
export function timerEventId(name: string): string {
  const hash = new Bun.CryptoHasher("sha256").update(name).digest("hex");
  return `${AWF_ID_PREFIX}timer.${hash.slice(0, 16)}`;
}

/**
 * The id of the end of `agent`'s turn `turn`: made from both, so it fits the grammar whatever
 * either is, and is the same whoever writes it, so only one end is ever kept.
 */
export function endIdOf(agent: string, turn: string, attempt: number): string {
  const hash = new Bun.CryptoHasher("sha256").update(`${agent}\0${turn}\0${attempt}`).digest("hex");
  return `${AWF_ID_PREFIX}end.${hash.slice(0, 16)}`;
}

/** An agent's turn an earlier attempt started whose end no wait took: its id and meta. */
export type RestoredTurn = { turn: string; meta: JsonValue };

/** What `agent:ended` says of a turn: its id and meta, as `start()` was given them, and its outcome. */
export type TurnEnd = { turn: string; meta: JsonValue; outcome: TurnOutcome<JsonValue> };

/** The usage of a turn no delivery settled: one refused, cancelled while queued, or cut off by a crash. */
export function unrunUsage(
  agent: string,
  operationId: string,
  execution: AgentExecution,
): OperationRecord {
  return { callPath: [], agent, operationId, execution, sessions: [] };
}

/**
 * Appends a turn's end, `agent:ended` from its agent, once: an end already there is kept. The
 * caller holds the run's lock.
 */
async function appendEnd(
  runDir: string,
  agent: string,
  attempt: number,
  end: TurnEnd,
  at: string,
): Promise<void> {
  const id = endIdOf(agent, end.turn, attempt);
  if (foldMailbox(await readMailbox(runDir)).events.has(id)) return;
  await appendMailbox(runDir, {
    version: MAILBOX_RECORD_VERSION,
    at,
    kind: "event",
    id,
    name: "agent:ended",
    data: end as unknown as JsonValue,
    from: agent,
  });
}

/**
 * Writes a failed end for each turn the mailbox has with no end, whose attempt is over, and returns
 * each agent's last turn whose end no wait took: what `agent.turn` is when the agent opens.
 */
export async function recoverTurns(
  runDir: string,
  attempt: number,
  locked: <T>(work: () => Promise<T>) => Promise<T>,
): Promise<Map<string, RestoredTurn>> {
  await locked(async () => {
    for (const turn of foldMailbox(await readMailbox(runDir)).turns) {
      if (turn.attempt >= attempt) continue;
      await appendEnd(
        runDir,
        turn.agent,
        turn.attempt,
        {
          turn: turn.turn,
          meta: turn.meta,
          outcome: {
            kind: "failed",
            reason: `attempt ${turn.attempt} ended before this turn did; its work, if any, is in the agent's session`,
            retryable: true,
            usage: unrunUsage(turn.agent, turn.turn, turn.execution),
          },
        },
        new Date().toISOString(),
      );
    }
  });
  const state = foldMailbox(await readMailbox(runDir));
  const untaken = new Set([...state.unacknowledged, ...(state.held ?? [])]);
  const restored = new Map<string, RestoredTurn>();
  for (const turn of state.turns)
    if (untaken.has(endIdOf(turn.agent, turn.turn, turn.attempt)))
      restored.set(turn.agent, { turn: turn.turn, meta: turn.meta });
  return restored;
}

/** What a run's mailbox says, folded from its records in order. */
export type MailboxState = {
  /** Every event by id, the first appended under an id being the one kept. */
  events: ReadonlyMap<string, EventRecord>;
  /** Event ids no wait has acknowledged and none has taken, in arrival order. */
  unacknowledged: string[];
  /**
   * What the last wait outside a stage took that no later wait outside one acknowledged: a crash's
   * batch, returned again.
   */
  held?: string[];
  /** The last wait called, and whether it is still waiting: no `took` after it. */
  lastWait?: WaitRecord & { waiting: boolean };
  /** Each stage's batch, as a wait in it took it. */
  batches: ReadonlyMap<string, string[]>;
  /** Every turn `start()` began, in order. */
  turns: readonly TurnRecord[];
  /** Every timer by name, as first set. */
  timers: ReadonlyMap<string, TimerState>;
  /** What each race took, by its name: the branch that won and the event. */
  races: ReadonlyMap<string, { branch: string; ids: string[] }>;
  /** The event that created the run. */
  started?: EventRecord;
};

/** A timer as the mailbox has it: when it is due, an ISO time, and what became of it. */
export type TimerState = {
  name: string;
  due: string;
  /** As the code gave it: a duration, or an ISO time. */
  when: string;
  cancelled: boolean;
  /** Its `timer:due` is in the mailbox. */
  fired: boolean;
};

/**
 * Folds a mailbox. A `wait` outside a stage and a race acknowledges what the last `took` outside one
 * returned; a `took` in a stage or a race acknowledges its own, which the stage or race holds. A
 * cancelled timer's `timer:due` counts as acknowledged. Events not acknowledged are in order of `at`,
 * so a timer that fired late takes its place at its due time.
 */
export function foldMailbox(records: readonly MailboxRecord[]): MailboxState {
  const events = new Map<string, EventRecord>();
  const order: string[] = [];
  const acknowledged = new Set<string>();
  const batches = new Map<string, string[]>();
  const races = new Map<string, { branch: string; ids: string[] }>();
  const timers = new Map<string, TimerState>();
  let held: string[] | undefined;
  let lastWait: (WaitRecord & { waiting: boolean }) | undefined;
  const turns: TurnRecord[] = [];
  for (const record of records) {
    switch (record.kind) {
      case "event":
        if (!events.has(record.id)) {
          events.set(record.id, record);
          order.push(record.id);
        }
        break;
      case "wait":
        // A wait in a stage or a race leaves the loop's batch to the loop.
        if (record.stage === undefined && record.race === undefined) {
          for (const id of held ?? []) acknowledged.add(id);
          held = undefined;
        }
        lastWait = { ...record, waiting: true };
        break;
      case "took":
        if (lastWait) lastWait.waiting = false;
        if (record.race !== undefined) {
          for (const id of record.ids) acknowledged.add(id);
          if (!races.has(record.race))
            races.set(record.race, { branch: record.branch ?? "", ids: record.ids });
        } else if (record.stage !== undefined) {
          for (const id of record.ids) acknowledged.add(id);
          batches.set(record.stage, record.ids);
        } else held = record.ids.length > 0 ? record.ids : undefined;
        break;
      case "turn":
        turns.push(record);
        break;
      case "timer":
        if (!timers.has(record.name))
          timers.set(record.name, {
            name: record.name,
            due: record.due,
            when: record.when,
            cancelled: false,
            fired: false,
          });
        break;
      case "timer-cancelled": {
        const timer = timers.get(record.name);
        if (timer) timer.cancelled = true;
        acknowledged.add(timerEventId(record.name));
        break;
      }
    }
  }
  for (const timer of timers.values()) timer.fired = events.has(timerEventId(timer.name));
  const started = [...events.values()].find((event) => event.starts);
  const taken = new Set(held);
  const at = (id: string) => Date.parse(events.get(id)?.at ?? "");
  return {
    events,
    unacknowledged: order
      .filter((id) => !acknowledged.has(id) && !taken.has(id))
      .sort((a, b) => at(a) - at(b)),
    ...(held ? { held } : {}),
    ...(lastWait ? { lastWait } : {}),
    batches,
    turns,
    timers,
    races,
    ...(started ? { started } : {}),
  };
}

/** The events not acknowledged that a wait taking `takes` would take, in order. */
export function readyFor(state: MailboxState, takes: readonly WaitTake[] | undefined): string[] {
  return state.unacknowledged.filter((id) => {
    const event = state.events.get(id);
    return event !== undefined && wouldTake(event, takes);
  });
}

/** A timer's `timer:due`, as a wait would test it. */
function dueEventOf(timer: TimerState): { name: string; from: string } {
  return { name: "timer:due", from: timer.name };
}

/** Timers neither fired nor cancelled, earliest first. */
function pendingTimers(state: MailboxState): TimerState[] {
  return [...state.timers.values()]
    .filter((timer) => !timer.fired && !timer.cancelled)
    .sort((a, b) => Date.parse(a.due) - Date.parse(b.due));
}

/** When the earliest timer a wait taking `takes` would take is due, epoch ms; undefined with none. */
export function nextTimer(
  state: MailboxState,
  takes: readonly WaitTake[] | undefined,
): number | undefined {
  const timer = pendingTimers(state).find((each) => wouldTake(dueEventOf(each), takes));
  return timer && Date.parse(timer.due);
}

/**
 * Whether a wait taking `takes` has something to take at `now`: an event, or a timer due. The one
 * test for taking, parking, and waking a parked run.
 */
export function hasWork(
  state: MailboxState,
  takes: readonly WaitTake[] | undefined,
  now: number,
): boolean {
  if (readyFor(state, takes).length > 0) return true;
  const due = nextTimer(state, takes);
  return due !== undefined && due <= now;
}

/** The `timer:due` records of the timers due at `now` and not fired, to append. */
export function dueRecords(state: MailboxState, now: number): MailboxRecord[] {
  return pendingTimers(state)
    .filter((timer) => Date.parse(timer.due) <= now)
    .map((timer) => ({
      version: MAILBOX_RECORD_VERSION,
      at: timer.due,
      kind: "event",
      id: timerEventId(timer.name),
      name: "timer:due",
      data: { name: timer.name },
      from: timer.name,
    }));
}

/** An event as a wait returns it. */
function eventOf(record: EventRecord): WorkflowEvent<string, JsonValue> {
  return Object.freeze({
    id: record.id,
    name: record.name,
    data: record.data,
    from: record.from,
    at: record.at,
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
};

/** How often a wait looks at its mailbox when no nudge comes: a nudge that failed still arrives. */
const POLL_MILLISECONDS = 1_000;

/**
 * A live run's waits on its mailbox. Every append is made inside `locked`, which holds the run's
 * lock, as anything that decides from the mailbox and then writes must be; a nudge, or the poll
 * when one is lost, makes a waiting `receive` read the mailbox again.
 */
export class RunMailbox {
  #first = true;
  readonly #parked = Promise.withResolvers<never>();
  /** Set once the run parked: its ending is `parked` whatever the code does after. */
  parked: RunParked | undefined;
  /** Rejects with the park, for the runner to race the workflow's body against. */
  readonly whenParked: Promise<never> = this.#parked.promise;

  #wake: (() => void) | undefined;

  constructor(
    private readonly options: {
      runDir: string;
      attempt: number;
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

  async #append(record: MailboxRecord): Promise<void> {
    await this.options.locked(() => appendMailbox(this.options.runDir, record));
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
    const { attempt, runDir } = this.options;
    await this.options.locked(async () => {
      const begun = foldMailbox(await readMailbox(runDir)).turns.some(
        (each) => each.agent === agent && each.turn === turn && each.attempt === attempt,
      );
      if (begun)
        throw new Error(
          `agent ${agent} began turn ${turn} already in this attempt; an id names one turn`,
        );
      await appendMailbox(runDir, {
        version: MAILBOX_RECORD_VERSION,
        at: this.#at(),
        kind: "turn",
        attempt,
        agent,
        turn,
        meta,
        execution,
      });
    });
  }

  /**
   * Appends a turn's end, `agent:ended` from its agent, once: an end already there, as a crash's
   * recovery may have written, is kept. Then this run's wait reads the mailbox again.
   */
  async endTurn(agent: string, end: TurnEnd): Promise<void> {
    const { runDir, attempt } = this.options;
    await this.options.locked(() => appendEnd(runDir, agent, attempt, end, this.#at()));
    this.nudge();
  }

  /** A new event was appended: a waiting `receive` reads the mailbox again. */
  nudge(): void {
    this.#wake?.();
  }

  /** The events of the batch a wait in `stage` took; undefined when none did. */
  async batchOf(stage: string): Promise<WorkflowEvent<string, JsonValue>[] | undefined> {
    const state = foldMailbox(await readMailbox(this.options.runDir));
    const ids = state.batches.get(stage);
    return ids && this.#events(state, ids);
  }

  /** The run's timers, as the mailbox had them when the attempt began and as set since. */
  readonly #timers = new Map<string, TimerState>();
  /** Timer records not yet written: each wait, and `flush`, waits for them. */
  #writes: Promise<void> = Promise.resolve();

  /** Reads the timers an earlier attempt set: once, before the code runs. */
  async open(): Promise<void> {
    const state = foldMailbox(await readMailbox(this.options.runDir));
    for (const timer of state.timers.values()) this.#timers.set(timer.name, { ...timer });
    if (state.started) this.started = eventOf(state.started);
  }

  /** The event that created the run, once `open` has read it. */
  started: WorkflowEvent<string, JsonValue> | undefined;

  /** The run's timers by name. */
  timers(): ReadonlyMap<string, TimerState> {
    return this.#timers;
  }

  /**
   * Timer `name`: the one recorded, or one set now, due at `due`, epoch ms, from `when` as the code
   * gave it. `asked` is a `when` that differs from the recorded one, which is kept. Its record is
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
      fired: false,
    };
    this.#timers.set(name, timer);
    this.#queue({
      version: MAILBOX_RECORD_VERSION,
      at: this.#at(),
      kind: "timer",
      attempt: this.options.attempt,
      name,
      due: timer.due,
      when,
    });
    return { timer };
  }

  /** Cancels timer `name`: it won't fire, and its `timer:due` not taken is withdrawn. */
  async cancelTimer(name: string): Promise<void> {
    const timer = this.#timers.get(name);
    if (timer && !timer.cancelled) {
      timer.cancelled = true;
      this.#queue(this.#cancelled(name));
    }
    await this.flush();
  }

  #cancelled(name: string): MailboxRecord {
    return {
      version: MAILBOX_RECORD_VERSION,
      at: this.#at(),
      kind: "timer-cancelled",
      attempt: this.options.attempt,
      name,
    };
  }

  #queue(record: MailboxRecord): void {
    const written = this.#writes.then(() => this.#append(record));
    // Its failure is the next wait's, which awaits it.
    written.catch(() => undefined);
    this.#writes = written;
  }

  /** Writes the timer records set and not yet written. */
  async flush(): Promise<void> {
    await this.#writes;
  }

  /**
   * Acknowledges what the last call returned, then takes the events not yet acknowledged, waiting
   * for one when there is none. The attempt's first call, outside a stage, returns a batch an earlier
   * attempt took and never acknowledged, alone, and writes nothing. In a stage that has taken its
   * batch, as one that failed or died before its record did has, it returns that batch and writes
   * nothing.
   */
  async receive(
    options: ReceiveOptions | undefined,
    stage?: string,
    /** Rejects the wait: the run ended, or the scope it waits in was cancelled. */
    signal?: AbortSignal,
  ): Promise<WorkflowEvent<string, JsonValue>[]> {
    const { label, take } = checked(options);
    if (stage !== undefined) {
      const batch = await this.batchOf(stage);
      if (batch) return batch;
    } else if (this.#first) {
      this.#first = false;
      const state = foldMailbox(await readMailbox(this.options.runDir));
      if (state.held) return this.#events(state, state.held);
    }
    return this.#wait(
      {
        ...(label === undefined ? {} : { label }),
        take,
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
    takes: readonly WaitTake[],
    label: string | undefined,
    signal?: AbortSignal,
  ): Promise<WorkflowEvent<string, JsonValue>> {
    if (this.#first) {
      this.#first = false;
      const state = foldMailbox(await readMailbox(this.options.runDir));
      const held = state.held?.length === 1 ? state.events.get(state.held[0] as string) : undefined;
      if (held && wouldTake(held, takes)) return eventOf(held);
    }
    const [event] = await this.#wait(
      { ...(label === undefined ? {} : { label }), take: "oldest", takes: [...takes] },
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
    const state = foldMailbox(await readMailbox(this.options.runDir));
    const won = state.races.get(name);
    const recorded = won && state.events.get(won.ids[0] as string);
    if (won && recorded) return { branch: won.branch, event: eventOf(recorded) };
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
      stage?: string;
      race?: {
        name: string;
        branches: readonly (readonly [string, WaitTake])[];
        owned: ReadonlyMap<string, string>;
      };
    },
    signal: AbortSignal | undefined,
  ): Promise<WorkflowEvent<string, JsonValue>[]> {
    const { label, take, takes, stage, race } = spec;
    const { attempt, runDir } = this.options;
    await this.flush();
    await this.#append({
      version: MAILBOX_RECORD_VERSION,
      at: this.#at(),
      kind: "wait",
      attempt,
      ...(label === undefined ? {} : { label }),
      ...(stage === undefined ? {} : { stage }),
      ...(race === undefined ? {} : { race: race.name }),
      ...(takes === undefined ? {} : { takes }),
    });
    const took = (events: EventRecord[]) =>
      this.options.locked(async () => {
        const branch = race && branchOf(race.branches, events[0] as EventRecord);
        await appendMailbox(runDir, {
          version: MAILBOX_RECORD_VERSION,
          at: this.#at(),
          kind: "took",
          attempt,
          ids: events.map((event) => event.id),
          ...(stage === undefined ? {} : { stage }),
          ...(race === undefined ? {} : { race: race.name }),
          ...(branch === undefined ? {} : { branch }),
        });
        // In the same hold as the win: a crash between can't leave a loser's timer to fire.
        for (const [owner, timer] of race?.owned ?? []) {
          const known = this.#timers.get(timer);
          if (owner === branch || known?.cancelled) continue;
          if (known) known.cancelled = true;
          await appendMailbox(runDir, this.#cancelled(timer));
        }
      });
    for (;;) {
      signal?.throwIfAborted();
      // Armed before reading, so a nudge between the read and the wait is not lost.
      const woken = new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
      // Before the read too: what is appended after the read changes it, nudged or not.
      const size = await mailboxSize(runDir);
      const state = await this.#fired();
      const ready = readyFor(state, takes);
      if (ready.length > 0) {
        const ids = take === "oldest" ? ready.slice(0, 1) : ready;
        const events = ids.map((id) => state.events.get(id) as EventRecord);
        await took(events);
        return events.map(eventOf);
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
        const wait: WaitingJson = {
          ...(label === undefined ? {} : { label }),
          ...(next === undefined ? {} : { until: new Date(next).toISOString() }),
        };
        // Checked once more under the lock, which every sender appends under: an event sent now is
        // either seen here, or sent after `parked` is written and continues the run.
        const parked = await this.options.locked(async () => {
          const again = foldMailbox(await readMailbox(runDir));
          if (hasWork(again, takes, this.#now())) return false;
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
    }
  }

  /** The mailbox, with every timer due by now fired into it. */
  async #fired(): Promise<MailboxState> {
    const { runDir } = this.options;
    const state = foldMailbox(await readMailbox(runDir));
    if (dueRecords(state, this.#now()).length === 0) return state;
    return this.options.locked(async () => {
      const again = foldMailbox(await readMailbox(runDir));
      const due = dueRecords(again, this.#now());
      for (const record of due) await appendMailbox(runDir, record);
      for (const record of due)
        if (record.kind === "event") {
          const timer = this.#timers.get(record.from);
          if (timer) timer.fired = true;
        }
      return foldMailbox(await readMailbox(runDir));
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
            void mailboxSize(this.options.runDir).then((now) => {
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
      this.#wake = undefined;
    }
  }

  #events(state: MailboxState, ids: readonly string[]): WorkflowEvent<string, JsonValue>[] {
    return ids.flatMap((id) => {
      const record = state.events.get(id);
      return record ? [eventOf(record)] : [];
    });
  }
}

async function mailboxSize(runDir: string): Promise<number> {
  return stat(mailboxFile(runDir)).then(
    (stats) => stats.size,
    () => 0,
  );
}

/** A wait's options as given, checked: what a typed caller can't get wrong, a plain one can. */
function checked(options: ReceiveOptions | undefined): {
  label?: string;
  take: "all" | "oldest";
} {
  if (options !== undefined && (typeof options !== "object" || options === null))
    throw new Error("receive takes { label?, take? }");
  const { label, take = "all" } = options ?? {};
  if (label !== undefined && typeof label !== "string")
    throw new Error("receive's label is a string");
  if (take !== "all" && take !== "oldest") throw new Error('receive\'s take is "all" or "oldest"');
  if ("until" in (options ?? {}))
    throw new Error("receive has no until: a timer, workflow.timer(name, when), wakes it");
  return { ...(label === undefined ? {} : { label }), take };
}

/** The first branch that takes `event`. */
function branchOf(
  branches: readonly (readonly [string, WaitTake])[],
  event: { name: string; from: string; data?: unknown },
): string | undefined {
  return branches.find(([, take]) => matches(event, take))?.[0];
}
