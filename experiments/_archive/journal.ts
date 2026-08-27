import { createHash } from "node:crypto";
import { appendJournal, readJournal, type JournalEntry } from "./deps";
import type { CallResult, Step } from "./deps";

/**
 * What actually ran the call, when the journal had nothing. The journal never opens a backend
 * itself; it only decides whether one is needed.
 */
export type RunCall = (step: Step, callId: string) => Promise<CallResult>;

export type CallOutcome = {
  result: CallResult;
  /** True when the value came from the journal and no backend was touched. */
  replayed: boolean;
  callId: string;
  index: number;
  key: string;
};

export type JournalStats = { hits: number; misses: number };

export type Journal = {
  call(step: Step): Promise<CallOutcome>;
  stats(): JournalStats;
};

/** What a workflow script sees. `agent(step)` either replays or runs; it cannot tell which. */
export type Agent = (step: Step) => Promise<CallResult>;

/**
 * Everything about a call that could change the answer. Mapped over `Step` so a field added
 * there is a type error here until someone decides whether it belongs in the key.
 */
type Fingerprint = { [K in keyof Required<Step>]: unknown };

const SEED = "wf-journal-v1";

/**
 * Opens the journal in an existing run directory. Replaying is re-running the same script
 * against the same directory: every call whose key is already recorded returns without an
 * agent, and the first key that differs — plus every call after it, because keys chain —
 * runs live.
 */
export async function openJournal(runDir: string, run: RunCall): Promise<Journal> {
  const cached = new Map<string, JournalEntry>();
  for (const entry of await readJournal(runDir)) {
    // First write wins, matching `writeAccepted`: a replay must not depend on how many times
    // a resume has been attempted.
    if (!cached.has(entry.key)) cached.set(entry.key, entry);
  }

  let chain = SEED;
  let next = 0;
  const stats: JournalStats = { hits: 0, misses: 0 };

  return {
    async call(step: Step): Promise<CallOutcome> {
      // Position and chain are taken before the first await, so concurrent callers get
      // distinct keys rather than racing for the same one.
      const index = next;
      next += 1;
      const key = advance(chain, step, index);
      chain = key;

      const hit = cached.get(key);
      if (hit) {
        stats.hits += 1;
        return {
          result: { kind: "answered", value: hit.value },
          replayed: true,
          callId: hit.callId,
          index,
          key,
        };
      }

      stats.misses += 1;
      const callId = `c${index}-${key.slice(0, 8)}`;
      const result = await run(step, callId);
      // Only `answered` is recorded. A cached failure would make a transient Herdr error
      // permanent for as long as the run directory exists.
      if (result.kind === "answered") {
        await appendJournal(runDir, {
          key,
          index,
          callId,
          value: result.value,
          at: new Date().toISOString(),
        });
      }
      return { result, replayed: false, callId, index, key };
    },
    stats: () => ({ ...stats }),
  };
}

export type WorkflowOutcome<T> = { value: T; stats: JournalStats };

/** Runs a script with a journalled `agent`. The script is ordinary code and re-runs in full. */
export async function runWorkflow<T>(
  runDir: string,
  run: RunCall,
  script: (agent: Agent) => Promise<T>,
): Promise<WorkflowOutcome<T>> {
  const journal = await openJournal(runDir, run);
  const value = await script(async (step) => (await journal.call(step)).result);
  return { value, stats: journal.stats() };
}

function advance(previous: string, step: Step, index: number): string {
  const print: Fingerprint = {
    prompt: step.prompt,
    harness: step.harness,
    model: step.model ?? null,
    backend: step.backend ?? null,
    schema: step.schema ?? null,
    cwd: step.cwd ?? null,
  };
  return createHash("sha256")
    .update(`${previous}\n${index}\n${canonical(print)}`)
    .digest("hex");
}

/** Key order in a schema object is not meaning, so it must not change the key. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([name, item]) => `${JSON.stringify(name)}:${canonical(item)}`);
  return `{${entries.join(",")}}`;
}
