import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Attempt, CallSpec } from "@wf/contract/records";
import { appendLine, readLines } from "./jsonl";

/**
 * The engine is the only writer of the run directory. The formats it writes live in
 * `@wf/contract/records`; this file is the I/O.
 */

export function callDir(runDir: string, callId: string): string {
  return join(runDir, "calls", callId);
}

export async function createRunDir(root: string, runId: string): Promise<string> {
  const dir = join(root, runId);
  await mkdir(join(dir, "calls"), { recursive: true });
  return dir;
}

export async function writeCall(runDir: string, spec: CallSpec): Promise<void> {
  const dir = callDir(runDir, spec.callId);
  await mkdir(dir, { recursive: true });
  await Bun.write(join(dir, "call.json"), JSON.stringify(spec, null, 2));
}

export async function readCall(runDir: string, callId: string): Promise<CallSpec | null> {
  const file = Bun.file(join(callDir(runDir, callId), "call.json"));
  if (!(await file.exists())) return null;
  return (await file.json()) as CallSpec;
}

export async function recordAttempt(
  runDir: string,
  callId: string,
  attempt: Attempt,
): Promise<void> {
  const dir = callDir(runDir, callId);
  await mkdir(dir, { recursive: true });
  await appendLine(join(dir, "attempts.jsonl"), JSON.stringify(attempt));
}

export async function readAttempts(runDir: string, callId: string): Promise<Attempt[]> {
  return readLines<Attempt>(join(callDir(runDir, callId), "attempts.jsonl"));
}

/**
 * First accepted value wins. A second report is kept in the attempt log, not promoted.
 *
 * The exists-then-write is a check-then-act: two concurrent submissions can both see no file
 * and both write. Stage 2 replaces it with an atomic create; until then this is single-writer
 * only, which is what every measurement so far has been.
 */
export async function writeAccepted(
  runDir: string,
  callId: string,
  value: unknown,
): Promise<boolean> {
  const path = join(callDir(runDir, callId), "result.json");
  if (await Bun.file(path).exists()) return false;
  await Bun.write(path, JSON.stringify({ value, at: new Date().toISOString() }, null, 2));
  return true;
}

/** Null distinguishes "no value yet" from a call whose accepted value happens to be null. */
export async function readAccepted(
  runDir: string,
  callId: string,
): Promise<{ value: unknown } | null> {
  const file = Bun.file(join(callDir(runDir, callId), "result.json"));
  if (!(await file.exists())) return null;
  const { value } = (await file.json()) as { value: unknown };
  return { value };
}
