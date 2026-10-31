import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** What the run keeps of its question: when to nudge next, and how many nudges went out. */
type Saved = { nextNudge: string | null; nudges: number };

/**
 * The question's state, in a file beside the run's work: a parked run wakes in a new process, and
 * `workflow.at` reads the next nudge from here again. Read at the start; each change written whole.
 */
export class Ledger {
  private constructor(
    private readonly file: string,
    private saved: Saved,
  ) {}

  /** The ledger in `file`, or a new one whose first nudge is `first`. */
  static async open(file: string, first: () => Date): Promise<Ledger> {
    const text = await readFile(file, "utf8").catch(() => undefined);
    if (text !== undefined) return new Ledger(file, JSON.parse(text) as Saved);
    const ledger = new Ledger(file, { nextNudge: first().toISOString(), nudges: 0 });
    await ledger.write();
    return ledger;
  }

  /** When to nudge next; null once answered or given up. */
  nextNudge(): Date | null {
    return this.saved.nextNudge === null ? null : new Date(this.saved.nextNudge);
  }

  get nudges(): number {
    return this.saved.nudges;
  }

  /** A nudge went out; the next is due `next`, or none. */
  async nudged(next: Date | null): Promise<void> {
    this.saved = { nextNudge: next?.toISOString() ?? null, nudges: this.saved.nudges + 1 };
    await this.write();
  }

  /** The engineer asked for time: the next nudge moves to `until`. */
  async putOff(until: Date): Promise<void> {
    this.saved = { ...this.saved, nextNudge: until.toISOString() };
    await this.write();
  }

  /** Answered: no more nudges. */
  async answered(): Promise<void> {
    this.saved = { ...this.saved, nextNudge: null };
    await this.write();
  }

  private async write(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(`${this.file}.tmp`, JSON.stringify(this.saved));
    await rename(`${this.file}.tmp`, this.file);
  }
}
