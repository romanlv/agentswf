import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { ProcessInput, ProcessResult } from "@agentswf/harness";
import { writeJson } from "./files";
import { type Attach, openCommand } from "./open-command";
import { createRun, type Run, workDir } from "./runs";
import { createTempRunDirs } from "./testing";

const runDirs = createTempRunDirs();
afterAll(() => runDirs.cleanup());

const AT = "2026-11-05T10:00:00.000Z";

type Fixture = { cwd: string; root: string; run: Run; home: string };

/** A finished run whose agent `fixer` ran claude in `cwd`, on its own home inside the run. */
async function fixture(): Promise<Fixture> {
  const cwd = runDirs.tempRunDir();
  const root = join(cwd, ".awf", "runs");
  const run = await createRun(root, {
    id: "r7",
    workflow: "review",
    argv: [],
    cwd,
    sandbox: null,
  });
  const home = join(workDir(run.dir), "agents", "a1", "home");
  mkdirSync(home, { recursive: true });
  appendFileSync(
    join(run.dir, "run.jsonl"),
    `${JSON.stringify({ kind: "claimed", attempt: 1, at: AT })}\n`,
  );
  session(run, { agent: "fixer", session: "s-old", operation: "fixer.1", home });
  session(run, { agent: "fixer", session: "s-1", operation: "fixer.2", home });
  await op(run, "fixer.1", cwd, { harness: "claude", model: "claude-sonnet-5-5" });
  await op(run, "fixer.2", cwd, { harness: "claude", model: "claude-sonnet-5-5", effort: "high" });
  return { cwd, root, run, home };
}

function session(run: Run, line: Record<string, unknown>): void {
  appendFileSync(
    join(run.dir, "run.jsonl"),
    `${JSON.stringify({ kind: "session", attempt: 1, at: AT, harness: "claude", ...line })}\n`,
  );
}

async function op(run: Run, id: string, cwd: string, execution: Record<string, unknown>) {
  mkdirSync(join(run.dir, "ops", id), { recursive: true });
  await writeJson(join(run.dir, "ops", id, "op.json"), {
    id,
    attempt: 1,
    at: AT,
    kind: "turn",
    question: "q",
    agent: id.split(".")[0],
    execution,
    cwd,
  });
}

type Seen = { runs: ProcessInput[]; attached: Parameters<Attach>[0][] };

/** Fake processes: claude's fork answers with `copy-1`, its turn with `the answer`. */
function processes(seen: Seen, exitCode = 0) {
  return {
    run: async (input: ProcessInput): Promise<ProcessResult> => {
      seen.runs.push(input);
      const forking = input.argv.includes("--fork-session");
      const stdout = forking
        ? JSON.stringify({ session_id: "copy-1", num_turns: 0 })
        : JSON.stringify({ session_id: input.argv[3], result: "the answer" });
      return { stdout, stderr: "", exitCode: forking ? 0 : exitCode, timedOut: false };
    },
    attach: async (input: Parameters<Attach>[0]) => {
      seen.attached.push(input);
      return 7;
    },
  };
}

async function open(
  f: Fixture,
  argv: string[],
  options: { stdin?: string; exitCode?: number } = {},
) {
  const seen: Seen = { runs: [], attached: [] };
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await openCommand(
    [...argv, "--run-root", f.root],
    f.cwd,
    { stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) },
    {
      home: f.cwd,
      environment: {},
      withheld: ["CLAUDECODE"],
      ...processes(seen, options.exitCode),
      ...(options.stdin === undefined
        ? { stdinIsTerminal: true }
        : { stdin: async () => options.stdin! }),
    },
  );
  return { code, stdout, stderr, seen };
}

/** Every file under `directory`, by its path there, with its bytes' hash. */
function hashes(directory: string): Record<string, string> {
  const found: Record<string, string> = {};
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      if (statSync(path).isDirectory()) walk(path);
      else
        found[relative(directory, path)] = createHash("sha256")
          .update(readFileSync(path))
          .digest("hex");
    }
  };
  walk(directory);
  return found;
}

test("a copy of the agent's latest session opens in its harness's TUI, where and as it ran", async () => {
  const f = await fixture();
  const before = hashes(f.run.dir);
  const { code, stderr, seen } = await open(f, ["review/r7", "fixer"]);
  expect(code).toBe(7);
  // The copy is made from the latest session, in the agent's cwd and home, on its model.
  const [fork] = seen.runs;
  expect(fork!.argv.slice(0, 5)).toEqual(["claude", "-p", "--resume", "s-1", "--fork-session"]);
  expect(fork!.cwd).toBe(f.cwd);
  expect(fork!.env).toMatchObject({ CLAUDE_CONFIG_DIR: f.home, CLAUDECODE: undefined });
  // The TUI opens the copy, at the agent's model and effort, without the unattended flags.
  const [tui] = seen.attached;
  expect(tui!.argv.slice(0, 7)).toEqual([
    "claude",
    "--resume",
    "copy-1",
    "--model",
    "claude-sonnet-5-5",
    "--effort",
    "high",
  ]);
  expect(tui!.argv).not.toContain("--allowed-tools");
  expect(tui!.cwd).toBe(f.cwd);
  expect(tui!.env).toMatchObject({ CLAUDE_CONFIG_DIR: f.home, CLAUDECODE: undefined });
  expect(stderr).toEqual([
    "fixer · claude claude-sonnet-5-5 · a copy of s-1, copy-1",
    `again: awf open review/r7 fixer --session copy-1 --run-root ${f.root}`,
  ]);
  expect(hashes(f.run.dir)).toEqual(before);
});

test("-p asks a copy one question headless and prints the answer, or with --json its document", async () => {
  const f = await fixture();
  await op(f.run, "fixer.2", f.cwd, { harness: "claude", model: "m", metered: true });
  const { code, stdout, stderr, seen } = await open(f, [
    "review/r7",
    "fixer",
    "-p",
    "why?",
    "--json",
  ]);
  expect(code).toBe(0);
  const turn = seen.runs[1]!;
  expect(turn.argv.slice(0, 4)).toEqual(["claude", "-p", "--resume", "copy-1"]);
  expect(turn.stdin).toBe("why?");
  expect(JSON.parse(stdout[0]!)).toEqual({
    v: 1,
    agent: "fixer",
    harness: "claude",
    session: "copy-1",
    forkedFrom: "s-1",
    cwd: f.cwd,
    model: "m",
    reply: "the answer",
    again: `awf open review/r7 fixer --session copy-1 --run-root ${f.root}`,
  });
  expect(stderr).toEqual([`again: awf open review/r7 fixer --session copy-1 --run-root ${f.root}`]);
});

test("-p without text reads stdin, and is refused on a terminal", async () => {
  const f = await fixture();
  await op(f.run, "fixer.2", f.cwd, { harness: "claude", model: "m", metered: true });
  const piped = await open(f, ["review/r7", "fixer", "-p"], { stdin: "from stdin" });
  expect(piped.code).toBe(0);
  expect(piped.seen.runs[1]!.stdin).toBe("from stdin");
  const terminal = await open(f, ["review/r7", "fixer", "-p"]);
  expect(terminal.code).toBe(1);
  expect(terminal.seen.runs).toEqual([]);
});

test("--session names an earlier session, copied as the latest is, or a copy, opened as it is", async () => {
  const f = await fixture();
  const earlier = await open(f, ["review/r7", "fixer", "--session", "s-old"]);
  expect(earlier.seen.runs[0]!.argv.slice(3, 5)).toEqual(["s-old", "--fork-session"]);
  // The earlier session's own operation: its model, not the latest's effort.
  expect(earlier.seen.attached[0]!.argv).not.toContain("--effort");
  const copy = await open(f, ["review/r7", "fixer", "--session", "copy-9"]);
  expect(copy.seen.runs).toEqual([]);
  expect(copy.seen.attached[0]!.argv.slice(0, 3)).toEqual(["claude", "--resume", "copy-9"]);
  expect(copy.stderr[0]).toBe("fixer · claude claude-sonnet-5-5 · session copy-9");
  expect(copy.stderr[1]).toBe(
    `again: awf open review/r7 fixer --session copy-9 --run-root ${f.root}`,
  );
});

test("each place the session can't be opened from is refused, naming why", async () => {
  const f = await fixture();
  const refused = async (argv: string[], code: number, said: RegExp) => {
    const result = await open(f, argv);
    expect(result.code).toBe(code);
    expect(result.stderr.join("\n")).toMatch(said);
    expect(result.seen.attached).toEqual([]);
  };
  await refused(
    ["review/r7", "nobody"],
    1,
    /no session of nobody's recorded; agents with one: fixer/,
  );
  await refused(["review/r9", "fixer"], 1, /review\/r9/);
  await refused(["review/r7", "fixer", "--json"], 2, /a TUI has no JSON/);
  await refused(["review/r7", "fixer", "extra"], 2, /-p takes the question/);
  // claude headless bills per token: an agent that did not run metered is not asked headless.
  await refused(["review/r7", "fixer", "-p", "why?"], 1, /billed per token/);
  // A home outside the run's folder is a sandbox's, which this line does not record.
  session(f.run, { agent: "boxed", session: "s-2", operation: "boxed.1", home: f.cwd });
  await op(f.run, "boxed.1", f.cwd, { harness: "claude", model: "m" });
  await refused(["review/r7", "boxed"], 3, /ran in a sandbox this run did not record/);
  rmSync(f.home, { recursive: true });
  await refused(["review/r7", "fixer"], 3, /own home .* is gone/);
  rmSync(f.cwd, { recursive: true });
});

test("the cwd gone is refused: claude finds a session only from where it ran", async () => {
  const f = await fixture();
  const gone = join(f.cwd, "worktree");
  await op(f.run, "fixer.2", gone, { harness: "claude", model: "m" });
  const result = await open(f, ["review/r7", "fixer"]);
  expect(result.code).toBe(3);
  expect(result.stderr.join("\n")).toContain(`worked in ${gone}, which is gone`);
});

test("a question the harness fails is refused with its error, and no again", async () => {
  const f = await fixture();
  await op(f.run, "fixer.2", f.cwd, { harness: "claude", model: "m", metered: true });
  const result = await open(f, ["review/r7", "fixer", "-p", "why?"], { exitCode: 1 });
  expect(result.code).toBe(1);
  expect(result.stderr.join("\n")).toContain("claude exited 1");
  expect(result.stdout).toEqual([]);
});
