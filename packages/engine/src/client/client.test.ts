import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ClientError } from "@agentswf/contract/client";
import {
  type AttemptRecord,
  type EmitResultJson,
  RUN_EVENT_VERSIONS,
  type RunLogLine,
} from "@agentswf/contract/records";
import { emitCommand } from "../emit-command";
import { writeJson } from "../files";
import { inboxCommand } from "../inbox-command";
import { foldMailbox, RunMailbox, readMailbox } from "../mailbox";
import { appendEvent, createRun, openRun, processStart, type Run, readAttempts } from "../runs";
import { createTempRunDirs, writeAttempt } from "../testing";
import type { Launch } from "../wake";
import { loadWorkflowFile } from "../workflow-loader";
import { clientWith } from "./index";

const dirs = createTempRunDirs();
afterAll(() => dirs.cleanup());

const AGENTSWF = realpathSync(join(import.meta.dir, "../../../agentswf"));
const ALIVE = { pid: process.pid, processStart: processStart(process.pid)! };
const GONE = { pid: Bun.spawnSync(["true"]).pid, processStart: "2026-10-11T09:00:00Z" };

const REVIEW = `import { defineWorkflow, ParticipantReply } from "agentswf/workflow";
const Pushed = {
  type: "object",
  properties: { sha: { type: "string" } },
  required: ["sha"],
  additionalProperties: false,
};
export default defineWorkflow({
  meta: { name: "review", description: "Reviews a pull request as it changes." },
  file: import.meta.path,
  events: { "pr.pushed": Pushed, "pr.closed": Pushed, "thread:reply": ParticipantReply },
  starts: ["pr.pushed"],
  run: async () => null,
});
`;

/** A project on this engine, its `agentswf` this repository's, with `review.ts` in it. */
async function project() {
  const root = dirs.tempRunDir();
  mkdirSync(join(root, ".awf"));
  mkdirSync(join(root, "node_modules"));
  symlinkSync(AGENTSWF, join(root, "node_modules", "agentswf"));
  const file = join(root, "review.ts");
  writeFileSync(file, REVIEW);
  const home = dirs.tempRunDir();
  // As the program imports it: the client checks `file` against this value.
  const review = await imported(file);
  return { root, home, file, review, runRoot: join(root, ".awf", "runs") };
}
type Project = Awaited<ReturnType<typeof project>>;

/** The module's default export, imported once into this process as a program's import would be. */
async function imported(file: string) {
  // biome-ignore lint/suspicious/noExplicitAny: a workflow of any args and events.
  return (await loadWorkflowFile(file, dirname(file))).workflow as any;
}

/** A launch that claims the attempt as `awf run --continue` would. */
function fakeLaunch(): Launch & { launched: string[] } {
  const launched: string[] = [];
  const launch = (async (run: Run, file: string) => {
    launched.push(file);
    await writeAttempt(run, { ...ALIVE, file });
  }) as Launch & { launched: string[] };
  launch.launched = launched;
  return launch;
}
const failing: Launch = async () => {
  throw new Error("bun: command not found");
};

function runsOf(p: Project, launch: Launch = fakeLaunch(), nudge?: (run: Run) => Promise<boolean>) {
  return clientWith({
    home: p.home,
    environment: { PATH: "/usr/bin:/bin" },
    launch,
    ...(nudge ? { nudge } : {}),
  });
}

/** What `awf emit --json` prints for the same event. */
async function cli(
  p: Project,
  argv: string[],
  launch: Launch = fakeLaunch(),
): Promise<EmitResultJson> {
  const out: string[] = [];
  await emitCommand(
    [...argv, "--json"],
    p.root,
    { stdout: (text) => out.push(text), stderr: () => {} },
    {
      home: p.home,
      environment: { PATH: "/usr/bin:/bin" },
      launch,
    },
  );
  return JSON.parse(out.join(""));
}

/** A run of `review` with one attempt, rewritten to the state given. */
async function runIn(p: Project, id: string, fields: Partial<AttemptRecord>): Promise<Run> {
  await runsOf(p).emit(
    p.review,
    id,
    "pr.pushed",
    { sha: "a" },
    { eventId: `${id.toLowerCase()}-0` },
  );
  const run = await openRun(p.runRoot, "review", id);
  const [first] = await readAttempts(run);
  await writeJson(join(run.dir, "attempts", "1.json"), { ...first, ...fields });
  return run;
}
const ended = (outcome: AttemptRecord["outcome"]) => ({
  ...GONE,
  ended: new Date().toISOString(),
  outcome,
});

/** The two results with what differs by the run's id taken out. */
const same = (a: EmitResultJson, b: EmitResultJson) => {
  const strip = ({ ref: _r, eventId: _e, ...rest }: EmitResultJson) => rest;
  expect(strip(a)).toEqual(strip(b));
};

describe("emit, as awf emit --json gives it", () => {
  test("a run started by its first event, and a duplicate id", async () => {
    const p = await project();
    const runs = runsOf(p);
    const first = await runs.emit(p.review, "pr-1", "pr.pushed", { sha: "a" }, { eventId: "d-1" });
    expect(first).toEqual({
      v: 1,
      ok: true,
      outcome: "accepted",
      ref: "review/pr-1",
      eventId: "d-1",
      did: "started",
    });
    same(
      first,
      await cli(p, [
        "--target",
        p.file,
        "--id",
        "pr-2",
        "pr.pushed",
        '{"sha":"a"}',
        "--event-id",
        "d-1",
      ]),
    );
    const again = await runs.emit(p.review, "pr-1", "pr.pushed", { sha: "a" }, { eventId: "d-1" });
    expect(again).toMatchObject({ outcome: "duplicate" });
    same(
      again,
      await cli(p, [
        "--target",
        p.file,
        "--id",
        "pr-2",
        "pr.pushed",
        '{"sha":"a"}',
        "--event-id",
        "d-1",
      ]),
    );
  });

  test("a live run nudged, or its nudge failed", async () => {
    const p = await project();
    await runIn(p, "a", { ...ALIVE });
    expect(
      await runsOf(p, fakeLaunch(), async () => true).emit(p.review, "a", "pr.closed", {
        sha: "b",
      }),
    ).toMatchObject({ outcome: "accepted", did: "nudged" });
    await runIn(p, "b", { ...ALIVE });
    // No socket to nudge, as for the command.
    same(
      await runsOf(p).emit(p.review, "a", "pr.closed", { sha: "b" }),
      await cli(p, ["--target", p.file, "--id", "b", "pr.closed", '{"sha":"b"}']),
    );
  });

  test("a parked run continued; a returned one refused", async () => {
    const p = await project();
    for (const id of ["a", "b"]) await runIn(p, id, ended("parked"));
    const continued = await runsOf(p).emit(p.review, "a", "pr.closed", { sha: "b" });
    expect(continued).toMatchObject({ outcome: "accepted", did: "continued" });
    same(continued, await cli(p, ["--target", p.file, "--id", "b", "pr.closed", '{"sha":"b"}']));
    for (const id of ["c", "d"]) await runIn(p, id, ended("completed"));
    const refused = await runsOf(p).emit(p.review, "c", "pr.closed", { sha: "b" });
    expect(refused).toMatchObject({ outcome: "refused", why: "returned" });
    same(refused, await cli(p, ["--target", p.file, "--id", "d", "pr.closed", '{"sha":"b"}']));
  });

  test("a launch that failed: the event kept, for the next wake", async () => {
    const p = await project();
    const failed = await runsOf(p, failing).emit(p.review, "a", "pr.pushed", { sha: "a" });
    expect(failed).toMatchObject({
      ok: false,
      outcome: "accepted",
      did: "none",
      why: "launch-failed",
    });
    expect(failed.error).toContain("command not found");
    same(
      failed,
      await cli(p, ["--target", p.file, "--id", "b", "pr.pushed", '{"sha":"a"}'], failing),
    );
  });

  test("a reply to a run, which never starts one: to no run, no-run", async () => {
    const p = await project();
    for (const id of ["a", "b"]) await runIn(p, id, ended("parked"));
    const reply = await runsOf(p).emit(p.review, "a", "thread:reply", {
      text: "ok",
      author: "sam",
    });
    expect(reply).toMatchObject({ outcome: "accepted", did: "continued" });
    same(reply, await cli(p, ["review/b", "thread:reply", '{"text":"ok","author":"sam"}']));
    const records = foldMailbox(await readMailbox((await openRun(p.runRoot, "review", "a")).dir));
    expect([...records.events.values()].at(-1)).toMatchObject({
      name: "participant:reply",
      from: "thread",
      data: { text: "ok", author: "sam" },
    });
    const none = runsOf(p).emit(p.review, "nobody", "thread:reply", { text: "ok" });
    await expect(none).rejects.toBeInstanceOf(ClientError);
    await expect(none).rejects.toMatchObject({ code: "no-run", ref: "review/nobody" });
  });
});

describe("source", () => {
  test("is kept in the mailbox, set by the client and by awf emit --source", async () => {
    const p = await project();
    await runsOf(p).emit(
      p.review,
      "a",
      "pr.pushed",
      { sha: "a" },
      { eventId: "e1", source: "github" },
    );
    await cli(p, [
      "--target",
      p.file,
      "--id",
      "b",
      "pr.pushed",
      '{"sha":"a"}',
      "--event-id",
      "e2",
      "--source",
      "gitlab",
    ]);
    for (const [id, source] of [
      ["a", "github"],
      ["b", "gitlab"],
    ] as const) {
      const records = await readMailbox((await openRun(p.runRoot, "review", id)).dir);
      expect(records.find((record) => record.kind === "event")).toMatchObject({
        source,
        from: "operator",
      });
    }
    await expect(
      runsOf(p).emit(p.review, "c", "pr.pushed", { sha: "a" }, { source: "Git Hub" }),
    ).rejects.toMatchObject({ code: "event" });
  });
});

describe("what the client refuses", () => {
  test("each error is a ClientError with its code", async () => {
    const p = await project();
    const runs = runsOf(p);
    const code = (promise: Promise<unknown>) =>
      promise.then(
        () => "resolved",
        (error) => (error instanceof ClientError ? error.code : `not a ClientError: ${error}`),
      );
    // biome-ignore lint/suspicious/noExplicitAny: names and data the types refuse, sent anyway.
    const loose = runs as any;
    expect(await code(loose.emit(p.review, "a", "pr.opened", {}))).toBe("event");
    expect(await code(loose.emit(p.review, "a", "pr.pushed", { sha: 1 }))).toBe("event");
    // Not JSON, which the schema doesn't see in a property it doesn't declare; no run is made.
    expect(await code(loose.emit(p.review, "b", "pr.pushed", { sha: "a", n: 1n }))).toBe("event");
    expect(await code(runs.get(p.review, "b"))).toBe("no-run");
    expect(await code(runs.emit(p.review, "Bad Id", "pr.pushed", { sha: "a" }))).toBe("id");
    expect(
      await code(runs.emit(p.review, "a", "pr.pushed", { sha: "a" }, { eventId: "Mixed" })),
    ).toBe("id");
    expect(await code(runs.emit({ ...p.review }, "a", "pr.pushed", { sha: "a" }))).toBe("file");
    expect(await code(runs.inbox(p.review, { after: "not-a-cursor" }))).toBe("cursor");
  });
});

describe("inbox", () => {
  test("lists what awf inbox --workflow --json does, and reads on from a cursor", async () => {
    const p = await project();
    const runs = runsOf(p);
    expect(await runs.inbox(p.review)).toEqual([]);
    // Live, so its attempt has no end yet for the inbox to list.
    const run = await runIn(p, "a", { ...ALIVE });
    const line = (event: Record<string, unknown>) =>
      appendEvent(run.dir, {
        version: RUN_EVENT_VERSIONS[event.kind as keyof typeof RUN_EVENT_VERSIONS],
        attempt: 1,
        at: new Date().toISOString(),
        callPath: [],
        ...event,
      } as unknown as RunLogLine);
    await line({ kind: "participant-connected", participant: "thread", to: "code" });
    const say = (n: number, text: string) =>
      line({ kind: "participant-post", participant: "thread", id: `p${n}`, text });
    await say(1, "found it");
    const first = await runs.inbox(p.review);
    const listed: string[] = [];
    await inboxCommand(
      ["--workflow", "review", "--json"],
      p.root,
      { stdout: (text) => listed.push(text), stderr: () => {} },
      { home: p.home },
    );
    expect(first).toEqual(listed.map((text) => JSON.parse(text)));
    expect(first).toMatchObject([{ kind: "post", ref: "review/a", text: "found it" }]);
    await say(2, "fixed it");
    const after = await runs.inbox(p.review, { after: first.at(-1)!.cursor! });
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ kind: "post", text: "fixed it" });
  });
});

describe("the project's engine", () => {
  /** A project whose `agentswf` is `version`, or none; its workflow imports this repository's. */
  async function elsewhere(version?: string) {
    const root = dirs.tempRunDir();
    const file = join(root, "review.ts");
    writeFileSync(
      file,
      REVIEW.replace('"agentswf/workflow"', JSON.stringify(join(AGENTSWF, "src/workflow.ts"))),
    );
    // Imported before its project gains another agentswf, which the loader would refuse.
    const review = await imported(file);
    if (version !== undefined) {
      mkdirSync(join(root, "node_modules", "agentswf"), { recursive: true });
      writeFileSync(
        join(root, "node_modules", "agentswf", "package.json"),
        JSON.stringify({ version, bin: { awf: "./awf.ts" } }),
      );
    }
    return { home: dirs.tempRunDir(), review, file };
  }

  test("a project at another version, or with none, is refused", async () => {
    const other = await elsewhere("0.0.0-other");
    await expect(
      clientWith({ home: other.home }).emit(other.review, "a", "pr.pushed", { sha: "a" }),
    ).rejects.toMatchObject({ code: "other-engine" });
    const declared = await elsewhere();
    writeFileSync(
      join(dirname(declared.file), "package.json"),
      JSON.stringify({ devDependencies: { agentswf: "*" } }),
    );
    await expect(
      clientWith({ home: declared.home }).emit(declared.review, "a", "pr.pushed", { sha: "a" }),
    ).rejects.toMatchObject({ code: "no-engine", message: expect.stringContaining("bun install") });
    const none = await elsewhere();
    await expect(clientWith({ home: none.home }).inbox(none.review)).rejects.toMatchObject({
      code: "no-engine",
    });
  });
});

describe("a reply", () => {
  test("is checked against the value given, and serves no author surface to the program", async () => {
    const p = await project();
    await runIn(p, "a", ended("parked"));
    const child = Bun.spawn({
      cmd: [process.execPath, join(import.meta.dir, "reply-probe.fixture.ts"), p.file, p.home],
      stdio: ["ignore", "pipe", "pipe"],
    });
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual({ outcome: "accepted", served: false });
  });
});

describe("source, to the run", () => {
  test("reaches the event a wait returns", async () => {
    const p = await project();
    await runsOf(p).emit(
      p.review,
      "a",
      "pr.pushed",
      { sha: "a" },
      { eventId: "e1", source: "github" },
    );
    const state = foldMailbox(await readMailbox((await openRun(p.runRoot, "review", "a")).dir));
    expect(state.started).toMatchObject({ id: "e1", source: "github" });
    const box = new RunMailbox({
      runDir: (await openRun(p.runRoot, "review", "a")).dir,
      attempt: 1,
      locked: (work) => work(),
    });
    await box.open();
    expect(box.started).toEqual({
      id: "e1",
      name: "pr.pushed",
      data: { sha: "a" },
      from: "operator",
      source: "github",
      at: expect.any(String),
    });
  });
});

describe("from review", () => {
  test("an event to a plain run, or to an id differing only in case, is refused", async () => {
    const p = await project();
    await runIn(p, "PROJ-1", { ...ALIVE });
    await expect(
      runsOf(p).emit(p.review, "proj-1", "pr.pushed", { sha: "a" }),
    ).rejects.toMatchObject({ code: "id" });
    await expect(
      runsOf(p).emit(p.review, "proj-1", "thread:reply", { text: "hi" }),
    ).rejects.toMatchObject({ code: "id" });
    await createRun(p.runRoot, {
      id: "plain",
      workflow: "review",
      argv: [],
      cwd: p.root,
      sandbox: null,
    });
    await expect(
      runsOf(p).emit(p.review, "plain", "thread:reply", { text: "hi" }),
    ).rejects.toMatchObject({ code: "event" });
    await expect(
      runsOf(p).emit(p.review, "plain", "pr.pushed", { sha: "a" }),
    ).rejects.toMatchObject({ code: "event" });
  });

  test("a reply carries its source, from the client and from awf emit {run} --source", async () => {
    const p = await project();
    for (const id of ["a", "b"]) await runIn(p, id, ended("parked"));
    await runsOf(p).emit(p.review, "a", "thread:reply", { text: "ok" }, { source: "slack" });
    await cli(p, ["review/b", "thread:reply", '{"text":"ok"}', "--source", "slack"]);
    for (const id of ["a", "b"]) {
      const records = await readMailbox((await openRun(p.runRoot, "review", id)).dir);
      expect(records.findLast((record) => record.kind === "event")).toMatchObject({
        name: "participant:reply",
        from: "thread",
        source: "slack",
      });
    }
  });

  test("an after that is no cursor, or one made for another workflow, is cursor", async () => {
    const p = await project();
    const runs = runsOf(p);
    for (const after of ["-h", "--x", ""])
      await expect(runs.inbox(p.review, { after })).rejects.toMatchObject({ code: "cursor" });
    const other = Buffer.from(JSON.stringify({ f: "all|other|", r: {} })).toString("base64url");
    await expect(runs.inbox(p.review, { after: `i1.${other}` })).rejects.toMatchObject({
      code: "cursor",
    });
  });
});
