/**
 * Every name deprecated before 0.1.0, with what replaces it: each is logged once per attempt it is
 * used in, so a continued or woken run logs it again, and removed one beta after the beta that
 * deprecated it (story 039).
 */
export const DEPRECATIONS = {
  labels: {
    old: "an agent's labels option",
    instead: "drop them: nothing reads an agent's labels",
  },
  whenToUse: { old: "meta.whenToUse", instead: "drop it: nothing reads it" },
  "stage-receive": {
    old: "a stage around wf.receive()",
    instead: "wait with wf.race(name, …), which is recorded under its name, outside a stage",
  },
  isAnswered: { old: "isAnswered(outcome)", instead: "check outcome.answered" },
  defineExecutableWorkflow: {
    old: "defineExecutableWorkflow",
    instead: "use defineWorkflow, with meta and run beside prepare",
  },
  "call-id": {
    old: "the id of one run, start, compact or set",
    instead:
      "drop it: a later attempt doesn't know it, and a stage keeps a call from running twice",
  },
  "turn-source": {
    old: "a started turn as a wait's branch",
    instead: "name the agent, { done: agent }, which has at most one started turn",
  },
  "turn-is": { old: "turn.is(e)", instead: "use agent.is(e)" },
  "test-reply": {
    old: "reply.… in a test's script",
    instead: "use noAnswer.…, the same calls: a reply answers, these end a turn without an answer",
  },
  "message-silent": {
    old: "message.silent() in a test's message script",
    instead: "return nothing, which ends the turn without a reply",
  },
  "message-fail": {
    old: "message.fail() in a test's message script",
    instead: "return noAnswer.failed(reason), which fails the turn as a failed harness does",
  },
  "test-event-id": {
    old: "an event's id in a test",
    instead: "give it as eventId, as awf emit --event-id does",
  },
  "run-stopped": { old: "run.stopped", instead: 'read run.ending, whose kind is "stopped"' },
  "run-parked": { old: "run.parked", instead: 'read run.ending, whose kind is "parked"' },
  "colon-key": {
    old: "a key with a colon",
    instead: (key: string) =>
      `${key === "" ? "use - in its place" : `name it ${key.replaceAll(":", "-")}`}: a colon is kept for awf's own event names`,
  },
  "agents-stop": {
    old: "wf.agents.stop(key)",
    instead: "call close(reason?) on the agent's ref",
  },
  "fork-runtime": {
    old: "a fork's own placement, metered or effort",
    instead:
      "give them in its runtime, as open does: fork({ key, runtime: { placement, metered, effort } })",
  },
} as const satisfies Record<
  string,
  { old: string; instead: string | ((subject: string) => string) }
>;

export type Deprecated = keyof typeof DEPRECATIONS;

/** One attempt's deprecated uses: each name said once, as a warning in the run's log. */
export class RunDeprecations {
  /** Each name said, with its subject where it has one: each key with a colon is named. */
  readonly #said = new Set<string>();
  /** The attempt has ended: an outcome kept past it reports to no log. */
  #settled = false;

  constructor(private readonly warn: (text: string) => void) {}

  /** `subject`, where given, is what was used, and each subject is said once. */
  used(name: Deprecated, subject?: string): void {
    const said = subject === undefined ? name : `${name}\0${subject}`;
    if (this.#said.has(said)) return;
    this.#said.add(said);
    this.warn(deprecationLine(name, subject));
  }

  settle(): void {
    this.#settled = true;
  }

  /** As `used`, for a name the contract reports by its own spelling; one not listed is ignored. */
  reported = (name: unknown): void => {
    if (this.#settled) return;
    if (typeof name === "string" && Object.hasOwn(DEPRECATIONS, name))
      this.used(name as Deprecated);
  };
}

/** The line a deprecated use logs. */
export function deprecationLine(name: Deprecated, subject = ""): string {
  const { old, instead } = DEPRECATIONS[name];
  const named = subject === "" ? "" : `, ${subject},`;
  return `awf: ${old}${named} is deprecated; ${typeof instead === "function" ? instead(subject) : instead}`;
}
