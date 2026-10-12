import { RUN_EVENT_VERSIONS, type RunEvent, type TurnRecord } from "@agentswf/contract/records";
import { messageOf } from "./errors";
import { appendEvent } from "./runs";

type Body<E> = E extends unknown ? Omit<E, "version" | "attempt" | "at"> : never;
/** An event as the engine writes it: the log fills in its version, attempt and time. */
export type RunEventBody = Body<RunEvent>;

/**
 * The attempt's writer of the run's event log. Lines go out in call order, and a write that fails
 * costs the run nothing: it is said through `failed`, which must not write to this log, for each
 * turn and once for the other lines.
 */
export class RunEventLog {
  readonly #writes: Promise<void>[] = [];
  #failed = false;
  #closed = false;

  constructor(
    private readonly options: {
      runDir: string;
      attempt: number;
      failed(message: string): void;
      now?: () => number;
    },
  ) {}

  /** Whether the line was written, once it is; a caller may wait for it, and none has to. */
  event(body: RunEventBody, at?: number): Promise<boolean> {
    if (this.#closed) return Promise.resolve(false);
    const time = new Date(at ?? this.options.now?.() ?? Date.now()).toISOString();
    return this.#append({
      version: RUN_EVENT_VERSIONS[body.kind],
      attempt: this.options.attempt,
      at: time,
      ...body,
    } as RunEvent);
  }

  turn(record: TurnRecord): void {
    if (this.#closed) return;
    this.#writes.push(
      appendEvent(this.options.runDir, record).catch((error) =>
        this.options.failed(`awf: a turn was not recorded in turns.jsonl: ${messageOf(error)}`),
      ),
    );
  }

  /**
   * Once every line asked for so far is written, or has failed. Nothing is written after: the
   * attempt's end follows, and then the next attempt's lines.
   */
  async close(): Promise<void> {
    this.#closed = true;
    await Promise.all(this.#writes);
  }

  #append(line: RunEvent): Promise<boolean> {
    const written = appendEvent(this.options.runDir, line).then(
      () => true,
      (error) => {
        if (!this.#failed) {
          this.#failed = true;
          this.options.failed(`awf: the run's event log was not written: ${messageOf(error)}`);
        }
        return false;
      },
    );
    this.#writes.push(written.then(() => undefined));
    return written;
  }
}
