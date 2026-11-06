import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import type { ProcessInput, ProcessResult } from "@agentswf/harness";
import type { SandboxProviders } from "@agentswf/sandbox";
import {
  createFakeSandboxProvider,
  FAKE_OCCUPANT_ENV,
  FAKE_SANDBOX_ENV,
} from "@agentswf/sandbox/testing";
import { writeJson } from "./files";
import { type Attach, openCommand } from "./open-command";
import { claimNow, releaseClaim, runOpenFile } from "./run-lock";
import { createRun, processStart, type Run, workDir } from "./runs";
import { createTempRunDirs, writeAttempt } from "./testing";
import type { Launch } from "./wake";

const runDirs = createTempRunDirs();
afterAll(() => runDirs.cleanup());

const AT = "2026-11-05T10:00:00.000Z";

type Fixture = { cwd: string; root: string; run: Run; home: string };

/** A finished run whose agent `fixer` ran claude in `cwd`; `home`, a codex agent's own, inside it. */
async function fixture(events = false): Promise<Fixture> {
  const cwd = runDirs.tempRunDir();
  const root = join(cwd, ".awf", "runs");
  const run = await createRun(root, {
    id: "r7",
    workflow: "review",
    argv: [],
    cwd,
    sandbox: null,
    ...(events ? { events: true } : {}),
  });
  const home = join(workDir(run.dir), "agents", "a1", "home");
  mkdirSync(home, { recursive: true });
  appendFileSync(
    join(run.dir, "run.jsonl"),
    `${JSON.stringify({ kind: "claimed", attempt: 1, at: AT })}\n`,
  );
  session(run, { agent: "fixer", session: "s-old", operation: "fixer.1" });
  session(run, { agent: "fixer", session: "s-1", operation: "fixer.2" });
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
function processes(seen: Seen, exitCode = 0, during?: () => Promise<void>) {
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
      await during?.();
      return 7;
    },
  };
}

async function open(
  f: Fixture,
  argv: string[],
  options: {
    stdin?: string;
    exitCode?: number;
    /** Run while the TUI is open. */
    during?: () => Promise<void>;
    launch?: Launch;
    environment?: Record<string, string>;
    providers?: SandboxProviders;
  } = {},
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
      environment: options.environment ?? {},
      ...(options.providers ? { providers: async () => options.providers! } : {}),
      ...processes(seen, options.exitCode, options.during),
      ...(options.launch ? { launch: options.launch } : {}),
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
  expect(fork!.env).toEqual({});
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
  expect(stderr).toEqual([
    "fixer · claude claude-sonnet-5-5 high · a copy of s-1",
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
    session: "copy-1",
    forkedFrom: "s-1",
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
  expect(terminal.code).toBe(2);
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
  expect(copy.stderr[0]).toBe("fixer · claude claude-sonnet-5-5 high · session copy-9");
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
    expect(result.seen.runs).toEqual([]);
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
  await refused(["review/r7", "fixer", "-p", "why?"], 2, /billed per token/);
  // Another agent's session is not fixer's to open, as a copy or otherwise.
  session(f.run, { agent: "reviewer", session: "rev-1", operation: "reviewer.1" });
  await refused(
    ["review/r7", "fixer", "--session", "rev-1"],
    1,
    /rev-1 is reviewer's session, not fixer's: awf open review\/r7 reviewer --session rev-1/,
  );
  // A home outside the run's folder is a sandbox's, which this line does not record.
  session(f.run, { agent: "boxed", session: "s-2", operation: "boxed.1", home: f.cwd });
  await op(f.run, "boxed.1", f.cwd, { harness: "claude", model: "m" });
  await refused(["review/r7", "boxed"], 3, /ran in a sandbox this run did not record/);
  session(f.run, {
    agent: "coder",
    session: "c-1",
    operation: "coder.1",
    home: f.home,
    harness: "codex",
  });
  await op(f.run, "coder.1", f.cwd, { harness: "codex", model: "m" });
  rmSync(f.home, { recursive: true });
  await refused(["review/r7", "coder"], 3, /own home .* is gone/);
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

const ALIVE = { pid: process.pid, processStart: processStart(process.pid)! };
const GONE = { pid: Bun.spawnSync(["true"]).pid, processStart: "2026-10-11T09:00:00Z" };

test("--no-fork opens the agent's own session, the run held until the harness exits", async () => {
  const f = await fixture();
  const file = runOpenFile(f.root, "review", "r7");
  let heldMeanwhile = false;
  let second: Awaited<ReturnType<typeof open>> | undefined;
  let copied: Awaited<ReturnType<typeof open>> | undefined;
  const { code, stderr, seen } = await open(f, ["review/r7", "fixer", "--no-fork"], {
    during: async () => {
      heldMeanwhile = existsSync(file);
      second = await open(f, ["review/r7", "fixer", "--no-fork"]);
      copied = await open(f, ["review/r7", "fixer"]);
    },
  });
  expect(code).toBe(7);
  expect(seen.runs).toEqual([]);
  expect(seen.attached[0]!.argv.slice(0, 3)).toEqual(["claude", "--resume", "s-1"]);
  expect(heldMeanwhile).toBe(true);
  expect(existsSync(file)).toBe(false);
  expect(second!.code).toBe(1);
  expect(second!.stderr.join("\n")).toMatch(
    new RegExp(`review/r7 is open in awf open --no-fork \\(pid ${process.pid}\\)`),
  );
  expect(second!.seen.attached).toEqual([]);
  expect(stderr).toEqual([
    "fixer · claude claude-sonnet-5-5 high · session s-1, the run held until you exit",
    `again: awf open review/r7 fixer --no-fork --run-root ${f.root}`,
  ]);
  // A copy opens while it is held.
  expect(copied!.code).toBe(7);
  expect(copied!.seen.runs[0]!.argv).toContain("--fork-session");
  // An earlier session of the agent's own opens itself, and is named to open again.
  const copy = await open(f, ["review/r7", "fixer", "--no-fork", "--session", "s-old"]);
  expect(copy.stderr.at(-1)).toBe(
    `again: awf open review/r7 fixer --no-fork --session s-old --run-root ${f.root}`,
  );
});

test("--no-fork is refused on a live run, and with a copy, which is the operator's already", async () => {
  const f = await fixture();
  const copy = await open(f, ["review/r7", "fixer", "--no-fork", "--session", "copy-9"]);
  expect(copy.code).toBe(2);
  expect(copy.stderr.join("\n")).toContain("open it without --no-fork");
  await writeAttempt(f.run, { ...ALIVE });
  const live = await open(f, ["review/r7", "fixer", "--no-fork"]);
  expect(live.code).toBe(1);
  expect(live.stderr.join("\n")).toContain(
    `review/r7 is running, and fixer's session may be written as you type; a copy opens anyway: awf open review/r7 fixer --run-root ${f.root}`,
  );
  expect(live.seen.attached).toEqual([]);
  expect(existsSync(runOpenFile(f.root, "review", "r7"))).toBe(false);
  // A copy opens on a live run.
  expect((await open(f, ["review/r7", "fixer"])).code).toBe(7);
});

test("a run with events is woken once the harness exits, as awf tick would", async () => {
  const f = await fixture(true);
  await writeAttempt(f.run, { ...GONE, ended: AT, outcome: "failed" });
  const launched: string[] = [];
  const launch: Launch = async (run) => {
    launched.push(run.record.id);
    await writeAttempt(run, { ...GONE });
  };
  const { stderr } = await open(f, ["review/r7", "fixer", "--no-fork"], { launch });
  expect(launched).toEqual(["r7"]);
  expect(stderr).toContain("woke review/r7: continued, for an attempt that failed");
  // A plain run is left as it was.
  const plain = await fixture();
  await writeAttempt(plain.run, { ...GONE, ended: AT, outcome: "failed" });
  const left: string[] = [];
  await open(plain, ["review/r7", "fixer", "--no-fork"], {
    launch: async (run) => void left.push(run.record.id),
  });
  expect(left).toEqual([]);
});

test("an agent's own home is its harness's, for the fork and the TUI alike", async () => {
  const f = await fixture();
  session(f.run, {
    agent: "coder",
    session: "c-1",
    operation: "coder.1",
    home: f.home,
    harness: "codex",
  });
  await op(f.run, "coder.1", f.cwd, { harness: "codex", model: "m" });
  const { seen } = await open(f, ["review/r7", "coder", "--session", "copy-c"]);
  expect(seen.attached[0]!.argv.slice(0, 3)).toEqual(["codex", "resume", "copy-c"]);
  expect(seen.attached[0]!.env).toEqual({ CODEX_HOME: f.home });
});

test("a forked agent's session line, which names no operation, opens on the agent's latest", async () => {
  const f = await fixture();
  session(f.run, { agent: "fixer", session: "s-fork" });
  await op(f.run, "fixer.3", f.cwd, { harness: "claude", model: "later", effort: "low" });
  const { seen } = await open(f, ["review/r7", "fixer"]);
  expect(seen.runs[0]!.argv.slice(3, 4)).toEqual(["s-fork"]);
  expect(seen.attached[0]!.argv.slice(3, 7)).toEqual(["--model", "later", "--effort", "low"]);
});

test("-p reads `-` as stdin, and a question that starts with a dash as its text", async () => {
  const f = await fixture();
  await op(f.run, "fixer.2", f.cwd, { harness: "claude", model: "m", metered: true });
  const dashed = await open(f, ["review/r7", "fixer", "-p", "-why?"]);
  expect(dashed.seen.runs[1]!.stdin).toBe("-why?");
  const piped = await open(f, ["review/r7", "fixer", "-p", "-"], { stdin: "piped" });
  expect(piped.seen.runs[1]!.stdin).toBe("piped");
  const optioned = await open(f, ["review/r7", "fixer", "-p", "--session", "copy-2"], {
    stdin: "piped too",
  });
  expect(optioned.seen.runs[0]!.stdin).toBe("piped too");
});

test("a held run is let go when the question fails, as when the harness exits", async () => {
  const f = await fixture();
  await op(f.run, "fixer.2", f.cwd, { harness: "claude", model: "m", metered: true });
  const result = await open(f, ["review/r7", "fixer", "--no-fork", "-p", "why?"], { exitCode: 1 });
  expect(result.code).toBe(1);
  expect(result.seen.runs[0]!.argv.slice(0, 4)).toEqual(["claude", "-p", "--resume", "s-1"]);
  expect(existsSync(runOpenFile(f.root, "review", "r7"))).toBe(false);
});

/** A sandboxed claude agent `boxed`: its home under the sandbox's directory, as a run records it. */
function boxed(f: Fixture) {
  const directory = join(f.cwd, "sandbox");
  const home = join(directory, "homes", "h1");
  mkdirSync(home, { recursive: true });
  const bin = join(f.cwd, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "claude"), "#!/bin/sh\n");
  chmodSync(join(bin, "claude"), 0o755);
  session(f.run, {
    agent: "boxed",
    session: "b-1",
    operation: "boxed.1",
    home,
    sandbox: {
      provider: "srt",
      spec: { cwd: f.cwd, read: [], write: [], network: [], srt: {} },
      directory,
    },
  });
  const fake = createFakeSandboxProvider();
  return {
    directory,
    home,
    fake,
    options: {
      environment: {
        PATH: `${bin}:/usr/bin:/bin`,
        CLAUDE_CODE_OAUTH_TOKEN: "tok",
        TERM: "xterm-test",
      },
      providers: { installed: { srt: fake.provider } } as SandboxProviders,
    },
  };
}

test("a sandboxed agent opens in its sandbox, reopened where it ran, on the operator's terminal", async () => {
  const f = await fixture();
  const box = boxed(f);
  await op(f.run, "boxed.1", f.cwd, { harness: "claude", model: "m" });
  const { code, stderr, seen } = await open(
    f,
    ["review/r7", "boxed", "--session", "copy-b"],
    box.options,
  );
  expect(code).toBe(7);
  expect(stderr[0]).toBe("boxed · claude m · srt · session copy-b");
  const [tui] = seen.attached;
  // The sandbox's own command, with exactly its environment: the operator's terminal kind in it.
  expect(tui!.exact).toBe(true);
  expect(tui!.env).toMatchObject({
    [FAKE_SANDBOX_ENV]: "awf-open",
    [FAKE_OCCUPANT_ENV]: box.home,
    TERM: "xterm-test",
    CLAUDE_CODE_OAUTH_TOKEN: "tok",
  });
  const launched = box.fake.events.flatMap((event) =>
    event.kind === "launch" ? [event.argv] : [],
  );
  expect(launched[0]!.slice(0, 3)).toEqual(["claude", "--resume", "copy-b"]);
  // Opened in the directory it ran in, the agent admitted with its home; all of it closed after.
  const kinds = box.fake.events.map((event) => event.kind);
  expect(kinds[0]).toBe("open");
  expect(box.fake.events.find((event) => event.kind === "admit")).toMatchObject({ home: box.home });
  expect(kinds.slice(-2)).toEqual(["release", "close"]);
  expect(existsSync(join(box.directory, "homes", "h1"))).toBe(true);
});

test("a sandboxed agent's copy is made inside its sandbox, and -p asks it there", async () => {
  const f = await fixture();
  const box = boxed(f);
  await op(f.run, "boxed.1", f.cwd, { harness: "claude", model: "m", metered: true });
  const { code, seen } = await open(f, ["review/r7", "boxed", "-p", "why?"], box.options);
  expect(code).toBe(0);
  const [fork, turn] = seen.runs as (ProcessInput & { group?: true })[];
  for (const inside of [fork!, turn!]) {
    expect(inside.group).toBe(true);
    expect(inside.env).toMatchObject({ [FAKE_OCCUPANT_ENV]: box.home });
  }
  const launched = box.fake.events.flatMap((event) =>
    event.kind === "launch" ? [event.argv] : [],
  );
  expect(launched[0]).toContain("--fork-session");
  expect(launched[1]!.slice(0, 4)).toEqual(["claude", "-p", "--resume", "copy-1"]);
});

test("an agent's skills on the host are given again, and refused once gone", async () => {
  const f = await fixture();
  const bundle = join(workDir(f.run.dir), "agents", "a2");
  const directory = join(bundle, ".claude", "skills");
  mkdirSync(join(directory, "probe"), { recursive: true });
  session(f.run, {
    agent: "skilled",
    session: "k-1",
    operation: "skilled.1",
    skills: { names: ["probe"], directory },
  });
  await op(f.run, "skilled.1", f.cwd, { harness: "claude", model: "m" });
  const { seen } = await open(f, ["review/r7", "skilled", "--session", "copy-k"]);
  expect(seen.attached[0]!.argv).toEqual(
    expect.arrayContaining(["--setting-sources", "project,local", "--add-dir", bundle]),
  );
  rmSync(directory, { recursive: true });
  const gone = await open(f, ["review/r7", "skilled"]);
  expect(gone.code).toBe(3);
  expect(gone.stderr.join("\n")).toContain(`skills were in ${directory}, which is gone`);
});

test("a sandboxed agent is refused on a live run, and while another awf open has its sandbox", async () => {
  const f = await fixture();
  const box = boxed(f);
  await op(f.run, "boxed.1", f.cwd, { harness: "claude", model: "m" });
  const held = await claimNow(`${box.directory}.open`);
  const busy = await open(f, ["review/r7", "boxed", "--session", "copy-b"], box.options);
  expect(busy.code).toBe(1);
  expect(busy.stderr.join("\n")).toContain("sandbox is open in another awf open");
  if ("held" in held) await releaseClaim(`${box.directory}.open`, held.held);
  await writeAttempt(f.run, { ...ALIVE });
  const live = await open(f, ["review/r7", "boxed", "--session", "copy-b"], box.options);
  expect(live.code).toBe(1);
  expect(live.stderr.join("\n")).toContain("sandbox is open in it");
  expect(box.fake.events).toEqual([]);
  // Let go after each, as after an open that ran.
  expect(existsSync(`${box.directory}.open`)).toBe(false);
});
