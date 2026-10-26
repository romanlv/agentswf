import { stat } from "node:fs/promises";
import { join } from "node:path";
import { MAILBOX_RECORD_VERSION, type MailboxRecord } from "@agentswf/contract/records";
import type { JsonValue, ReceiveOptions, WorkflowEvent } from "@agentswf/contract/workflow";
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

/** Appends a record; the caller holds the key's lock. */
export async function appendMailbox(runDir: string, record: MailboxRecord): Promise<void> {
  await endTornLine(mailboxFile(runDir));
  await appendLine(mailboxFile(runDir), JSON.stringify(record));
}

type EventRecord = Extract<MailboxRecord, { kind: "event" }>;
type WaitRecord = Extract<MailboxRecord, { kind: "wait" }>;

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
    }
  }
  const taken = new Set(held);
  return {
    events,
    unacknowledged: order.filter((id) => !acknowledged.has(id) && !taken.has(id)),
    ...(held ? { held } : {}),
    ...(lastWait ? { lastWait } : {}),
    batches,
  };
}

/** An event as a wait returns it. */
export function eventOf(record: EventRecord): WorkflowEvent<string, JsonValue> {
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
  constructor(
    readonly label: string | undefined,
    readonly until: string | undefined,
  ) {
    super(`parked${label === undefined ? "" : `: ${label}`}`);
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
  /** Writes the attempt's `parked` ending, holding the key's lock, so a waker sees it at once. */
  park(wait: { label?: string; until?: string }): Promise<void>;
};

/** How often a wait looks at its mailbox when no nudge comes: a nudge that failed still arrives. */
const POLL_MILLISECONDS = 1_000;

/**
 * A live run's waits on its mailbox. Every append is made inside `locked`, which holds the key's
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
      /** Runs `work` holding the key's lock. */
      locked<T>(work: () => Promise<T>): Promise<T>;
      /** Absent, the run never parks: it waits in its process. */
      parking?: Parking;
      now?: () => number;
    },
  ) {
    // A run nobody races, such as a test's, leaves no rejection unhandled.
    this.#parked.promise.catch(() => undefined);
  }

  async #append(record: MailboxRecord): Promise<void> {
    await this.options.locked(() => appendMailbox(this.options.runDir, record));
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
      const state = foldMailbox(await readMailbox(this.options.runDir));
      const ids = state.batches.get(stage);
      if (ids) return this.#events(state, ids);
    } else if (this.#first) {
      this.#first = false;
      const state = foldMailbox(await readMailbox(this.options.runDir));
      if (state.held) return this.#events(state, state.held);
    }
    const now = () => this.options.now?.() ?? Date.now();
    const at = () => new Date(now()).toISOString();
    const { attempt } = this.options;
    await this.#append({
      version: MAILBOX_RECORD_VERSION,
      at: at(),
      kind: "wait",
      attempt,
      ...(label === undefined ? {} : { label }),
      ...(until === undefined ? {} : { until: new Date(until).toISOString() }),
      ...(stage === undefined ? {} : { stage }),
    });
    const took = async (ids: string[]) =>
      this.#append({
        version: MAILBOX_RECORD_VERSION,
        at: at(),
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
      if (until !== undefined && now() >= until) {
        await took([]);
        return [];
      }
      const { parking } = this.options;
      const idle = parking?.idle(stage) ?? false;
      if (parking && idle) {
        const untilIso = until === undefined ? undefined : new Date(until).toISOString();
        // Checked once more under the lock, which every sender appends under: an event sent now is
        // either seen here, or sent after `parked` is written and continues the run.
        const parked = await this.options.locked(async () => {
          const again = foldMailbox(await readMailbox(this.options.runDir));
          if (again.unacknowledged.length > 0) return false;
          await parking.park({
            ...(label === undefined ? {} : { label }),
            ...(untilIso === undefined ? {} : { until: untilIso }),
          });
          return true;
        });
        if (parked) {
          this.parked = new RunParked(label, untilIso);
          this.#parked.reject(this.parked);
          throw this.parked;
        }
        continue;
      }
      // With no `until`, only a nudge or the size poll wakes it, or, with a turn running, its end,
      // which may let the run park: looked at each second.
      const longest = parking && !idle ? POLL_MILLISECONDS : 2 ** 31 - 1;
      await this.#idle(
        woken,
        size,
        Math.min(longest, until === undefined ? longest : until - now()),
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
