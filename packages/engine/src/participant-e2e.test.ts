import { afterAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readIn } from "./in-lines";
import { runOperatorCli } from "./operator-cli";
import { findRunByRef } from "./run-state";
import { createRun, openRun, readAttempts } from "./runs";
import { createTempRunDirs, eventProject, until, writeAttempt } from "./testing";

const dirs = createTempRunDirs();
afterAll(() => dirs.cleanup());

// A case run whose thread's replies are declared: each is written down and answered with a post.
// `lead` is connected but not declared, so its messages are its agents', never the code's. It
// sleeps a moment first at each wake, so a reply sent then finds it live.
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
  // Written before any workflow loads: Bun's resolver keeps a directory as it first read it.
  const undeclaring = join(root, "flows", "undeclaring.ts");
  writeFileSync(undeclaring, DECLARED.replace(', "thread:reply": ParticipantReply', ""));
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
}, 60_000);

test.each([
  ["--event-id", "m1"],
  ["--author", "dana"],
])("awf send %s is a usage error naming awf emit", async (flag, value) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runOperatorCli(
    ["send", "x/y", "--as", "thread", flag, value, "--json", "hi"],
    {
      home: dirs.tempRunDir(),
      stdout: (t) => out.push(t),
      stderr: (t) => err.push(t),
    },
  );
  expect(code).toBe(2);
  expect(JSON.parse(out[0]!)).toMatchObject({ code: "usage" });
  expect(err.join("\n")).toContain(
    `send ${flag} was removed: a message on a participant to the run's code is awf emit {run} {participant}:reply`,
  );
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
