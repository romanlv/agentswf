import { afterAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InboxItemJson } from "@agentswf/contract/records";
import { deprecationLine } from "./deprecations";
import { emitCommand } from "./emit-command";
import { readIn } from "./in-lines";
import { runOperatorCli } from "./operator-cli";
import { findRunByRef } from "./run-state";
import { createRun, openRun, readAttempts } from "./runs";
import { createTempRunDirs, eventProject, until, writeAttempt } from "./testing";

const dirs = createTempRunDirs();
afterAll(() => dirs.cleanup());

// A case run whose thread goes to its code: each reply is written down and answered with a post.
// It sleeps a moment first at each wake, so a reply sent then finds it live.
const WORKFLOW = `import { appendFileSync } from "node:fs";
import { defineWorkflow } from "agentswf/workflow";
const Changes = { type: "object", properties: { case: { type: "string" } }, required: ["case"] };
export default defineWorkflow({
  meta: { name: "e2e-thread", description: "Answers its thread." },
  file: import.meta.path,
  events: { "dd.changes": Changes },
  starts: ["dd.changes"],
  async run(workflow) {
    const thread = await workflow.participants.connect({ key: "thread", to: "code", labels: { title: "kombo" } });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    for (;;)
      for (const e of await workflow.receive({ label: "listening" }))
        if (thread.is(e)) {
          appendFileSync(new URL("../replies.txt", import.meta.url).pathname, e.id + " " + e.data.text + " " + (e.data.author ?? "") + "\\n");
          await workflow.stage("answer-" + e.id, () => thread.post("got: " + e.data.text));
        }
  },
});
`;

test('awf send --event-id, deprecated, still delivers a to: "code" reply through awf emit, live or parked, once', async () => {
  const { root, file, home } = eventProject(dirs, "thread.ts", WORKFLOW);
  const environment = { ...process.env, HOME: home };
  const out: string[] = [];
  const err: string[] = [];
  const io = { stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t) };
  expect(
    await emitCommand(
      ["--target", file, "--id", "k", "dd.changes", '{"case":"k"}'],
      dirs.tempRunDir(),
      io,
      {
        home,
        environment,
      },
    ),
  ).toBe(0);
  const run = await openRun(join(root, ".awf", "runs"), "e2e-thread", "k");
  const send = (id: string, text: string, ...extra: string[]) =>
    runOperatorCli(["send", "e2e-thread/k", "--as", "thread", "--event-id", id, ...extra, text], {
      // Found through ~/.awf/projects, from a directory with no runs.
      cwd: dirs.tempRunDir(),
      home,
      environment,
      stdout: (t) => out.push(t),
      stderr: (t) => err.push(t),
    });
  // Once it has connected its thread, which a chat host opens only then, and while it sleeps at its
  // first wake: live, so nudged.
  await until(async () =>
    (
      await Bun.file(join(run.dir, "log.jsonl"))
        .text()
        .catch(() => "")
    ).includes('"participant-connected"'),
  );
  expect(await send("1729.001", "is it the index?", "--author", "engineer")).toBe(0);
  await until(async () => (await readAttempts(run)).at(-1)?.outcome === "parked");
  // Parked: continued.
  expect(await send("1729.002", "never mind")).toBe(0);
  await until(async () => (await readAttempts(run)).length === 2);
  await until(async () => (await readAttempts(run)).at(-1)?.outcome === "parked");
  // Delivered twice, as a chat host may: appended once.
  expect(await send("1729.002", "never mind")).toBe(0);
  expect(out).toEqual([
    "accepted e2e-thread/k: started",
    "accepted e2e-thread/k: nudged",
    "accepted e2e-thread/k: continued",
    // Parked with nothing new to take: not continued again.
    "duplicate e2e-thread/k: nothing-due",
  ]);
  const replies = await readIn(run.dir);
  expect(replies.filter((e) => e.name === "participant:reply")).toHaveLength(2);
  expect(await Bun.file(join(root, "replies.txt")).text()).toBe(
    "1729.001 is it the index? engineer\n1729.002 never mind \n",
  );
  // Its posts are in awf inbox for the thread, the parked run's participant still there.
  const inbox: string[] = [];
  await runOperatorCli(
    // From a directory with no runs: found through ~/.awf/projects.
    ["inbox", "e2e-thread/k", "--as", "thread", "--json"],
    {
      cwd: dirs.tempRunDir(),
      home,
      environment,
      stdout: (t) => inbox.push(t),
      stderr: (t) => err.push(t),
    },
  );
  const items = inbox
    .join("\n")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as InboxItemJson);
  expect(items.filter((item) => item.kind === "post")).toMatchObject([
    { id: "1.p1", text: "got: is it the index?", labels: { title: "kombo" } },
    { id: "2.p1", text: "got: never mind", labels: { title: "kombo" } },
  ]);
  // The continue connected the same participant to its code again.
  const connected = (await Bun.file(join(run.dir, "log.jsonl")).text())
    .split("\n")
    .filter((line) => line.includes('"participant-connected"'))
    .map((line) => JSON.parse(line) as { attempt: number; to?: string });
  expect(connected.map((line) => [line.attempt, line.to])).toEqual([
    [1, "code"],
    [2, "code"],
  ]);
  // A participant the run doesn't route to its code is refused, said on stdout under --json too.
  const refused: string[] = [];
  expect(
    await runOperatorCli(
      ["send", "e2e-thread/k", "--as", "other", "--event-id", "1729.003", "--json", "hi"],
      {
        cwd: dirs.tempRunDir(),
        home,
        environment,
        stdout: (t) => refused.push(t),
        stderr: () => undefined,
      },
    ),
  ).toBe(1);
  expect(JSON.parse(refused[0]!)).toMatchObject({ v: 3, code: "no-participant" });
  // Each send says once that it is deprecated, naming awf emit.
  expect(err).toEqual(Array(3).fill(deprecationLine("send-event-id")));
  expect(err[0]).toContain("awf emit {run} {key}:reply");
}, 60_000);

// The same case run, its thread's replies declared rather than routed: `lead` is connected but not
// declared, so its messages are its agents', never the code's.
const DECLARED = `import { appendFileSync } from "node:fs";
import { defineWorkflow, ParticipantReply } from "agentswf/workflow";
const Changes = { type: "object", properties: { case: { type: "string" } }, required: ["case"] };
export default defineWorkflow({
  meta: { name: "e2e-declared", description: "Answers its thread." },
  file: import.meta.path,
  events: { "dd.changes": Changes, "thread:reply": ParticipantReply, "ghost:reply": ParticipantReply },
  starts: ["dd.changes"],
  async run(workflow) {
    const thread = await workflow.participants.connect({ key: "thread" });
    await workflow.participants.connect({ key: "lead" });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    for (;;)
      for (const e of await workflow.receive({ label: "listening" }))
        if (e.name === "thread:reply") {
          appendFileSync(new URL("../replies.txt", import.meta.url).pathname, [e.name, e.from, e.id, e.data.text, e.data.author ?? ""].join(" ") + "\\n");
          await workflow.stage("answer-" + e.id, () => thread.post("got: " + e.data.text));
        }
  },
});
`;

test("a participant declared as thread:reply replies by awf emit, received under that name, live or parked, once", async () => {
  const { root, file, home } = eventProject(dirs, "declared.ts", DECLARED);
  const environment = { ...process.env, HOME: home };
  const out: string[] = [];
  const err: string[] = [];
  const cli = (args: string[]) =>
    runOperatorCli(["emit", ...args], {
      // Found through ~/.awf/projects, from a directory with no runs.
      cwd: dirs.tempRunDir(),
      home,
      environment,
      stdout: (t) => out.push(t),
      stderr: (t) => err.push(t),
    });
  expect(await cli(["--target", file, "--id", "k", "dd.changes", '{"case":"k"}'])).toBe(0);
  const run = await openRun(join(root, ".awf", "runs"), "e2e-declared", "k");
  const reply = (id: string, data: object) =>
    cli(["e2e-declared/k", "thread:reply", JSON.stringify(data), "--event-id", id]);
  await until(async () =>
    (
      await Bun.file(join(run.dir, "log.jsonl"))
        .text()
        .catch(() => "")
    ).includes('"participant":"lead"'),
  );
  expect(await reply("1729.001", { text: "is it the index?", author: "engineer" })).toBe(0);
  await until(async () => (await readAttempts(run)).at(-1)?.outcome === "parked");
  expect(await reply("1729.002", { text: "never mind" })).toBe(0);
  await until(async () => (await readAttempts(run)).length === 2);
  await until(async () => (await readAttempts(run)).at(-1)?.outcome === "parked");
  expect(await reply("1729.002", { text: "never mind" })).toBe(0);
  expect(out).toEqual([
    "accepted e2e-declared/k: started",
    "accepted e2e-declared/k: nudged",
    "accepted e2e-declared/k: continued",
    "duplicate e2e-declared/k: nothing-due",
  ]);
  expect(await Bun.file(join(root, "replies.txt")).text()).toBe(
    "thread:reply thread 1729.001 is it the index? engineer\nthread:reply thread 1729.002 never mind \n",
  );
  // `in.jsonl` keeps awf's record name, from the participant's key.
  const recorded = await readIn(run.dir);
  expect(recorded.filter((e) => e.name === "participant:reply").map((e) => [e.id, e.from])).toEqual(
    [
      ["1729.001", "thread"],
      ["1729.002", "thread"],
    ],
  );
  // Its replies go to the code; lead's, undeclared, to agents.
  const connected = (await Bun.file(join(run.dir, "log.jsonl")).text())
    .split("\n")
    .filter((line) => line.includes('"participant-connected"'))
    .map((line) => JSON.parse(line) as { attempt: number; participant: string; to?: string });
  expect(connected.map((line) => [line.attempt, line.participant, line.to])).toEqual([
    [1, "thread", "code"],
    [1, "lead", undefined],
    [2, "thread", "code"],
    [2, "lead", undefined],
  ]);
  expect(err).toEqual([]);
  // Refused, each a usage error naming why: an undeclared participant, data its schema refuses,
  // and an end, which only awf sends.
  const refusals: [string[], string][] = [
    [
      ["lead:reply", '{"text":"hi"}'],
      "e2e-declared declares no event lead:reply; its events are dd.changes, thread:reply, ghost:reply",
    ],
    [["thread:reply", '{"body":"hi"}'], "thread:reply's data does not fit its schema"],
    [["thread:ended", "{}"], "not thread:ended"],
    [["dd.changes", '{"case":"k"}'], "the workflow's own events go by --target"],
  ];
  for (const [args, message] of refusals) {
    err.length = 0;
    expect(await cli(["e2e-declared/k", ...args, "--event-id", "1729.009"])).toBe(2);
    expect(err.join("\n")).toContain(message);
  }
  // The --target form takes only the workflow's own events, and points to the run's ref.
  err.length = 0;
  expect(
    await cli(["--target", file, "--id", "k", "thread:reply", '{"text":"hi"}', "--event-id", "x1"]),
  ).toBe(2);
  expect(err.join("\n")).toContain("awf emit e2e-declared/{id} thread:reply");
  // A declared participant the run never connected: send refuses it, as it always has.
  const refused: string[] = [];
  expect(
    await runOperatorCli(
      ["send", "e2e-declared/k", "--as", "ghost", "--event-id", "x2", "--json", "boo"],
      {
        cwd: dirs.tempRunDir(),
        home,
        environment,
        stdout: (t) => refused.push(t),
        stderr: () => {},
      },
    ),
  ).toBe(1);
  expect(JSON.parse(refused[0]!)).toMatchObject({ code: "no-participant" });
  expect(recorded.length, "nothing refused was appended").toBe((await readIn(run.dir)).length);
  // Checked against the file the run's last attempt ran: one that no longer declares the reply
  // refuses it (2); one that is gone can't be loaded (1).
  // (Runs of their own, each recording a file this process hasn't imported.)
  const runOf = async (id: string, recorded: string) =>
    createRun(join(root, ".awf", "runs"), {
      id,
      workflow: "e2e-declared",
      argv: [],
      cwd: root,
      sandbox: null,
      events: true,
      file: recorded,
    });
  const undeclaring = join(root, "flows", "undeclaring.ts");
  writeFileSync(undeclaring, DECLARED.replace(', "thread:reply": ParticipantReply', ""));
  await runOf("changed", undeclaring);
  await runOf("moved", join(root, "flows", "gone.ts"));
  for (const [id, code, message] of [
    ["changed", 2, "declares no event thread:reply"],
    ["moved", 1, "gone.ts"],
  ] as const) {
    err.length = 0;
    expect(await cli([`e2e-declared/${id}`, "thread:reply", '{"text":"hi"}'])).toBe(code);
    expect(err.join("\n")).toContain(message);
  }
  // A late reply to a run that returned is refused as returned, its file not read: gone, it would
  // fail the reply, which a sender retries.
  await writeAttempt(await runOf("returned", join(root, "flows", "gone.ts")), {
    outcome: "completed",
  });
  out.length = 0;
  err.length = 0;
  expect(await cli(["e2e-declared/returned", "thread:reply", '{"text":"hi"}'])).toBe(0);
  expect(out).toEqual(["refused e2e-declared/returned: returned"]);
  expect(err).toEqual([]);
  // send --event-id to a participant connected to agents is refused, as it always was, even when
  // the file it would be checked against is gone: the moved run, given k's connections.
  const moved = await openRun(join(root, ".awf", "runs"), "e2e-declared", "moved");
  await Bun.write(join(moved.dir, "log.jsonl"), Bun.file(join(run.dir, "log.jsonl")));
  const toLead: string[] = [];
  expect(
    await runOperatorCli(
      ["send", "e2e-declared/moved", "--as", "lead", "--event-id", "x3", "--json", "hi"],
      {
        cwd: dirs.tempRunDir(),
        home,
        environment,
        stdout: (t) => toLead.push(t),
        stderr: () => {},
      },
    ),
  ).toBe(1);
  expect(JSON.parse(toLead[0]!)).toMatchObject({ code: "no-participant" });
  expect(JSON.parse(toLead[0]!).error).toContain("gone.ts");
}, 60_000);

test.each([
  [["--as", "thread", "--event-id", "Bad Id"], "--event-id Bad Id"],
  [["--as", "thread", "--event-id", "awf.x"], "are awf's own"],
  [["--event-id", "m1"], "--as names it"],
  [["agent", "--author", "e"], "--author goes with --event-id"],
])("awf send %p is a usage error", async (flags, message) => {
  const err: string[] = [];
  const code = await runOperatorCli(["send", "x/y", ...flags, "hi"], {
    home: dirs.tempRunDir(),
    stdout: () => undefined,
    stderr: (t) => err.push(t),
  });
  expect(code).toBe(2);
  expect(err.join("\n")).toContain(message);
});

test("a ref that is a run in two projects is refused, naming both; --cwd chooses", async () => {
  const home = dirs.tempRunDir();
  const roots = [dirs.tempRunDir(), dirs.tempRunDir()];
  for (const root of roots) {
    await createRun(join(root, ".awf", "runs"), {
      id: "k",
      workflow: "w",
      argv: [],
      cwd: root,
      sandbox: null,
      events: true,
    });
  }
  mkdirSync(join(home, ".awf"), { recursive: true });
  writeFileSync(join(home, ".awf", "projects"), `${roots.join("\n")}\n`);
  await expect(findRunByRef("w/k", { runRoot: dirs.tempRunDir() }, home)).rejects.toThrow(
    "is a run in 2 projects",
  );
  expect(
    (await findRunByRef("w/k", { runRoot: join(roots[1]!, ".awf", "runs") }, home))?.run.root,
  ).toBe(join(roots[1]!, ".awf", "runs"));
});
