import { afterAll, describe, expect, spyOn, test } from "bun:test";
import {
  type InboxErrorJson,
  type InboxItemJson,
  RUN_EVENT_VERSIONS,
  type RunLogLine,
  TURN_RECORD_VERSION,
} from "@agentswf/contract/records";
import { type InboxClock, ItemFold, inboxCommand } from "./inbox-command";
import * as runs from "./runs";
import {
  appendEvent,
  claimAttempt,
  createRun,
  endAttempt,
  type Run,
  readAttempts,
  readNumberedEvents,
} from "./runs";
import { createTempRunDirs } from "./testing";

const runDirs = createTempRunDirs();
afterAll(() => runDirs.cleanup());

const PURPOSE = "report findings; ask when the logs can't settle it";
let clock = Date.parse("2026-10-22T09:12:00Z");
const at = () => {
  clock += 60_000;
  return new Date(clock).toISOString();
};

type Body<E> = E extends unknown ? Omit<E, "version" | "attempt" | "at" | "callPath"> : never;
async function log(run: Run, attempt: number, ...events: Body<RunLogLine>[]) {
  for (const event of events)
    await appendEvent(run.dir, {
      version: RUN_EVENT_VERSIONS[event.kind as keyof typeof RUN_EVENT_VERSIONS],
      attempt,
      at: at(),
      callPath: [],
      ...event,
    } as unknown as RunLogLine);
}

/** A run in its own folder; `live` keeps its attempt open under this process. */
async function newRun(root: string, workflow = "investigate", id?: string) {
  const run = await createRun(root, {
    workflow,
    ...(id ? { id } : {}),
    argv: [],
    cwd: root,
    sandbox: null,
  });
  const claim = async (dead = false) => {
    const claimed = await claimAttempt(
      run,
      { file: "flow.ts", flags: {} },
      dead ? { pid: 1, probe: () => "Mon Jan  1 00:00:00 2026" } : {},
    );
    if ("refused" in claimed) throw new Error("refused");
    return claimed.attempt;
  };
  return { run, claim, ref: `${workflow}/${run.record.id}` };
}

const opened = (agent: string, extra = {}): Body<RunLogLine> =>
  ({
    kind: "route-opened",
    between: [agent, "coordinator"],
    purpose: PURPOSE,
    maxMessages: 40,
    ...extra,
  }) as Body<RunLogLine>;
const ask = (n: number, from: string, text: string, until?: string): Body<RunLogLine> =>
  ({
    kind: "message-sent",
    message: n,
    from,
    to: "coordinator",
    operationId: "op",
    text,
    bytes: text.length,
    awaitsReply: until ? { until } : {},
  }) as Body<RunLogLine>;

async function inbox(root: string, ...args: string[]) {
  return waiting(root, async () => {}, ...args);
}

/** As `inbox`, with `between(poll)` run in each pause of a wait, the polls before it counted from 1. */
async function waiting(root: string, between: (poll: number) => Promise<void>, ...args: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const sleeps: number[] = [];
  const fake: InboxClock = {
    now: () => Date.now() + sleeps.reduce((sum, ms) => sum + ms, 0),
    sleep: async (ms) => {
      sleeps.push(ms);
      await between(sleeps.length);
    },
  };
  const code = await inboxCommand(
    [...args, "--run-root", root],
    root,
    { stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) },
    fake,
    // A home of its own: no project of the developer's is looked in.
    root,
  );
  const items = args.includes("--json")
    ? stdout.flatMap((text) => text.split("\n").filter(Boolean)).map((line) => JSON.parse(line))
    : [];
  return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n"), items, sleeps };
}

describe("awf inbox", () => {
  test("one run's items, oldest first, in their published shape, and a cursor that reads on", async () => {
    const root = runDirs.tempRunDir();
    const { run, claim, ref } = await newRun(root);
    const attempt = await claim();
    await log(
      run,
      1,
      { kind: "participant-connected", participant: "coordinator", labels: { audience: "ops" } },
      opened("investigator", { timeoutMs: 7_200_000 }),
      {
        kind: "message-sent",
        message: 1,
        from: "investigator",
        to: "coordinator",
        operationId: "op",
        text: "5xx at 4×.",
        bytes: 9,
      },
      ask(2, "investigator", "Merge or keep two?", "2026-10-22T11:40:00.000Z"),
      {
        kind: "message-sent",
        message: 3,
        from: "coordinator",
        to: "investigator",
        via: "terminal",
        text: "Keep two.",
        bytes: 9,
        replyTo: 2,
      },
      {
        kind: "request-ended",
        message: 2,
        owedBy: "coordinator",
        asker: "investigator",
        end: "replied",
        reply: 3,
      },
      { kind: "route-closed", between: ["investigator", "coordinator"], reason: "released" },
    );
    await endAttempt(attempt, { outcome: "completed" });
    const read = await inbox(root, ref, "--json");
    expect(read.code).toBe(0);
    const items = read.items as InboxItemJson[];
    expect(items.map(({ cursor: _cursor, at: _at, ...item }) => item)).toEqual([
      {
        v: 1,
        run: ref,
        kind: "route",
        state: "opened",
        coordinator: "coordinator",
        agent: "investigator",
        direction: "both",
        purpose: PURPOSE,
        timeoutMs: 7_200_000,
        labels: { audience: "ops" },
      },
      {
        v: 1,
        run: ref,
        kind: "message",
        coordinator: "coordinator",
        id: "1.1",
        from: "investigator",
        to: "coordinator",
        text: "5xx at 4×.",
      },
      {
        v: 1,
        run: ref,
        kind: "message",
        coordinator: "coordinator",
        id: "1.2",
        from: "investigator",
        to: "coordinator",
        text: "Merge or keep two?",
        asks: true,
        until: "2026-10-22T11:40:00.000Z",
      },
      {
        v: 1,
        run: ref,
        kind: "answered",
        coordinator: "coordinator",
        id: "1.2",
        answer: "Keep two.",
        via: "terminal",
      },
      {
        v: 1,
        run: ref,
        kind: "route",
        state: "closed",
        coordinator: "coordinator",
        agent: "investigator",
        direction: "both",
        purpose: PURPOSE,
        timeoutMs: 7_200_000,
        labels: { audience: "ops" },
        reason: "released",
      },
      { v: 1, run: ref, kind: "ended", attempt: 1, outcome: "completed" },
    ]);
    // From any item's cursor, what came after it.
    const from = await inbox(root, ref, "--json", "--after", items[2]!.cursor!);
    expect(from.items.map((item: InboxItemJson) => item.kind)).toEqual([
      "answered",
      "route",
      "ended",
    ]);
    expect((await inbox(root, ref, "--json", "--after", items.at(-1)!.cursor!)).items).toEqual([]);
    const text = await inbox(root, ref);
    expect(text.stdout).toContain("1.2  investigator asks coordinator, until");
    expect(text.stdout).toContain("       Merge or keep two?");
    expect(text.stdout).toMatch(/next: awf inbox investigate\/\S+ --run-root \S+ --after \S+$/);
  });

  test("--open is a snapshot of the questions still waiting", async () => {
    const root = runDirs.tempRunDir();
    const { run, claim, ref } = await newRun(root);
    await claim();
    await log(
      run,
      1,
      { kind: "participant-connected", participant: "coordinator" },
      opened("a"),
      opened("b"),
      ask(1, "a", "First?"),
      ask(2, "b", "Second?"),
      {
        kind: "request-ended",
        message: 1,
        owedBy: "coordinator",
        asker: "a",
        end: "timed-out",
      },
    );
    const open = await inbox(root, ref, "--open", "--json");
    expect(open.items.map((item: InboxItemJson) => [item.kind, "id" in item && item.id])).toEqual([
      ["message", "1.2"],
    ]);
    expect(open.items[0].cursor).toBeUndefined();
    const all = await inbox(root, ref, "--json");
    expect(all.items.at(-1)).toMatchObject({ kind: "expired", id: "1.1", reason: "timeout" });
  });

  test("an interrupted attempt expires its open questions and ends interrupted; a continue reads on", async () => {
    const root = runDirs.tempRunDir();
    const { run, claim, ref } = await newRun(root);
    await claim(true);
    await log(
      run,
      1,
      { kind: "participant-connected", participant: "coordinator" },
      opened("a"),
      ask(1, "a", "Still there?"),
    );
    const first = await inbox(root, ref, "--json");
    expect(first.items.slice(-2)).toMatchObject([
      { kind: "expired", id: "1.1", reason: "attempt-ended" },
      { kind: "ended", attempt: 1, outcome: "interrupted" },
    ]);
    const cursor = first.items.at(-1).cursor;
    await claim();
    await log(run, 2, { kind: "participant-connected", participant: "coordinator" }, opened("a"));
    const next = await inbox(root, ref, "--json", "--after", cursor);
    expect(next.items.map((item: InboxItemJson) => item.kind)).toEqual(["route"]);
  });

  test("--all reads every run here that connected one, new ones included, from a saved cursor", async () => {
    const root = runDirs.tempRunDir();
    const one = await newRun(root, "investigate", "r1");
    await one.claim();
    await log(
      one.run,
      1,
      { kind: "participant-connected", participant: "coordinator" },
      opened("a"),
    );
    // A run with no coordinator has nothing for a holder.
    const quiet = await newRun(root, "build", "r2");
    await quiet.claim();
    await log(quiet.run, 1, { kind: "warning", text: "nothing" } as Body<RunLogLine>);
    const first = await inbox(root, "--all", "--json");
    expect(first.items.map((item: InboxItemJson) => item.run)).toEqual(["investigate/r1"]);
    const cursor = first.items.at(-1).cursor;
    const late = await newRun(root, "triage", "r3");
    await late.claim();
    await log(
      late.run,
      1,
      { kind: "participant-connected", participant: "coordinator" },
      opened("b"),
    );
    await log(one.run, 1, ask(1, "a", "And now?"));
    const next = await inbox(root, "--all", "--json", "--after", cursor);
    expect(next.items.map((item: InboxItemJson) => [item.run, item.kind])).toEqual([
      ["triage/r3", "route"],
      ["investigate/r1", "message"],
    ]);
    const narrowed = await inbox(root, "--all", "--workflow", "triage", "--json");
    expect(narrowed.items.map((item: InboxItemJson) => item.run)).toEqual(["triage/r3"]);
    // A cursor belongs to the filter it was made with.
    const refused = await inbox(root, "--all", "--workflow", "triage", "--json", "--after", cursor);
    expect(refused.code).toBe(1);
    expect(refused.items[0] as InboxErrorJson).toMatchObject({ v: 1, code: "bad-cursor" });
  });

  test("--wait waits when nothing is new, then says so", async () => {
    const root = runDirs.tempRunDir();
    const { run, claim, ref } = await newRun(root);
    await claim();
    await log(run, 1, { kind: "participant-connected", participant: "coordinator" }, opened("a"));
    const first = await inbox(root, ref, "--json");
    const waited = await inbox(
      root,
      ref,
      "--json",
      "--after",
      first.items[0].cursor,
      "--wait",
      "3",
    );
    expect(waited.items).toEqual([]);
    expect(waited.sleeps.reduce((sum, ms) => sum + ms, 0)).toBeGreaterThanOrEqual(2_900);
  });

  test("failures, in their order: not-found, no-coordinator, bad-cursor", async () => {
    const root = runDirs.tempRunDir();
    const missing = await inbox(root, "investigate/nope", "--json", "--after", "junk");
    expect(missing).toMatchObject({ code: 1 });
    expect(missing.items[0] as InboxErrorJson).toMatchObject({ v: 1, code: "not-found" });
    const { run, claim, ref } = await newRun(root);
    const attempt = await claim();
    // Live and not connected yet: empty, not an error.
    expect(await inbox(root, ref, "--json")).toMatchObject({ code: 0, items: [] });
    await endAttempt(attempt, { outcome: "completed" });
    const ended = await inbox(root, ref, "--json", "--after", "junk");
    expect(ended.items[0]).toMatchObject({ v: 1, code: "no-coordinator" });
    const other = await newRun(root, "triage");
    await other.claim();
    await log(other.run, 1, { kind: "participant-connected", participant: "coordinator" });
    expect((await inbox(root, other.ref, "--json", "--after", "junk")).items[0]).toMatchObject({
      code: "bad-cursor",
    });
    void run;
    expect((await inbox(root, "nope")).code).toBe(2);
  });
});

const noise = (text: string) => ({ kind: "warning", text }) as Body<RunLogLine>;
const cursorOf = (cursor: string) =>
  JSON.parse(Buffer.from(cursor.slice(3), "base64url").toString("utf8")) as {
    r: Record<string, number[]>;
  };

describe("awf inbox --wait reads only what changed", () => {
  test("the items a wait reads poll by poll are those of the whole log, with the same cursors", async () => {
    const root = runDirs.tempRunDir();
    const { run, claim, ref } = await newRun(root);
    await claim(true);
    await log(
      run,
      1,
      noise("before"),
      { kind: "participant-connected", participant: "coordinator" },
      noise("one"),
      noise("two"),
      opened("a"),
      ask(1, "a", "Still there?"),
      noise("last of 1"),
    );
    // A turn line has no time of its own: what its dead attempt left open closes at the line before.
    const lastOf1 = new Date(clock).toISOString();
    await appendEvent(run.dir, {
      version: TURN_RECORD_VERSION,
      attempt: 1,
      kind: "turn",
    } as unknown as RunLogLine);
    const live = await claim();
    // Each pause adds lines: noise, a line torn in two, a second attempt's, and its end.
    const turns = `${run.dir}/turns.jsonl`;
    const torn = JSON.stringify({
      ...noise("torn"),
      version: 1,
      attempt: 2,
      at: at(),
      callPath: [],
    });
    const append = async (text: string) =>
      Bun.write(turns, `${await Bun.file(turns).text()}${text}`);
    const steps: (() => Promise<unknown>)[] = [
      () => log(run, 2, noise("first of 2")),
      () => log(run, 2, { kind: "participant-connected", participant: "coordinator" }, noise("x")),
      () => append(torn.slice(0, 20)),
      () => append(`${torn.slice(20)}\n`),
      () => log(run, 2, opened("b"), noise("y"), ask(2, "b", "Merge?")),
      () => endAttempt(live, { outcome: "failed" }),
    ];
    const read: InboxItemJson[] = [];
    let cursor: string | undefined;
    for (let calls = 0; calls < 20 && steps.length > 0; calls += 1) {
      const next = await waiting(
        root,
        async () => {
          await steps.shift()?.();
        },
        ref,
        "--json",
        "--wait",
        "30",
        ...(cursor ? ["--after", cursor] : []),
      );
      expect(next.code).toBe(0);
      read.push(...next.items);
      cursor = read.at(-1)?.cursor ?? cursor;
    }
    const once = await inbox(root, ref, "--json");
    expect(read).toEqual(once.items);
    const ended = read.filter((item) => item.kind === "expired" || item.kind === "ended");
    expect(ended.map((item) => [item.kind, item.at, cursorOf(item.cursor!).r[ref]])).toEqual([
      ["expired", lastOf1, [8, 0, 1]],
      ["ended", lastOf1, [8, 1, 0]],
      ["ended", expect.any(String), [15, 2, 0]],
    ]);
    expect(read.slice(-1)).toMatchObject([{ kind: "ended", attempt: 2, outcome: "failed" }]);
    // The fold gives the same items however the log is cut into reads.
    const lines = await readNumberedEvents(run.dir);
    const attempts = await readAttempts(run);
    const byLine = new ItemFold();
    for (const each of lines) byLine.add([each]);
    expect(byLine.items(attempts, false)).toEqual(new ItemFold().add(lines).items(attempts, false));
  });

  test("after the first poll, each reads only the live run's log, and only when it grew", async () => {
    const root = runDirs.tempRunDir();
    for (let n = 0; n < 5; n += 1) {
      const quiet = await newRun(root, "build", `q${n}`);
      const attempt = await quiet.claim();
      await log(quiet.run, 1, noise("nothing for a holder"));
      await endAttempt(attempt, { outcome: "completed" });
    }
    const one = await newRun(root, "investigate", "live");
    await one.claim();
    await log(
      one.run,
      1,
      { kind: "participant-connected", participant: "coordinator" },
      opened("a"),
    );
    const first = await inbox(root, "--all", "--json");
    const spies = {
      log: spyOn(runs, "readEventsFrom"),
      attempts: spyOn(runs, "readAttempts"),
      record: spyOn(runs, "openRun"),
    };
    const reads: { log: string[]; attempts: number; record: number }[] = [];
    const counted = () => {
      reads.push({
        log: spies.log.mock.calls.map(([dir]) => dir),
        attempts: spies.attempts.mock.calls.length,
        record: spies.record.mock.calls.length,
      });
      for (const spy of Object.values(spies)) spy.mockClear();
    };
    try {
      const next = await waiting(
        root,
        async (poll) => {
          counted();
          if (poll === 3) await log(one.run, 1, noise("still working"));
          if (poll === 5) await log(one.run, 1, ask(1, "a", "Merge?"));
        },
        "--all",
        "--json",
        "--wait",
        "30",
        "--after",
        first.items.at(-1).cursor,
      );
      counted();
      expect(next.items.map((item: InboxItemJson) => [item.run, item.kind])).toEqual([
        ["investigate/live", "message"],
      ]);
    } finally {
      for (const spy of Object.values(spies)) spy.mockRestore();
    }
    // The first poll reads every run; each after it, the live log once it grew.
    expect(reads[0]!.record).toBe(6);
    expect(reads.slice(1)).toEqual([
      { log: [], attempts: 0, record: 0 },
      { log: [], attempts: 0, record: 0 },
      { log: [one.run.dir], attempts: 0, record: 0 },
      { log: [], attempts: 0, record: 0 },
      { log: [one.run.dir], attempts: 0, record: 0 },
    ]);
  });

  test("a run that connects its coordinator while a wait is on is read", async () => {
    const root = runDirs.tempRunDir();
    const late = await newRun(root, "triage", "late");
    await late.claim();
    await log(late.run, 1, noise("starting"));
    const read = await waiting(
      root,
      async (poll) => {
        if (poll === 2)
          await log(
            late.run,
            1,
            { kind: "participant-connected", participant: "coordinator" },
            opened("a"),
          );
      },
      "--all",
      "--json",
      "--wait",
      "30",
    );
    expect(read.items.map((item: InboxItemJson) => [item.run, item.kind])).toEqual([
      ["triage/late", "route"],
    ]);
  });

  test("a run continued while a wait is on is read again", async () => {
    const root = runDirs.tempRunDir();
    const { run, claim, ref } = await newRun(root);
    const attempt = await claim();
    await log(run, 1, { kind: "participant-connected", participant: "coordinator" }, opened("a"));
    await endAttempt(attempt, { outcome: "failed" });
    const first = await inbox(root, "--all", "--json");
    expect(first.items.at(-1)).toMatchObject({ kind: "ended", attempt: 1 });
    const read = await waiting(
      root,
      async (poll) => {
        if (poll !== 2) return;
        await claim();
        await log(
          run,
          2,
          { kind: "participant-connected", participant: "coordinator" },
          opened("b"),
        );
      },
      "--all",
      "--json",
      "--wait",
      "30",
      "--after",
      first.items.at(-1).cursor,
    );
    expect(
      read.items.map((item: InboxItemJson) => [item.run, item.kind, "agent" in item && item.agent]),
    ).toEqual([[ref, "route", "b"]]);
  });
});
