import { expect, test } from "bun:test";
import type { RunLine } from "@agentswf/contract/records";
import type { RunLines } from "./run-lines";
import { SessionLines } from "./session-lines";

/** A writer that refuses the appends `failing` names, by session, once each. */
function writer(failing: string[] = []): RunLines & { written: RunLine[] } {
  const written: RunLine[] = [];
  return {
    attempt: 1,
    written,
    async append(line) {
      const at = line.kind === "session" ? failing.indexOf(line.session) : -1;
      if (at >= 0) {
        failing.splice(at, 1);
        throw new Error("disk full");
      }
      written.push(line);
    },
  };
}

const codex = (...ids: string[]) => ids.map((id) => ({ harness: "codex", id }));
const sessionsOf = (lines: RunLine[]) =>
  lines.flatMap((line) => (line.kind === "session" ? [`${line.agent}:${line.session}`] : []));

test("each session is written once an attempt, with its operation and home", async () => {
  const lines = writer();
  const sessions = new SessionLines({ lines, failed: () => undefined });
  sessions.known("worker", codex("s-1"), { operation: "op-1", home: "/box/h" });
  sessions.known("worker", codex("s-1", "s-2"), { operation: "op-2" });
  sessions.known("tests", codex("s-1"));
  await sessions.flushed();
  expect(sessionsOf(lines.written)).toEqual(["worker:s-1", "worker:s-2", "tests:s-1"]);
  expect(lines.written[0]).toMatchObject({ operation: "op-1", home: "/box/h", attempt: 1 });
  expect(lines.written[1]).toMatchObject({ operation: "op-2" });
});

test("a session's sandbox and skills are written with it, absent when it has none", async () => {
  const lines = writer();
  const sessions = new SessionLines({ lines, failed: () => undefined });
  const sandbox = {
    provider: "docker" as const,
    spec: { cwd: "/w", read: [], write: [], network: [], docker: {} },
    directory: "/box",
    provided: { image: "sha256:1" },
  };
  const skills = { names: ["probe"], directory: "/box/homes/h/skills" };
  sessions.known("worker", codex("s-1"), { home: "/box/homes/h", sandbox, skills });
  sessions.known("plain", codex("s-2"));
  await sessions.flushed();
  expect(lines.written[0]).toMatchObject({ home: "/box/homes/h", sandbox, skills });
  expect(Object.keys(lines.written[1]!)).not.toContain("sandbox");
  expect(Object.keys(lines.written[1]!)).not.toContain("skills");
});

test("a session whose line failed is warned of, and written again when next seen, in order", async () => {
  const lines = writer(["s-1"]);
  const warned: string[] = [];
  const sessions = new SessionLines({ lines, failed: (text) => warned.push(text) });
  sessions.known("worker", codex("s-1", "s-2"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(warned).toEqual(["awf: agent worker's session was not recorded: disk full"]);
  expect(sessionsOf(lines.written)).toEqual(["worker:s-2"]);
  // Seen again, it is written again, and so is the one seen after it: the latest stays the newest.
  sessions.known("worker", codex("s-1", "s-2"));
  await sessions.flushed();
  expect(sessionsOf(lines.written)).toEqual(["worker:s-2", "worker:s-1", "worker:s-2"]);
});

test("a session dropped by a failed write is tried once more as the attempt flushes", async () => {
  const lines = writer(["s-1"]);
  const warned: string[] = [];
  const sessions = new SessionLines({ lines, failed: (text) => warned.push(text) });
  sessions.known("worker", codex("s-1", "s-2"), { operation: "op-1" });
  await sessions.flushed();
  expect(warned).toHaveLength(1);
  expect(sessionsOf(lines.written)).toEqual(["worker:s-2", "worker:s-1", "worker:s-2"]);
  expect(lines.written[1]).toMatchObject({ operation: "op-1" });
});

test("a second failure as it flushes stays a warning", async () => {
  const lines = writer(["s-1", "s-1"]);
  const warned: string[] = [];
  const sessions = new SessionLines({ lines, failed: (text) => warned.push(text) });
  sessions.known("worker", codex("s-1"));
  await sessions.flushed();
  expect(warned).toHaveLength(2);
  expect(sessionsOf(lines.written)).toEqual([]);
  // Nothing is left to try: a later flush writes nothing more.
  await sessions.flushed();
  expect(warned).toHaveLength(2);
});
