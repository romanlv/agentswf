import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REFUSAL_CODES, type RefusalCode, type RefusalJson } from "@agentswf/contract/records";
import {
  INBOX_CODES,
  type InboxCode,
  PARTICIPANT_CODES,
  type ParticipantCode,
} from "@agentswf/contract/wire";
import { COMMANDS, type CommandName, helpOf } from "./commands";
import { coordinatorSocketPath } from "./coordinator-socket";
import { runOperatorCli } from "./operator-cli";
import { createRun } from "./runs";
import { createTempRunDirs, eventProject, writeAttempt } from "./testing";

// The rule every `--json` command keeps: stdout's last line is a document whatever happened, and a
// failure's is a refusal from the published codes, its sentence still on stderr. Each row is a
// failure a command's help names.
//
// Not a row: `tick`'s exit 1, which prints its result, the runs it woke despite the others.

const dirs = createTempRunDirs();
let listening: { stop(closeActive?: boolean): void } | undefined;
afterAll(() => {
  listening?.stop(true);
  // Readable again, so the folder can go.
  chmodSync(join(fixture.sealed, ".awf", "runs", "dd-case", "r1", "attempts"), 0o700);
  chmodSync(join(fixture.root, ".awf", "runs", "plain", "closed", "ops"), 0o700);
  dirs.cleanup();
});

const EVENTS = `import { defineWorkflow } from "agentswf/workflow";
const Changes = { type: "object", properties: { case: { type: "string" } }, required: ["case"] };
export default defineWorkflow({
  meta: { name: "dd-case", description: "A case." },
  file: import.meta.path,
  events: { "dd.changes": Changes },
  starts: ["dd.changes"],
  async run() { return null; },
});
`;

const PLAIN = `import { defineWorkflow } from "agentswf/workflow";
export default defineWorkflow({
  meta: { name: "plain", description: "No events." },
  async run() { return null; },
});
`;

type Fixture = {
  root: string;
  file: string;
  plain: string;
  home: string;
  broken: string;
  /** A project whose event run `dd-case/r1` has an `attempts/` the system won't let awf read. */
  sealed: string;
  /** Where `r1`'s coordinator socket is, which closes on each request unanswered. */
  silent: string;
};
let fixture: Fixture;

beforeAll(async () => {
  const made = eventProject(dirs, "case.ts", EVENTS);
  const plain = join(made.root, "flows", "plain.ts");
  writeFileSync(plain, PLAIN);
  writeFileSync(join(made.root, "values.json"), "{}");
  // A project that declares agentswf and has none installed, with a run of its own.
  const broken = eventProject(dirs, "case.ts", EVENTS);
  writeFileSync(
    join(broken.root, "package.json"),
    JSON.stringify({ devDependencies: { agentswf: "9.9.9" } }),
  );
  await createRun(join(broken.root, ".awf", "runs"), {
    id: "r1",
    workflow: "dd-case",
    argv: [],
    cwd: broken.root,
    sandbox: null,
    events: true,
    file: broken.file,
  });
  const silent = dirs.tempRunDir();
  const sealed = eventProject(dirs, "case.ts", EVENTS);
  const sealedRun = await createRun(join(sealed.root, ".awf", "runs"), {
    id: "r1",
    workflow: "dd-case",
    argv: [],
    cwd: sealed.root,
    sandbox: null,
    events: true,
    file: sealed.file,
  });
  mkdirSync(join(sealedRun.dir, "attempts"), { recursive: true });
  chmodSync(join(sealedRun.dir, "attempts"), 0o000);
  fixture = { ...made, plain, broken: broken.root, silent, sealed: sealed.root };
  const runRoot = join(fixture.root, ".awf", "runs");
  await createRun(runRoot, {
    id: "r1",
    workflow: "dd-case",
    argv: [],
    cwd: fixture.root,
    sandbox: null,
  });
  // `r1` alone names a run of two workflows.
  await createRun(runRoot, {
    id: "r1",
    workflow: "other",
    argv: [],
    cwd: fixture.root,
    sandbox: null,
  });
  // A run that ended without connecting a participant.
  const done = await createRun(runRoot, {
    id: "done",
    workflow: "dd-case",
    argv: [],
    cwd: fixture.root,
    sandbox: null,
  });
  await writeAttempt(done, {
    pid: Bun.spawnSync(["true"]).pid,
    processStart: "2026-10-11T09:00:00Z",
    outcome: "completed",
  });
  // r1's coordinator, which takes a request and closes without an answer, as an older awf does.
  listening = Bun.listen({
    unix: coordinatorSocketPath(silent, join(runRoot, "dd-case", "r1")),
    socket: { data: (socket) => void socket.end() },
  });
  // A plain run whose run.jsonl can't be read.
  const torn = await createRun(runRoot, {
    id: "torn",
    workflow: "plain",
    argv: [],
    cwd: fixture.root,
    sandbox: null,
  });
  writeFileSync(join(torn.dir, "run.jsonl"), "garbage\n");
  // And one whose run.jsonl is JSON, but no line this awf knows.
  const shapeless = await createRun(runRoot, {
    id: "shapeless",
    workflow: "plain",
    argv: [],
    cwd: fixture.root,
    sandbox: null,
  });
  writeFileSync(join(shapeless.dir, "run.jsonl"), "{}\n");
  // And one whose run.jsonl the system won't let awf read.
  const locked = await createRun(runRoot, {
    id: "locked",
    workflow: "plain",
    argv: [],
    cwd: fixture.root,
    sandbox: null,
  });
  writeFileSync(join(locked.dir, "run.jsonl"), "");
  chmodSync(join(locked.dir, "run.jsonl"), 0o000);
  // And one whose ops/ the system won't let a new attempt list.
  const closed = await createRun(runRoot, {
    id: "closed",
    workflow: "plain",
    argv: [],
    cwd: fixture.root,
    sandbox: null,
  });
  mkdirSync(join(closed.dir, "ops"));
  chmodSync(join(closed.dir, "ops"), 0o000);
  // A run whose record this awf can't read: one made before `run.json` had a format.
  mkdirSync(join(runRoot, "dd-case", "old"), { recursive: true });
  writeFileSync(join(runRoot, "dd-case", "old", "run.json"), JSON.stringify({ id: "old" }));
});

/**
 * The codes a command's help lists, after "code says why": `the participant's` stands for
 * `PARTICIPANT_CODES`.
 */
function listed(command: CommandName): string[] {
  const help = helpOf(command).split(/\s+/).join(" ");
  const list = /code says why(?: it failed)?: ([^.;]+)[.;]/.exec(help)?.[1];
  if (!list) return [];
  return list
    .split(/, or |, | or /)
    .flatMap((word) => (word === "the participant's" ? [...PARTICIPANT_CODES] : [word]));
}

const PUBLISHED = new Set<string>([...REFUSAL_CODES, ...PARTICIPANT_CODES, ...INBOX_CODES]);

type Row = {
  command: CommandName;
  failure: string;
  argv: (f: Fixture) => string[];
  code: RefusalCode | ParticipantCode | InboxCode;
  exit: number;
  /** The command's own `v`, which its refusal carries. */
  v: number;
  /** What the command says, on stderr or in its document, so a row fails the way it names. */
  says: RegExp;
  /** Run as after a Ctrl-C. */
  cancelled?: true;
  /** Where coordinator sockets are, for a row that reaches `r1`'s silent one. */
  coordinators?: (f: Fixture) => string;
};

const ROWS: Row[] = [
  {
    command: "emit",
    failure: "no run named",
    argv: () => [],
    code: "usage",
    exit: 2,
    v: 1,
    says: /name the run/,
  },
  {
    command: "emit",
    failure: "no such run",
    argv: () => ["dd-case/nope", "dd.changes", "{}"],
    code: "no-run",
    exit: 1,
    v: 1,
    says: /no run dd-case\/nope/,
  },
  {
    command: "emit",
    failure: "a run it can't read",
    argv: () => ["dd-case/old", "slack:reply", "{}"],
    code: "unreachable",
    exit: 1,
    v: 1,
    says: /dd-case\/old/,
  },
  {
    command: "emit",
    failure: "a run whose files the system won't let it read",
    argv: (f) => ["dd-case/r1", "slack:reply", '{"text":"x"}', "--cwd", f.sealed],
    code: "unreachable",
    exit: 1,
    v: 1,
    says: /EACCES/,
  },
  {
    command: "emit",
    failure: "a ref no run could have",
    argv: () => ["dd-case/a b", "slack:reply", "{}"],
    code: "id",
    exit: 1,
    v: 1,
    says: /no run dd-case\/a b/,
  },
  {
    command: "emit",
    failure: "a target that isn't there",
    argv: (f) => ["--target", join(f.root, "missing.ts"), "--id", "k", "dd.changes", "{}"],
    code: "file",
    exit: 1,
    v: 1,
    says: /workflow file not found/,
  },
  {
    command: "emit",
    failure: "a workflow without events",
    argv: (f) => ["--target", f.plain, "--id", "k", "dd.changes", "{}"],
    code: "event",
    exit: 2,
    v: 1,
    says: /declares no events/,
  },
  {
    command: "emit",
    failure: "an event the workflow doesn't take",
    argv: (f) => ["--target", f.file, "--id", "k", "dd.other", "{}"],
    code: "event",
    exit: 2,
    v: 1,
    says: /declares no event dd\.other/,
  },
  {
    command: "emit",
    failure: "an event id that isn't one",
    argv: (f) => [
      "--target",
      f.file,
      "--id",
      "k",
      "dd.changes",
      '{"case":"k"}',
      "--event-id",
      "a b",
    ],
    code: "id",
    exit: 2,
    v: 1,
    says: /the id "a b"/,
  },
  {
    command: "runs",
    failure: "a bad option",
    argv: () => ["--limit", "x"],
    code: "usage",
    exit: 2,
    v: 1,
    says: /--limit needs a whole number/,
  },
  {
    command: "runs",
    failure: "no such run",
    argv: () => ["dd-case/nope"],
    code: "no-run",
    exit: 1,
    v: 2,
    says: /no run dd-case\/nope/,
  },
  {
    command: "runs",
    failure: "a bad option after a run",
    argv: () => ["--bogus", "dd-case/r1"],
    code: "usage",
    exit: 2,
    v: 2,
    says: /unknown option: --bogus/,
  },
  {
    command: "runs",
    failure: "a ref no run could have",
    argv: () => ["dd-case/a b"],
    code: "id",
    exit: 1,
    v: 2,
    says: /no run dd-case\/a b/,
  },
  {
    command: "runs",
    failure: "an id two workflows have",
    argv: () => ["r1"],
    code: "ambiguous",
    exit: 1,
    v: 2,
    says: /more than one workflow/,
  },
  {
    command: "runs",
    failure: "a bare id no run could have",
    argv: () => ["a b"],
    code: "id",
    exit: 1,
    v: 2,
    says: /no run a b: /,
  },
  {
    command: "logs",
    failure: "a ref no run could have",
    argv: () => ["dd-case/a b"],
    code: "id",
    exit: 1,
    v: 1,
    says: /no run dd-case\/a b/,
  },
  {
    command: "logs",
    failure: "an id two workflows have",
    argv: () => ["r1"],
    code: "ambiguous",
    exit: 1,
    v: 1,
    says: /more than one workflow/,
  },
  {
    command: "runs",
    failure: "a run it can't read",
    argv: () => ["dd-case/old"],
    code: "unreachable",
    exit: 3,
    v: 2,
    says: /dd-case\/old/,
  },
  {
    command: "logs",
    failure: "a bad option",
    argv: () => ["--limit", "x"],
    code: "usage",
    exit: 2,
    v: 1,
    says: /--limit needs a whole number/,
  },
  {
    command: "logs",
    failure: "no such run",
    argv: () => ["dd-case/nope"],
    code: "no-run",
    exit: 1,
    v: 1,
    says: /no run dd-case\/nope/,
  },
  {
    command: "logs",
    failure: "a run it can't read",
    argv: () => ["dd-case/old"],
    code: "unreachable",
    exit: 3,
    v: 1,
    says: /dd-case\/old/,
  },
  {
    command: "logs",
    failure: "a cursor that isn't one",
    argv: () => ["dd-case/r1", "--after", "nope"],
    code: "cursor",
    exit: 1,
    v: 1,
    says: /cursor nope does not fit/,
  },
  {
    command: "logs",
    failure: "a handle that isn't one",
    argv: () => ["dd-case/r1", "@nope"],
    code: "cursor",
    exit: 1,
    v: 1,
    says: /nope/,
  },
  {
    command: "tick",
    failure: "a bad option",
    argv: () => ["--nope"],
    code: "usage",
    exit: 2,
    v: 1,
    says: /tick takes no --nope/,
  },
  {
    command: "run",
    failure: "no workflow named",
    argv: () => [],
    code: "usage",
    exit: 2,
    v: 1,
    says: /run needs one workflow file/,
  },
  {
    command: "run",
    failure: "a workflow file that isn't there",
    argv: (f) => [join(f.root, "missing.ts")],
    code: "file",
    exit: 2,
    v: 1,
    says: /workflow file not found/,
  },
  {
    command: "run",
    failure: "a run named where a file goes",
    argv: () => ["dd-case/r1"],
    code: "file",
    exit: 2,
    v: 1,
    says: /is not a workflow file/,
  },
  {
    command: "run",
    failure: "arguments the workflow refuses",
    // The --json the guard adds goes after --, to the workflow, as this one does.
    argv: (f) => [f.plain, "--json", "--", "extra"],
    code: "prepare",
    exit: 2,
    v: 1,
    says: /prepare/,
  },
  {
    command: "run",
    failure: "a workflow with events and no run named",
    argv: (f) => [f.file],
    code: "no-id",
    exit: 2,
    v: 1,
    says: /named by its id/,
  },
  {
    command: "run",
    failure: "options a workflow with events doesn't keep",
    argv: (f) => [f.file, "--id", "k", "--timeout", "1m"],
    code: "usage",
    exit: 2,
    v: 1,
    says: /takes no --timeout/,
  },
  {
    command: "run",
    failure: "--here, which prints no document",
    argv: (f) => [f.plain, "--here"],
    code: "usage",
    exit: 2,
    v: 1,
    says: /--here prints what the calling agent does next/,
  },
  {
    command: "run",
    failure: "a Ctrl-C before it starts",
    argv: (f) => [f.plain],
    code: "not-started",
    exit: 130,
    v: 1,
    says: /cancelled before it started/,
    cancelled: true,
  },
  {
    command: "run",
    failure: "a continue of no run",
    argv: (f) => [f.plain, "--id", "nope", "--continue"],
    code: "no-run",
    exit: 2,
    v: 1,
    says: /no run nope of plain/,
  },
  {
    command: "run",
    failure: "a continue given arguments",
    argv: (f) => [f.file, "--id", "done", "--continue", "--json", "--", "more"],
    code: "other-args",
    exit: 2,
    v: 1,
    says: /a continue takes no arguments/,
  },
  {
    command: "run",
    failure: "a continue given --values and arguments",
    argv: (f) => [
      f.file,
      "--id",
      "done",
      "--continue",
      "--values",
      join(f.root, "values.json"),
      "--from-stage",
      "s1",
      "--json",
      "--",
      "more",
    ],
    code: "usage",
    exit: 2,
    v: 1,
    says: /takes no --values/,
  },
  {
    command: "run",
    failure: "a continue of a run whose run.jsonl can't be read",
    argv: (f) => [f.plain, "--id", "torn", "--continue"],
    code: "unreachable",
    exit: 2,
    v: 1,
    says: /run.jsonl line 1: not JSON/,
  },
  {
    command: "run",
    failure: "a continue of a run whose run.jsonl holds no line awf knows",
    argv: (f) => [f.plain, "--id", "shapeless", "--continue"],
    code: "unreachable",
    exit: 2,
    v: 1,
    says: /run.jsonl line 1/,
  },
  {
    command: "run",
    failure: "a continue of a run whose run.jsonl the system won't let it read",
    argv: (f) => [f.plain, "--id", "locked", "--continue"],
    code: "unreachable",
    exit: 2,
    v: 1,
    says: /EACCES/,
  },
  {
    command: "run",
    failure: "an --id the grammar refuses",
    argv: (f) => [f.plain, "--id", "Bad Id"],
    code: "id",
    exit: 2,
    v: 1,
    says: /--id: /,
  },
  {
    command: "send",
    failure: "an --event-id the grammar refuses",
    argv: () => ["dd-case/r1", "--as", "slack", "--event-id", "a b", "hi"],
    code: "id",
    exit: 2,
    v: 3,
    says: /--event-id a b/,
  },
  {
    command: "run",
    failure: "a continue whose ops/ the system won't let it list",
    argv: (f) => [f.plain, "--id", "closed", "--continue"],
    code: "unreachable",
    exit: 2,
    v: 1,
    says: /ops\/ was not listed/,
  },
  {
    command: "run",
    failure: "a continue of a run that completed",
    argv: (f) => [f.file, "--id", "done", "--continue"],
    code: "not-started",
    exit: 2,
    v: 1,
    says: /done/,
  },
  {
    command: "allowance",
    failure: "no such harness",
    argv: () => ["nope"],
    code: "usage",
    exit: 2,
    v: 1,
    says: /unknown harness or option: nope/,
  },
  {
    command: "reply",
    failure: "no run named",
    argv: () => [],
    code: "usage",
    exit: 2,
    v: 3,
    says: /reply needs a run/,
  },
  {
    command: "reply",
    failure: "no such run",
    argv: () => ["dd-case/nope", "reviewer", "--as", "slack", "hi"],
    code: "no-run",
    exit: 1,
    v: 3,
    says: /no run dd-case\/nope/,
  },
  {
    command: "reply",
    failure: "a run it can't read",
    argv: () => ["dd-case/old", "reviewer", "--as", "slack", "hi"],
    code: "unreachable",
    exit: 3,
    v: 3,
    says: /dd-case\/old/,
  },
  {
    command: "reply",
    failure: "no such participant",
    argv: () => ["dd-case/r1", "reviewer", "--as", "slack", "hi"],
    code: "no-participant",
    exit: 1,
    v: 3,
    says: /slack/,
  },
  {
    command: "reply",
    failure: "a run that doesn't answer",
    argv: () => ["dd-case/r1", "reviewer", "--as", "slack", "hi"],
    code: "unreachable",
    exit: 3,
    v: 3,
    says: /did not answer/,
    coordinators: (f) => f.silent,
  },
  {
    command: "send",
    failure: "a run that doesn't answer",
    argv: () => ["dd-case/r1", "reviewer", "--as", "slack", "hi"],
    code: "unreachable",
    exit: 3,
    v: 3,
    says: /did not answer/,
    coordinators: (f) => f.silent,
  },
  {
    command: "send",
    failure: "no run named",
    argv: () => [],
    code: "usage",
    exit: 2,
    v: 3,
    says: /send needs a run/,
  },
  {
    command: "send",
    failure: "no such run",
    argv: () => ["dd-case/nope", "reviewer", "--as", "slack", "hi"],
    code: "no-run",
    exit: 1,
    v: 3,
    says: /no run dd-case\/nope/,
  },
  {
    command: "send",
    failure: "no such participant",
    argv: () => ["dd-case/r1", "reviewer", "--as", "slack", "hi"],
    code: "no-participant",
    exit: 1,
    v: 3,
    says: /slack/,
  },
  {
    command: "inbox",
    failure: "a bad option",
    argv: () => ["--wait", "x"],
    code: "usage",
    exit: 2,
    v: 2,
    says: /--wait takes a duration/,
  },
  {
    command: "inbox",
    failure: "no such run",
    argv: () => ["dd-case/nope"],
    code: "no-run",
    exit: 1,
    v: 2,
    says: /no run dd-case\/nope/,
  },
  {
    command: "inbox",
    failure: "a run it can't read",
    argv: () => ["dd-case/old"],
    code: "unreachable",
    exit: 3,
    v: 2,
    says: /dd-case\/old/,
  },
  {
    command: "inbox",
    failure: "no such participant",
    argv: () => ["dd-case/done", "--as", "slack"],
    code: "no-participant",
    exit: 1,
    v: 2,
    says: /slack/,
  },
  {
    command: "inbox",
    failure: "a cursor that isn't one",
    argv: () => ["--after", "nope"],
    code: "cursor",
    exit: 1,
    v: 2,
    says: /cursor nope/,
  },
  {
    command: "emit",
    failure: "a project whose agentswf isn't installed",
    argv: (f) => ["dd-case/r1", "slack:reply", "{}", "--cwd", f.broken],
    code: "no-engine",
    exit: 1,
    v: 1,
    says: /declares agentswf/,
  },
  {
    command: "runs",
    failure: "a project whose agentswf isn't installed",
    argv: (f) => ["dd-case/r1", "--cwd", f.broken],
    code: "no-engine",
    exit: 3,
    v: 2,
    says: /declares agentswf/,
  },
  {
    command: "logs",
    failure: "a project whose agentswf isn't installed",
    argv: (f) => ["dd-case/r1", "--cwd", f.broken],
    code: "no-engine",
    exit: 3,
    v: 1,
    says: /declares agentswf/,
  },
  {
    command: "inbox",
    failure: "a project whose agentswf isn't installed",
    argv: (f) => ["dd-case/r1", "--cwd", f.broken],
    code: "no-engine",
    exit: 3,
    v: 2,
    says: /declares agentswf/,
  },
  {
    command: "reply",
    failure: "a project whose agentswf isn't installed",
    argv: (f) => ["dd-case/r1", "reviewer", "--as", "slack", "hi", "--cwd", f.broken],
    code: "no-engine",
    exit: 3,
    v: 3,
    says: /declares agentswf/,
  },
  {
    command: "run",
    failure: "a project whose agentswf isn't installed",
    argv: (f) => [join(f.broken, "flows", "case.ts")],
    code: "no-engine",
    exit: 2,
    v: 1,
    says: /declares agentswf/,
  },
];

const nameOf = (row: Row) => `${row.command}: ${row.failure}`;

async function attempt(row: Row) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exit = await runOperatorCli([row.command, ...row.argv(fixture), "--json"], {
    cwd: fixture.root,
    home: fixture.home,
    // Only what a command needs: an `AWF_*` of the shell running the tests changes no row.
    environment: {
      PATH: process.env.PATH,
      HOME: fixture.home,
      ...(row.coordinators ? { AWF_COORDINATOR_DIR: row.coordinators(fixture) } : {}),
    },
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
    stdin: async () => "hi",
    ...(row.cancelled ? { signal: AbortSignal.abort("SIGINT") } : {}),
    readAllowance: async () => {
      throw new Error("no harness is read here");
    },
    launch: async () => {
      throw new Error("no attempt is launched here");
    },
  });
  const last = stdout
    .flatMap((text) => text.split("\n"))
    .filter((line) => line.trim() !== "")
    .at(-1);
  let document: unknown;
  try {
    document = last === undefined ? undefined : JSON.parse(last);
  } catch {
    document = last;
  }
  return { exit, document, stdout, stderr: stderr.join("\n") };
}

/** One document: `inbox` prints a line per item and its refusal last; the rest, one value. */
function oneDocument(command: CommandName, stdout: string[]): boolean {
  try {
    if (command !== "inbox") return JSON.parse(stdout.join("\n")) !== undefined;
    const lines = stdout.flatMap((text) => text.split("\n")).filter((line) => line !== "");
    const coded = lines.map((line) => "code" in (JSON.parse(line) as object));
    return coded.slice(0, -1).every((each) => !each);
  } catch {
    return false;
  }
}

function conforms(row: Row, got: Awaited<ReturnType<typeof attempt>>): boolean {
  const refusal = got.document as Partial<RefusalJson<string>> | undefined;
  return (
    got.exit === row.exit &&
    typeof refusal === "object" &&
    refusal !== null &&
    refusal.v === row.v &&
    refusal.code === row.code &&
    typeof refusal.error === "string" &&
    refusal.error !== "" &&
    !refusal.error.startsWith("awf: ") &&
    got.stderr.includes(refusal.error) &&
    oneDocument(row.command, got.stdout)
  );
}

describe("every --json failure prints a refusal last", () => {
  for (const row of ROWS) {
    const name = nameOf(row);
    test(`${name} → ${row.code}, exit ${row.exit}`, async () => {
      const got = await attempt(row);
      expect(`${got.stderr}\n${JSON.stringify(got.document)}`).toMatch(row.says);
      expect({ exit: got.exit, document: got.document }).toMatchObject({
        exit: row.exit,
        document: { v: row.v, code: row.code },
      });
      expect(conforms(row, got)).toBe(true);
    });
  }
});

test("every command whose help offers --json has a row, and only those", () => {
  const offering = COMMANDS.flatMap((entry) =>
    entry.help.includes("--json") ? (Object.keys(entry.commands) as CommandName[]) : [],
  );
  expect([...new Set(ROWS.map((row) => row.command))].sort()).toEqual(offering.sort());
});

test("each row's code is one its command's help lists, and each listed code is published", () => {
  for (const row of ROWS)
    expect([nameOf(row), listed(row.command).includes(row.code)]).toEqual([nameOf(row), true]);
  for (const command of new Set(ROWS.map((row) => row.command)))
    expect([command, listed(command).filter((code) => !PUBLISHED.has(code))]).toEqual([
      command,
      [],
    ]);
  const names = ROWS.map(nameOf);
  expect(new Set(names).size).toBe(names.length);
});

test("a failure no command foresaw still ends stdout with a refusal, internal-error", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exit = await runOperatorCli(["allowance", "claude", "--json"], {
    cwd: fixture.root,
    home: fixture.home,
    environment: { PATH: process.env.PATH, HOME: fixture.home },
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
    // Never reached, as the clock is read first: no harness is ever asked from a test.
    readAllowance: async () => {
      throw new Error("no harness is read here");
    },
    now: () => {
      throw new Error("the clock broke");
    },
  });
  expect({ exit, stdout, said: stderr[0] }).toEqual({
    exit: 1,
    stdout: [JSON.stringify({ v: 1, code: "internal-error", error: "the clock broke" })],
    said: "awf: the clock broke",
  });
  // And its stack, the only clue to a failure no command foresaw.
  expect(stderr[1]).toContain("the clock broke");
});

test("a run that starts and fails prints its result, out.json, not a refusal", async () => {
  // A project of its own: Bun's resolver doesn't see a file written into a folder it has read.
  const {
    root,
    file: failing,
    home,
  } = eventProject(
    dirs,
    "fails.ts",
    `import { defineWorkflow } from "agentswf/workflow";
export default defineWorkflow({
  meta: { name: "fails", description: "Fails." },
  async run() { throw new Error("it broke"); },
});
`,
  );
  const stdout: string[] = [];
  const exit = await runOperatorCli(["run", failing, "--cwd", root, "--json"], {
    home,
    environment: { PATH: process.env.PATH, HOME: home },
    stdout: (text) => stdout.push(text),
    stderr: () => undefined,
  });
  const result = JSON.parse(stdout.join("\n")) as Record<string, unknown>;
  expect({ exit, coded: "code" in result, ref: result.ref }).toEqual({
    exit: 1,
    coded: false,
    ref: expect.stringMatching(/^fails\//),
  });
});
