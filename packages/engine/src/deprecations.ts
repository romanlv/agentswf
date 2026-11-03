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
} as const satisfies Record<string, { old: string; instead: string }>;

export type Deprecated = keyof typeof DEPRECATIONS;

/** One attempt's deprecated uses: each name said once, as a warning in the run's log. */
export class RunDeprecations {
  readonly #said = new Set<Deprecated>();
  /** The attempt has ended: an outcome kept past it reports to no log. */
  #settled = false;

  constructor(private readonly warn: (text: string) => void) {}

  used(name: Deprecated): void {
    if (this.#said.has(name)) return;
    this.#said.add(name);
    const { old, instead } = DEPRECATIONS[name];
    this.warn(`awf: ${old} is deprecated; ${instead}`);
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
