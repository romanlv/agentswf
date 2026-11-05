import { AWF_ID_PREFIX } from "@agentswf/contract/workflow";
import type { DerivedIds } from "./run-policy/waits";

function hashed(kind: string, text: string): string {
  const hash = new Bun.CryptoHasher("sha256").update(text).digest("hex");
  return `${AWF_ID_PREFIX}${kind}.${hash.slice(0, 16)}`;
}

/** The id timer `name` is taken under: made from its name, so it fires once. */
export function timerEventId(name: string): string {
  return hashed("timer", name);
}

/**
 * The id of branch `branch`'s time read from state, `due` an ISO time: made from both, so a time is
 * returned once by a branch of that name, whichever loop reads it.
 */
export function atEventId(branch: string, due: string): string {
  return hashed("at", `${branch}\n${due}`);
}

/**
 * The id of the end of `agent`'s turn `turn`, begun in attempt `began`: made from the three, so it
 * fits the grammar whatever each is, and is the same whoever writes it, so one end is ever kept.
 */
export function endIdOf(agent: string, turn: string, began: number): string {
  return hashed("end", `${agent}\0${turn}\0${began}`);
}

/** The derived ids, as the waits' policy takes them. */
export const DERIVED_IDS: DerivedIds = { timer: timerEventId, at: atEventId };
