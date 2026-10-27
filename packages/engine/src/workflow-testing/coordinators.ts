import type { CoordinatorHolder, CoordinatorPort } from "../coordinator-port";
import type { HolderResult, MessagingEventBody } from "../messaging/messaging";
import type {
  ParticipantMessage,
  ParticipantOutcome,
  ParticipantRoute,
  ParticipantScript,
} from "./script";

/**
 * Answers for a test's coordinators from their scripts, as a holder would: each route to one as it
 * opens, and each message an agent sends one once recorded, is handed to its script.
 */
export class ParticipantScripts implements CoordinatorPort {
  readonly #scripts: Readonly<Record<string, ParticipantScript>>;
  readonly #attempt: number;
  readonly #events: { onActivity(): void; onScriptError(message: string): void };
  #holder: CoordinatorHolder | undefined;
  readonly #connected = new Set<string>();
  /** Script calls not yet settled. */
  #working = 0;

  constructor(
    scripts: Readonly<Record<string, ParticipantScript>> | undefined,
    attempt: number,
    events: { onActivity(): void; onScriptError(message: string): void },
  ) {
    this.#scripts = scripts ?? {};
    this.#attempt = attempt;
    this.#events = events;
  }

  attach(holder: CoordinatorHolder): void {
    this.#holder = holder;
  }

  /** Nothing a script was handed is still running. */
  get idle(): boolean {
    return this.#working === 0;
  }

  /** Questions open to coordinators now; `closesAt` where one closes unanswered. */
  open(): { closesAt?: number }[] {
    return this.#holder?.open() ?? [];
  }

  recorded(event: MessagingEventBody): void {
    if (event.kind === "participant-connected") {
      this.#connected.add(event.participant);
      return;
    }
    if (event.kind === "route-opened") {
      const [a, b] = event.between ?? [event.from, event.to];
      for (const [coordinator, agent] of [
        [a, b],
        [b, a],
      ] as const) {
        if (!this.#connected.has(coordinator)) continue;
        const direction = event.between
          ? "both"
          : event.from === coordinator
            ? "from-participant"
            : "to-participant";
        const route: ParticipantRoute = {
          kind: "route",
          agent,
          direction,
          purpose: event.purpose,
          send: (text) => this.#send(coordinator, agent, text),
        };
        this.#call(coordinator, route);
      }
      return;
    }
    if (event.kind === "message-sent" && this.#connected.has(event.to)) {
      const coordinator = event.to;
      const message: ParticipantMessage = {
        kind: "message",
        id: this.#id(event.message),
        from: event.from,
        text: event.text,
        ...(event.awaitsReply ? { asks: true as const } : {}),
        reply: (text) =>
          this.#outcome(
            this.#holder!.reply({
              coordinator,
              agent: event.from,
              to: event.message,
              text,
              via: "test",
            }),
          ),
        send: (agent, text) => this.#send(coordinator, agent, text),
      };
      this.#call(coordinator, message);
    }
  }

  #call(coordinator: string, event: ParticipantRoute | ParticipantMessage): void {
    const script = this.#scripts[coordinator];
    if (!script) {
      this.#events.onScriptError(
        `${event.kind === "route" ? "a route" : "a message"} reached coordinator "${coordinator}", which has no script under coordinators`,
      );
      return;
    }
    this.#working += 1;
    this.#events.onActivity();
    // Never inside the record's write: a script's reply is a holder's, arriving after it.
    void Promise.resolve()
      .then(() => script(event))
      .catch((error: unknown) =>
        this.#events.onScriptError(
          `coordinator "${coordinator}"'s script threw: ${error instanceof Error ? error.message : String(error)}`,
        ),
      )
      .finally(() => {
        this.#working -= 1;
        this.#events.onActivity();
      });
  }

  #send(coordinator: string, agent: string, text: string): Promise<ParticipantOutcome> {
    return this.#outcome(this.#holder!.send({ coordinator, agent, text, via: "test" }));
  }

  async #outcome(result: Promise<HolderResult>): Promise<ParticipantOutcome> {
    const settled = await result;
    return settled.code === "delivered"
      ? { code: "delivered", id: this.#id(settled.message) }
      : { code: settled.code };
  }

  #id(message: number): string {
    return `${this.#attempt}.${message}`;
  }
}
