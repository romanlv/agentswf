import type { SessionSandbox, SessionSkills } from "@agentswf/contract/records";
import type { NativeSessionRef } from "@agentswf/contract/workflow";
import { messageOf } from "./errors";
import type { RunLines } from "./run-lines";

/** Where a session lives: the agent's own home, its sandbox and its skills (story 042). */
export type SessionPlace = { home?: string; sandbox?: SessionSandbox; skills?: SessionSkills };
type SessionFields = SessionPlace & { operation?: string };
type Seen = { harness: string; fields: SessionFields };

/**
 * An attempt's `session` lines in `run.jsonl`: each native session an agent is seen with, once per
 * attempt, as it becomes known. The latest one of an agent is what a continue resumes it on.
 */
export class SessionLines {
  /** By agent, each session asked for and not failed, in the order seen. */
  readonly #written = new Map<string, Map<string, Seen>>();
  readonly #writes = new Set<Promise<void>>();
  /** Sessions a failed write dropped, which `flushed()` tries once more. */
  readonly #dropped: { agent: string; id: string; seen: Seen }[] = [];

  constructor(
    private readonly options: {
      lines: RunLines;
      /**
       * A line that could not be written: tried again when the session is next seen, and once
       * more as the attempt flushes; a second failure there stays a warning. Until one is written,
       * a continue reopens the agent on its last session recorded, or anew if none was.
       */
      failed(message: string): void;
    },
  ) {}

  /** `operation` is the operation the sessions were seen in; the rest, where the session lives. */
  known(agent: string, sessions: readonly NativeSessionRef[], fields: SessionFields = {}): void {
    let written = this.#written.get(agent);
    if (!written) {
      written = new Map();
      this.#written.set(agent, written);
    }
    for (const { harness, id } of sessions) {
      if (written.has(id)) continue;
      written.set(id, { harness, fields });
      const write = this.options.lines
        .append({
          kind: "session",
          attempt: this.options.lines.attempt,
          at: new Date().toISOString(),
          agent,
          harness,
          session: id,
          ...(fields.operation === undefined ? {} : { operation: fields.operation }),
          ...(fields.home === undefined ? {} : { home: fields.home }),
          ...(fields.sandbox === undefined ? {} : { sandbox: fields.sandbox }),
          ...(fields.skills === undefined ? {} : { skills: fields.skills }),
        })
        .catch((error) => {
          // It and those seen after it are written again, in order, when next seen: the latest
          // line stays the newest session.
          const seen = [...written];
          const at = seen.findIndex(([each]) => each === id);
          if (at >= 0) {
            for (const [later, how] of seen.slice(at)) {
              written.delete(later);
              this.#dropped.push({ agent, id: later, seen: how });
            }
          }
          this.options.failed(
            `awf: agent ${agent}'s session was not recorded: ${messageOf(error)}`,
          );
        })
        .finally(() => this.#writes.delete(write));
      this.#writes.add(write);
    }
  }

  /**
   * Once every line asked for so far is written, or has failed; a session a failed write dropped,
   * and not seen since, is tried once more first.
   */
  async flushed(): Promise<void> {
    const settled = async () => {
      while (this.#writes.size > 0) await Promise.all(this.#writes);
    };
    await settled();
    const dropped = this.#dropped.splice(0);
    for (const { agent, id, seen } of dropped) {
      this.known(agent, [{ harness: seen.harness, id }], seen.fields);
    }
    await settled();
    this.#dropped.length = 0;
  }
}
