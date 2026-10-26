import { afterAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InboxItemJson } from "@agentswf/contract/records";
import { emitCommand } from "./emit-command";
import { foldMailbox, readMailbox } from "./mailbox";
import { runOperatorCli } from "./operator-cli";
import { findKeyedRun } from "./run-state";
import { createRun, openRun, readAttempts } from "./runs";
import { createTempRunDirs, keyedProject, until } from "./testing";

const dirs = createTempRunDirs();
afterAll(() => dirs.cleanup());

// A case run whose thread goes to its code: each reply is written down and answered with a post.
// It sleeps a moment first at each wake, so a reply sent then finds it live.
const WORKFLOW = `import { appendFileSync } from "node:fs";
import { defineEventWorkflow } from "agentswf/workflow";
const Changes = { type: "object", properties: { case: { type: "string" } }, required: ["case"] };
export default defineEventWorkflow({
  definition: {
    meta: { name: "e2e-thread", description: "Answers its thread." },
    file: import.meta.path,
    events: { "dd.changes": Changes },
    key: (e) => e.data.case,
    starts: ["dd.changes"],
    async run(workflow) {
      const thread = await workflow.participants.connect({ key: "thread", to: "code", labels: { title: "kombo" } });
      await new Promise((resolve) => setTimeout(resolve, 1500));
      for (;;)
        for (const e of await workflow.receive({ label: "listening" }))
          if (thread.replied(e)) {
            appendFileSync(new URL("../replies.txt", import.meta.url).pathname, e.id + " " + e.data.text + " " + (e.data.author ?? "") + "\\n");
            await workflow.stage("answer-" + e.id, () => thread.post("got: " + e.data.text));
          }
    },
  },
});
`;

test("a reply on a participant routed to the code reaches the run, live or parked, once", async () => {
  const { root, file, home } = keyedProject(dirs, "thread.ts", WORKFLOW);
  const environment = { ...process.env, HOME: home };
  const out: string[] = [];
  const err: string[] = [];
  const io = { stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t) };
  expect(
    await emitCommand(["--target", file, "dd.changes", '{"case":"k"}'], dirs.tempRunDir(), io, {
      home,
      environment,
    }),
  ).toBe(0);
  const run = await openRun(join(root, ".awf", "runs"), "e2e-thread", "e2e-thread.k");
  const send = (id: string, text: string, ...extra: string[]) =>
    runOperatorCli(
      ["send", "e2e-thread/e2e-thread.k", "--as", "thread", "--id", id, ...extra, text],
      {
        // Found through ~/.awf/projects, from a directory with no runs.
        cwd: dirs.tempRunDir(),
        home,
        environment,
        stdout: (t) => out.push(t),
        stderr: (t) => err.push(t),
      },
    );
  // Once it has connected its thread, which a chat host opens only then, and while it sleeps at its
  // first wake: live, so nudged.
  await until(async () =>
    (
      await Bun.file(join(run.dir, "turns.jsonl"))
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
    "accepted e2e-thread/e2e-thread.k: started",
    "accepted e2e-thread/e2e-thread.k: nudged",
    "accepted e2e-thread/e2e-thread.k: continued",
    // Parked with nothing new to take: not continued again.
    "duplicate e2e-thread/e2e-thread.k: nothing-due",
  ]);
  const replies = foldMailbox(await readMailbox(run.dir));
  expect([...replies.events.values()].filter((e) => e.name === "participant:reply")).toHaveLength(
    2,
  );
  expect(await Bun.file(join(root, "replies.txt")).text()).toBe(
    "1729.001 is it the index? engineer\n1729.002 never mind \n",
  );
  // Its posts are in awf inbox for the thread, the parked run's participant still there.
  const inbox: string[] = [];
  await runOperatorCli(
    // From a directory with no runs: found through ~/.awf/projects.
    ["inbox", "e2e-thread/e2e-thread.k", "--as", "thread", "--json"],
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
  const connected = (await Bun.file(join(run.dir, "turns.jsonl")).text())
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
      ["send", "e2e-thread/e2e-thread.k", "--as", "other", "--id", "1729.003", "--json", "hi"],
      {
        cwd: dirs.tempRunDir(),
        home,
        environment,
        stdout: (t) => refused.push(t),
        stderr: () => undefined,
      },
    ),
  ).toBe(1);
  expect(JSON.parse(refused[0]!)).toMatchObject({ v: 1, code: "no-coordinator" });
  expect(err).toEqual([]);
}, 60_000);

test.each([
  [["--as", "thread", "--id", "Bad Id"], "--id Bad Id"],
  [["--as", "thread", "--id", "awf.x"], "are awf's own"],
  [["--id", "m1"], "--as names it"],
  [["agent", "--author", "e"], "--author goes with --id"],
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
      id: "w.k",
      workflow: "w",
      argv: [],
      cwd: root,
      sandbox: null,
      key: "k",
    });
  }
  mkdirSync(join(home, ".awf"), { recursive: true });
  writeFileSync(join(home, ".awf", "projects"), `${roots.join("\n")}\n`);
  await expect(findKeyedRun("w/w.k", { runRoot: dirs.tempRunDir() }, home)).rejects.toThrow(
    "is a run in 2 projects",
  );
  expect(
    (await findKeyedRun("w/w.k", { runRoot: join(roots[1]!, ".awf", "runs") }, home))?.run.root,
  ).toBe(join(roots[1]!, ".awf", "runs"));
});
