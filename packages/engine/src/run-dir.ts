import { randomUUID } from "node:crypto";
import { link, mkdir, open, unlink } from "node:fs/promises";
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

/** Writes a complete candidate before atomically claiming the one accepted-result path. */
export async function writeAcceptedExclusive(
  runDir: string,
  callId: string,
  value: unknown,
): Promise<boolean> {
  const dir = callDir(runDir, callId);
  await mkdir(dir, { recursive: true });
  const resultPath = join(dir, "result.json");
  const temporaryPath = join(dir, `.result-${randomUUID()}.tmp`);
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify({ value, at: new Date().toISOString() }, null, 2));
      await handle.sync();
    } finally {
      await handle.close();
    }

    try {
      await link(temporaryPath, resultPath);
      return true;
    } catch (error) {
      if (isAlreadyExists(error)) return false;
      throw error;
    }
  } finally {
    // The linked inode remains; failure to remove only leaves an ignorable private temp file.
    await unlink(temporaryPath).catch(() => undefined);
  }
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

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
