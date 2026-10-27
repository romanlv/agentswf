import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  MAILBOX_RECORD_VERSION,
  type MailboxRecord,
  type WaitingJson,
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

/** `mailbox.jsonl`: a run's events, and what its waits did with them. */
export function mailboxFile(runDir: string): string {
  return join(runDir, "mailbox.jsonl");
}

/** The run's mailbox in the order written, less a line a crash tore and kinds this awf doesn't know. */
export async function readMailbox(runDir: string): Promise<MailboxRecord[]> {
  const lines = await readLines<MailboxRecord>(mailboxFile(runDir));
  return lines.filter((line) => line.version === MAILBOX_RECORD_VERSION && KINDS.has(line.kind));
}

const KINDS = new Set<string>(["event", "wait", "took", "turn", "launch-failed"]);

/** Appends a record; the caller holds the run's lock. */
export async function appendMailbox(runDir: string, record: MailboxRecord): Promise<void> {
  await endTornLine(mailboxFile(runDir));
  await appendLine(mailboxFile(runDir), JSON.stringify(record));
}

type EventRecord = Extract<MailboxRecord, { kind: "event" }>;
type TurnRecord = Extract<MailboxRecord, { kind: "turn" }>;

type WaitRecord = Extract<MailboxRecord, { kind: "wait" }>;

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
};

/**
 * Folds a mailbox. A `wait` outside a stage acknowledges what the last `took` outside one
 * returned; a `took` in a stage acknowledges its own batch, which the stage holds.
 */
export function foldMailbox(records: readonly MailboxRecord[]): MailboxState {
  const events = new Map<string, EventRecord>();
  const order: string[] = [];
  const acknowledged = new Set<string>();
  const batches = new Map<string, string[]>();
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
        // A wait in a stage leaves the loop's batch to the loop.
        if (record.stage === undefined) {
          for (const id of held ?? []) acknowledged.add(id);
          held = undefined;
        }
        lastWait = { ...record, waiting: true };
        break;
      case "took":
        if (lastWait) lastWait.waiting = false;
        if (record.stage !== undefined) {
          for (const id of record.ids) acknowledged.add(id);
          batches.set(record.stage, record.ids);
        } else held = record.ids.length > 0 ? record.ids : undefined;
        break;
      case "turn":
        turns.push(record);
        break;
    }
  }
  const taken = new Set(held);
  return {
    events,
    unacknowledged: order.filter((id) => !acknowledged.has(id) && !taken.has(id)),
    ...(held ? { held } : {}),
    ...(lastWait ? { lastWait } : {}),
    batches,
    turns,
  };
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
  /** Writes the attempt's `parked` ending, holding the run's lock, so a waker sees it at once. */
  park(wait: WaitingJson): Promise<void>;
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

  /**
   * Acknowledges what the last call returned, then takes the events not yet acknowledged, waiting
   * for one when there is none, until `until`. The attempt's first call, outside a stage, returns a
   * batch an earlier attempt took and never acknowledged, alone, and writes nothing. In a stage that
   * has taken its batch, as one that failed or died before its record did has, it returns that
   * batch and writes nothing.
   */
  async receive(
    options: ReceiveOptions | undefined,
    stage?: string,
    /** Rejects the wait: the run ended, or the scope it waits in was cancelled. */
    signal?: AbortSignal,
  ): Promise<WorkflowEvent<string, JsonValue>[]> {
    const { label, until, take } = checked(options);
    if (stage !== undefined) {
      const batch = await this.batchOf(stage);
      if (batch) return batch;
    } else if (this.#first) {
      this.#first = false;
      const state = foldMailbox(await readMailbox(this.options.runDir));
      if (state.held) return this.#events(state, state.held);
    }
    const { attempt } = this.options;
    await this.#append({
      version: MAILBOX_RECORD_VERSION,
      at: this.#at(),
      kind: "wait",
      attempt,
      ...(label === undefined ? {} : { label }),
      ...(until === undefined ? {} : { until: new Date(until).toISOString() }),
      ...(stage === undefined ? {} : { stage }),
    });
    const took = async (ids: string[]) =>
      this.#append({
        version: MAILBOX_RECORD_VERSION,
        at: this.#at(),
        kind: "took",
        attempt,
        ids,
        ...(stage === undefined ? {} : { stage }),
      });
    for (;;) {
      signal?.throwIfAborted();
      // Armed before reading, so a nudge between the read and the wait is not lost.
      const woken = new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
      // Before the read too: what is appended after the read changes it, nudged or not.
      const size = await mailboxSize(this.options.runDir);
      const state = foldMailbox(await readMailbox(this.options.runDir));
      const ready = state.unacknowledged;
      if (ready.length > 0) {
        const ids = take === "oldest" ? ready.slice(0, 1) : ready;
        await took(ids);
        return this.#events(state, ids);
      }
      if (until !== undefined && this.#now() >= until) {
        await took([]);
        return [];
      }
      const { parking } = this.options;
      const idle = parking?.idle(stage) ?? false;
      if (parking && idle) {
        const wait: WaitingJson = {
          ...(label === undefined ? {} : { label }),
          ...(until === undefined ? {} : { until: new Date(until).toISOString() }),
        };
        // Checked once more under the lock, which every sender appends under: an event sent now is
        // either seen here, or sent after `parked` is written and continues the run.
        const parked = await this.options.locked(async () => {
          const again = foldMailbox(await readMailbox(this.options.runDir));
          if (again.unacknowledged.length > 0) return false;
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
      // With no `until`, only a nudge or the size poll wakes it, or, with a turn running, its end,
      // which may let the run park: looked at each second.
      const longest = parking && !idle ? POLL_MILLISECONDS : Number.POSITIVE_INFINITY;
      await this.#idle(
        woken,
        size,
        Math.min(longest, until === undefined ? longest : until - this.#now()),
        signal,
      );
    }
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
  until?: number;
  take: "all" | "oldest";
} {
  if (options !== undefined && (typeof options !== "object" || options === null))
    throw new Error("receive takes { label?, until?, take? }");
  const { label, until, take = "all" } = options ?? {};
  if (label !== undefined && typeof label !== "string")
    throw new Error("receive's label is a string");
  if (take !== "all" && take !== "oldest") throw new Error('receive\'s take is "all" or "oldest"');
  const ms = until instanceof Date ? until.getTime() : until;
  if (ms !== undefined && (typeof ms !== "number" || !Number.isFinite(ms)))
    throw new Error("receive's until is epoch milliseconds or a Date");
  return {
    ...(label === undefined ? {} : { label }),
    ...(ms === undefined ? {} : { until: ms }),
    take,
  };
}
