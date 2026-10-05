import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TokenUsage } from "@agentswf/contract/records";
import { createSessionAccounting } from "./accounting";
import { claudeBilling, codexBilling, piBilling, readCodexBilling } from "./billing";
import { findClaudeSession, readClaudeUsage as readClaude } from "./claude";
import { findCodexSession, inheritCodexSessionId, readCodexUsage as readCodex } from "./codex";
import {
  cursorHomeSessions,
  cursorSessionFiles,
  dropCursorUsage,
  findCursorChat,
  keepCursorTurnUsage,
  readCursorUsage,
} from "./cursor";
import { readPiUsage as readPi, readPiCompactSummary } from "./pi";
import type { SessionRead, UsageRecord } from "./records";

/** Most tests are about the records; the open turn has tests of its own. */
const recordsOf = async (read: Promise<SessionRead | undefined>) => (await read)?.records;
const readClaudeUsage = (...args: Parameters<typeof readClaude>) => recordsOf(readClaude(...args));
const readCodexUsage = (...args: Parameters<typeof readCodex>) => recordsOf(readCodex(...args));
const readPiUsage = (...args: Parameters<typeof readPi>) => recordsOf(readPi(...args));

const FIXTURES = join(import.meta.dir, "fixtures");
const CLAUDE = "11111111-1111-4111-8111-111111111111";
const CODEX = "22222222-2222-7222-8222-222222222222";
const PI = "44444444-4444-7444-8444-444444444444";
const PI_FILE = `--repo--/2026-09-23T17-31-15-224Z_${PI}.jsonl`;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A private copy, so a test can add to a transcript the way a live session does. */
function copy(harness: "claude" | "codex" | "pi"): string {
  const root = mkdtempSync(join(tmpdir(), "usage-"));
  roots.push(root);
  cpSync(join(FIXTURES, harness), root, { recursive: true });
  return root;
}

function sum(records: readonly UsageRecord[]): TokenUsage {
  const total = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  for (const { tokens } of records) {
    total.input += tokens.input;
    total.cacheRead += tokens.cacheRead;
    total.cacheWrite += tokens.cacheWrite;
    total.output += tokens.output;
  }
  return total;
}

describe("claude sessions", () => {
  test("a real transcript: one record per request, its whole last line", async () => {
    const records = await readClaudeUsage([CLAUDE], "/repo", join(FIXTURES, "claude/projects"));

    expect(records).toHaveLength(2);
    expect(records![0]).toEqual({
      key: "req_011CfLnxzTkNzXq88TxjueeY",
      at: "2026-09-23T17:49:31.595Z",
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      delegated: false,
      tokens: {
        input: 10,
        cacheRead: 24_572,
        cacheWrite: 10_943,
        cacheWrite1h: 10_943,
        output: 251,
        reasoning: 112,
      },
    });
  });

  // Ported from `braintrust/agent/loops/shared/usage/claude.test.ts`.
  type Row = {
    requestId?: string;
    model?: string;
    output?: number;
    write1h?: number;
    write5m?: number;
    written?: number;
    sidechain?: boolean;
  };

  function assistant(row: Row): string {
    return JSON.stringify({
      type: "assistant",
      ...(row.requestId === undefined ? {} : { requestId: row.requestId }),
      isSidechain: row.sidechain ?? false,
      timestamp: "2026-08-21T13:29:42.789Z",
      message: {
        model: row.model ?? "claude-opus-5",
        usage: {
          input_tokens: 2,
          cache_creation_input_tokens: row.written ?? 0,
          cache_read_input_tokens: 0,
          output_tokens: row.output ?? 0,
          ...(row.write1h === undefined && row.write5m === undefined
            ? {}
            : {
                cache_creation: {
                  ephemeral_1h_input_tokens: row.write1h ?? 0,
                  ephemeral_5m_input_tokens: row.write5m ?? 0,
                },
              }),
        },
      },
    });
  }

  const SESSION = "a9bfbb6d-a9e7-478b-ad89-a78b9324a3a8";
  const CWD = "/Users/roman/dev/braintrust/agent";
  const PROJECT = "-Users-roman-dev-braintrust-agent";

  function projects(files: Record<string, string[]>): string {
    const root = mkdtempSync(join(tmpdir(), "claude-usage-"));
    roots.push(root);
    for (const [relative, lines] of Object.entries(files)) {
      const path = join(root, relative);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, `${lines.join("\n")}\n`);
    }
    return root;
  }

  const read = (root: string, sessions = [SESSION]) => readClaudeUsage(sessions, CWD, root);

  test("keeps a request's last line in a file, because earlier ones are partial", async () => {
    const root = projects({
      [`${PROJECT}/${SESSION}.jsonl`]: [
        assistant({ requestId: "req_1", output: 6 }),
        assistant({ requestId: "req_1", output: 183 }),
      ],
    });
    expect((await read(root))!.map((record) => record.tokens.output)).toEqual([183]);
  });

  test("a forked subagent's partial copy of a request neither shrinks it nor claims it", async () => {
    const root = projects({
      [`${PROJECT}/${SESSION}.jsonl`]: [assistant({ requestId: "req_1", output: 700 })],
      [`${PROJECT}/${SESSION}/subagents/agent-fork.jsonl`]: [
        assistant({ requestId: "req_1", output: 9, sidechain: true }),
        assistant({ requestId: "req_2", output: 5, sidechain: true }),
      ],
    });
    const records = (await read(root))!;
    expect(records.find((record) => record.key === "req_1")).toMatchObject({
      delegated: false,
      tokens: { output: 700 },
    });
    expect(sum(records.filter((record) => record.delegated)).output).toBe(5);
  });

  test("counts subagents, however deep the harness nests them, as delegated", async () => {
    const root = projects({
      [`${PROJECT}/${SESSION}.jsonl`]: [assistant({ requestId: "req_1", output: 100 })],
      [`${PROJECT}/${SESSION}/subagents/agent-a1.jsonl`]: [
        assistant({ requestId: "req_2", output: 20, sidechain: true }),
      ],
      [`${PROJECT}/${SESSION}/subagents/workflows/wf_1/agent-a2.jsonl`]: [
        assistant({ requestId: "req_3", output: 7, sidechain: true }),
      ],
    });
    const records = (await read(root))!;
    expect(sum(records.filter((record) => !record.delegated)).output).toBe(100);
    expect(sum(records.filter((record) => record.delegated)).output).toBe(27);
  });

  test("splits cache writes by lifetime, and leaves it out when none was recorded", async () => {
    const root = projects({
      [`${PROJECT}/${SESSION}.jsonl`]: [
        assistant({ requestId: "req_1", write1h: 17_963, written: 17_963 }),
        assistant({ requestId: "req_2", written: 500 }),
      ],
    });
    const [timed, untimed] = (await read(root))!;
    expect(timed!.tokens).toMatchObject({ cacheWrite: 17_963, cacheWrite1h: 17_963 });
    expect(untimed!.tokens.cacheWrite).toBe(500);
    expect(untimed!.tokens).not.toHaveProperty("cacheWrite1h");
  });

  test.each([
    ["an api error placeholder", assistant({ requestId: "req_x", model: "<synthetic>" })],
    ["a line carrying no request id", assistant({ output: 900 })],
    ["a line carrying no usage", JSON.stringify({ type: "user", requestId: "req_y" })],
    ["a half-written line", '{"type":"assis'],
  ])("skips %s", async (_name, line) => {
    const root = projects({
      [`${PROJECT}/${SESSION}.jsonl`]: [assistant({ requestId: "req_1", output: 10 }), line],
    });
    const records = (await read(root))!;
    expect(records).toHaveLength(1);
    expect(records[0]!.tokens.output).toBe(10);
  });

  test("a copy in another file replaces a request only when it is larger", async () => {
    const root = projects({
      [`${PROJECT}/${SESSION}.jsonl`]: [assistant({ requestId: "req_1", output: 70, written: 5 })],
      [`${PROJECT}/${SESSION}/subagents/agent-fork.jsonl`]: [
        assistant({ requestId: "req_1", output: 70, written: 999, sidechain: true }),
      ],
    });
    expect((await read(root))![0]!.tokens.cacheWrite).toBe(5);
  });

  test("a resumed session's zeroed copy keeps the request's real figures", async () => {
    const root = projects({
      [`${PROJECT}/${SESSION}.jsonl`]: [
        assistant({ requestId: "req_1", output: 50, write1h: 900, written: 900 }),
      ],
      [`${PROJECT}/resumed.jsonl`]: [
        assistant({ requestId: "req_1", output: 0, write1h: 900, written: 0 }),
      ],
    });
    const [only] = (await read(root, [SESSION, "resumed"]))!;
    expect(only!.tokens).toMatchObject({ output: 50, cacheWrite: 900, cacheWrite1h: 900 });

    const zeroedAlone = projects({
      [`${PROJECT}/${SESSION}.jsonl`]: [assistant({ requestId: "req_1", write1h: 900 })],
    });
    expect((await read(zeroedAlone))![0]!.tokens.cacheWrite1h).toBe(0);
  });

  test("finds a session whose project directory is not the one the cwd derives", async () => {
    const root = projects({
      [`some-other-name/${SESSION}.jsonl`]: [assistant({ requestId: "req_1", output: 10 })],
    });
    expect(await read(root)).toHaveLength(1);
  });

  test("reads every session a cleared agent had, each request once", async () => {
    const root = projects({
      [`${PROJECT}/${SESSION}.jsonl`]: [assistant({ requestId: "req_1", output: 1 })],
      [`${PROJECT}/cleared.jsonl`]: [assistant({ requestId: "req_2", output: 2 })],
    });
    expect(sum((await read(root, [SESSION, "cleared", SESSION]))!).output).toBe(3);
  });

  test("is unknown for a session with no transcript, or an id that is a path", async () => {
    const root = projects({ [`${PROJECT}/${SESSION}.jsonl`]: [assistant({ requestId: "r" })] });
    expect(await read(root, ["missing"])).toBeUndefined();
    expect(await read(root, [`../${PROJECT}/${SESSION}`])).toBeUndefined();
  });
});

describe("codex sessions", () => {
  const sessions = join(FIXTURES, "codex/sessions");

  test("two turns: each rise in the totals is a request, input without the cached part", async () => {
    const records = (await readCodexUsage([CODEX], sessions))!;
    const own = records.filter((record) => !record.delegated);

    expect(own.map((record) => record.at)).toEqual([
      "2026-09-23T17:18:55.901Z",
      "2026-09-23T17:18:58.059Z",
      "2026-09-23T17:19:19.689Z",
      "2026-09-23T17:19:21.394Z",
    ]);
    expect(own[1]).toMatchObject({
      at: "2026-09-23T17:18:58.059Z",
      model: "gpt-5.6-terra",
      provider: "openai",
      delegated: false,
      tokens: { input: 788, cacheRead: 18_176, cacheWrite: 0, output: 16, reasoning: 0 },
    });
    // The differences add up to the rollout's final total, with the cached part moved out.
    expect(sum(own)).toEqual({
      input: 75_974 - 54_528,
      cacheRead: 54_528,
      cacheWrite: 0,
      output: 295,
    });
  });

  test("a subagent's rollout names the root session, and its spend is delegated", async () => {
    const records = (await readCodexUsage([CODEX], sessions))!;
    const delegated = records.filter((record) => record.delegated);

    expect(delegated).toHaveLength(1);
    expect(delegated[0]).toMatchObject({
      model: "codex-auto-review",
      tokens: { input: 23_389 - 4_864, cacheRead: 4_864, output: 104, reasoning: 41 },
    });
  });

  function rollout(root: string, day: string, id: string, rows: object[]): void {
    const directory = join(root, day);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, `rollout-2026-09-23T10-00-00-${id}.jsonl`),
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    );
  }
  const meta = (id: string, session = id) => ({
    timestamp: "2026-09-23T10:00:00.000Z",
    type: "session_meta",
    payload: { session_id: session, id },
  });
  const context = (model: string) => ({ timestamp: "t", type: "turn_context", payload: { model } });
  const counted = (at: string, total: number[], last: number[] | null) => ({
    timestamp: at,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: last && {
        total_token_usage: {
          input_tokens: total[0],
          cached_input_tokens: total[1],
          output_tokens: total[2],
        },
        last_token_usage: {
          input_tokens: last[0],
          cached_input_tokens: last[1],
          output_tokens: last[2],
        },
      },
    },
  });

  test("a rollout opening on a compacted thread's totals, repeats, resets and a model change", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-usage-"));
    roots.push(root);
    rollout(root, "2026/09/23", "abc", [
      meta("abc"),
      counted("2026-09-23T10:00:01Z", [9_000_000, 8_000_000, 50_000], [0, 0, 0]),
      counted("2026-09-23T10:00:02Z", [9_000_000, 8_000_000, 50_000], null),
      context("gpt-5.6-terra"),
      counted("2026-09-23T10:00:03Z", [9_000_100, 8_000_060, 50_010], [100, 60, 10]),
      counted("2026-09-23T10:00:03Z", [9_000_100, 8_000_060, 50_010], [100, 60, 10]),
      context("gpt-5.6-sol"),
      // A reset whose new total is still above the old one.
      counted("2026-09-23T10:00:04Z", [9_500_000, 0, 60_000], [200, 50, 20]),
    ]);

    const records = (await readCodexUsage(["abc"], root))!;
    expect(
      records.map(({ model, tokens }) => [model, tokens.input, tokens.cacheRead, tokens.output]),
    ).toEqual([
      ["gpt-5.6-terra", 40, 60, 10],
      ["gpt-5.6-sol", 150, 50, 20],
    ]);
  });

  test("per-response rows, where logged, count a compaction and skip a parent's rows", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-usage-"));
    roots.push(root);
    const response = (id: string, thread: string, turn: string, usage: number[]) => ({
      timestamp: "2026-09-23T10:00:05Z",
      type: "token_usage_record",
      payload: {
        thread_id: thread,
        turn_id: turn,
        response_id: id,
        usage: { input_tokens: usage[0], cached_input_tokens: usage[1], output_tokens: usage[2] },
      },
    });
    rollout(root, "2026/09/23", "abc", [
      meta("abc"),
      { timestamp: "t", type: "turn_context", payload: { model: "gpt-5.6-sol", turn_id: "t1" } },
      response("resp_1", "abc", "t1", [100, 40, 10]),
      counted("2026-09-23T10:00:06Z", [100, 40, 10], [100, 40, 10]),
      // A remote compaction logs a response and no token_count.
      response("resp_2", "abc", "t1", [233_334, 0, 1_250]),
      response("resp_0", "parent", "t0", [9, 0, 9]),
    ]);

    const records = (await readCodexUsage(["abc"], root))!;
    expect(
      records.map(({ key, model, tokens }) => [key, model, tokens.input, tokens.output]),
    ).toEqual([
      ["resp_1", "gpt-5.6-sol", 60, 10],
      ["resp_2", "gpt-5.6-sol", 233_334, 1_250],
    ]);
  });

  test("a real 0.156 rollout: per-response rows agree with its token counts", async () => {
    const records = (await readCodexUsage(["66666666-6666-7666-8666-666666666666"], sessions))!;
    expect(records.map((record) => record.key.slice(0, 5))).toEqual([
      "resp_",
      "resp_",
      "resp_",
      "resp_",
    ]);
    expect(sum(records)).toEqual({
      input: 75_974 - 54_528,
      cacheRead: 54_528,
      cacheWrite: 0,
      output: 295,
    });
    expect(records.every((record) => record.model === "gpt-5.6-terra")).toBe(true);
  });

  test("a session resumed on a newer CLI keeps its earlier token counts", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-usage-"));
    roots.push(root);
    rollout(root, "2026/09/23", "abc", [
      { ...meta("abc"), payload: { session_id: "abc", id: "abc", model_provider: "azure" } },
      context("gpt-5.6-terra"),
      counted("2026-09-23T10:00:01Z", [100, 0, 10], [100, 0, 10]),
      {
        timestamp: "2026-09-23T10:00:02Z",
        type: "token_usage_record",
        payload: {
          thread_id: "abc",
          response_id: "resp_1",
          usage: { input_tokens: 50, cached_input_tokens: 0, output_tokens: 5 },
        },
      },
      counted("2026-09-23T10:00:02Z", [150, 0, 15], [50, 0, 5]),
    ]);

    const records = (await readCodexUsage(["abc"], root))!;
    expect(records.map(({ key, provider, tokens }) => [key, provider, tokens.output])).toEqual([
      ["abc#2", "azure", 10],
      ["resp_1", "azure", 5],
    ]);
  });

  test("a subagent is looked for only from its root's day onward, and matched exactly", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-usage-"));
    roots.push(root);
    rollout(root, "2026/09/23", "root-1", [
      meta("root-1"),
      counted("2026-09-23T10:00:01Z", [10, 0, 1], [10, 0, 1]),
    ]);
    rollout(root, "2026/09/24", "child", [
      meta("child", "root-1"),
      counted("2026-09-24T10:00:01Z", [20, 0, 2], [20, 0, 2]),
    ]);
    rollout(root, "2026/09/22", "earlier", [
      meta("earlier", "root-1"),
      counted("2026-09-22T10:00:01Z", [30, 0, 3], [30, 0, 3]),
    ]);

    const records = (await readCodexUsage(["root-1"], root))!;
    expect(records.map(({ delegated, tokens }) => [delegated, tokens.output])).toEqual([
      [false, 1],
      [true, 2],
    ]);
    expect(await readCodexUsage(["oot-1"], root)).toBeUndefined();
  });

  test("a fork given its parent's session id is a session of its own, not its parent's subagent", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-usage-"));
    roots.push(root);
    const withSource = (row: ReturnType<typeof meta>, source: unknown) => ({
      ...row,
      payload: { ...row.payload, source },
    });
    rollout(root, "2026/09/23", "root-1", [
      withSource(meta("root-1"), "exec"),
      counted("2026-09-23T10:00:01Z", [10, 0, 1], [10, 0, 1]),
    ]);
    rollout(root, "2026/09/23", "fork-1", [
      withSource(meta("fork-1", "root-1"), "exec"),
      counted("2026-09-23T10:00:02Z", [20, 0, 2], [20, 0, 2]),
    ]);
    rollout(root, "2026/09/23", "child", [
      withSource(meta("child", "root-1"), { subagent: { other: "guardian" } }),
      counted("2026-09-23T10:00:03Z", [30, 0, 3], [30, 0, 3]),
    ]);

    const records = (await readCodexUsage(["root-1"], root))!;
    expect(records.map(({ delegated, tokens }) => [delegated, tokens.output])).toEqual([
      [false, 1],
      [true, 3],
    ]);
    const fork = (await readCodexUsage(["fork-1"], root))!;
    expect(fork.map(({ delegated, tokens }) => [delegated, tokens.output])).toEqual([[false, 2]]);
  });

  test("a subagent is its spawner's, a fork's under its root's session id and a nested one's too", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-usage-"));
    roots.push(root);
    const spawned = (id: string, parent: string) => ({
      ...meta(id, "root-1"),
      payload: {
        ...meta(id, "root-1").payload,
        parent_thread_id: parent,
        source: { subagent: {} },
      },
    });
    const own = (id: string) => ({
      ...meta(id, "root-1"),
      payload: { ...meta(id, "root-1").payload, source: "exec" },
    });
    rollout(root, "2026/09/23", "root-1", [
      own("root-1"),
      counted("2026-09-23T10:00:01Z", [10, 0, 1], [10, 0, 1]),
    ]);
    rollout(root, "2026/09/24", "fork-1", [
      own("fork-1"),
      counted("2026-09-24T10:00:01Z", [20, 0, 2], [20, 0, 2]),
    ]);
    rollout(root, "2026/09/24", "helper", [
      spawned("helper", "fork-1"),
      counted("2026-09-24T10:00:02Z", [30, 0, 3], [30, 0, 3]),
    ]);
    rollout(root, "2026/09/25", "nested", [
      spawned("nested", "helper"),
      counted("2026-09-25T10:00:03Z", [40, 0, 4], [40, 0, 4]),
    ]);
    rollout(root, "2026/09/25", "guard", [
      spawned("guard", "root-1"),
      counted("2026-09-25T10:00:04Z", [50, 0, 5], [50, 0, 5]),
    ]);

    const outputs = async (id: string) =>
      (await readCodexUsage([id], root))!.map(({ delegated, tokens }) => [
        delegated,
        tokens.output,
      ]);
    expect(await outputs("root-1")).toEqual([
      [false, 1],
      [true, 5],
    ]);
    expect(await outputs("fork-1")).toEqual([
      [false, 2],
      [true, 3],
      [true, 4],
    ]);
  });

  test("a fork is given its parent's session id, in its own rollout only", async () => {
    const home = mkdtempSync(join(tmpdir(), "codex-home-"));
    roots.push(home);
    const sessions = join(home, "sessions");
    const day = "2026/09/23";
    rollout(sessions, day, "parent", [
      { type: "session_meta", payload: { session_id: "root", id: "parent" } },
    ]);
    const forkRow = {
      type: "session_meta",
      payload: { session_id: "fork", id: "fork", forked_from_id: "parent", source: "exec" },
    };
    rollout(sessions, day, "fork", [forkRow, { type: "event_msg", payload: { n: 1 } }]);
    rollout(sessions, day, "stray", [
      { ...forkRow, payload: { ...forkRow.payload, id: "stray", forked_from_id: "other" } },
    ]);

    await inheritCodexSessionId(home, "parent", "fork");
    const file = join(sessions, day, "rollout-2026-09-23T10-00-00-fork.jsonl");
    const [head, rest] = readFileSync(file, "utf8").split("\n");
    expect(JSON.parse(head!).payload).toMatchObject({ session_id: "root", id: "fork" });
    expect(JSON.parse(rest!)).toEqual({ type: "event_msg", payload: { n: 1 } });
    // Again is a no-op.
    await inheritCodexSessionId(home, "parent", "fork");

    await expect(inheritCodexSessionId(home, "parent", "stray")).rejects.toThrow(
      "is not stray's fork of parent",
    );
    await expect(inheritCodexSessionId(home, "parent", "missing")).rejects.toThrow("no rollout");
    // A codex that writes no session id leaves the fork as it made it.
    rollout(sessions, day, "old", [
      { type: "session_meta", payload: { id: "old", forked_from_id: "parent" } },
    ]);
    await inheritCodexSessionId(home, "parent", "old");
    // A rollout the agent swapped for a link is not written through.
    const outside = join(home, "outside.jsonl");
    writeFileSync(outside, `${JSON.stringify(forkRow)}\n`);
    rmSync(file);
    symlinkSync(outside, file);
    await expect(inheritCodexSessionId(home, "parent", "fork")).rejects.toThrow("is a link");
    expect(readFileSync(outside, "utf8")).toContain('"session_id":"fork"');
  });

  test("a half-written last line is ignored, and a missing or hostile id is unknown", async () => {
    const root = copy("codex");
    appendFileSync(
      join(root, `sessions/2026/09/23/rollout-2026-09-23T13-18-44-${CODEX}.jsonl`),
      '{"timestamp":"2026-09-23T17:19:30.000Z","type":"event_msg","payload":{"type":"token_co',
    );
    expect(await readCodexUsage([CODEX], join(root, "sessions"))).toHaveLength(5);
    expect(
      await readCodexUsage(["01a0cf46-0000-0000-0000-000000000000"], sessions),
    ).toBeUndefined();
    expect(await readCodexUsage(["../22/rollout"], sessions)).toBeUndefined();
  });
});

describe("a claude pane's session in a sandbox, which Herdr does not name", () => {
  test("is the earliest started since its launch, in its directory, whose transcript holds its operation's id", async () => {
    const home = mkdtempSync(join(tmpdir(), "claude-find-"));
    const directory = join(home, "projects", "-repo");
    mkdirSync(directory, { recursive: true });
    const since = Date.now() - 60_000;
    const transcript = (id: string, startedAt: number, text: string) =>
      writeFileSync(
        join(directory, `${id}.jsonl`),
        `${JSON.stringify({ timestamp: new Date(startedAt).toISOString(), text })}\n`,
      );
    transcript("earlier", since - 1_000, "wf result op-1");
    transcript("mine", since + 1_000, "wf result op-1");
    transcript("other", since + 2_000, "wf result op-2");
    try {
      expect(await findClaudeSession("op-1", since, "/repo", home)).toBe("mine");
      expect(await findClaudeSession("op-3", since, "/repo", home)).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("a codex pane's session, which Herdr does not name", () => {
  test("is the earliest started in its directory since its launch whose rollout holds its operation's id", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-find-"));
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const day = join(root, `${now.getFullYear()}`, pad(now.getMonth() + 1), pad(now.getDate()));
    mkdirSync(day, { recursive: true });
    const since = Date.now() - 60_000;
    const rollout = (id: string, startedAt: number, cwd: string, text: string) =>
      writeFileSync(
        join(day, `rollout-2026-10-03T10-00-00-${id}.jsonl`),
        `${JSON.stringify({ type: "session_meta", payload: { id, timestamp: new Date(startedAt).toISOString(), cwd } })}\n${text}\n`,
      );
    rollout("operator", since - 1_000, "/repo", "wf result op-1");
    rollout("elsewhere", since + 1_000, "/other", "wf result op-1");
    rollout("mine", since + 2_000, "/repo", "wf result op-1");
    rollout("subagent", since + 3_000, "/repo", "from op-1");
    try {
      expect(await findCodexSession("op-1", since, "/repo", root)).toBe("mine");
      expect(await findCodexSession("op-2", since, "/repo", root)).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("pi sessions", () => {
  const agent = join(FIXTURES, "pi");

  test("each completed request is a record; a failed one is skipped", async () => {
    const records = (await readPiUsage([PI], agent))!;

    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      at: "2026-09-23T17:31:23.142Z",
      model: "gpt-5.6-terra",
      provider: "openai-codex",
      delegated: false,
      tokens: { input: 4317, cacheRead: 2560, cacheWrite: 0, output: 55, reasoning: 9 },
    });
  });

  test("the pane's path and the launcher's id are one session, read once", async () => {
    const path = join(agent, "sessions", PI_FILE);
    expect(await readPiUsage([PI, path], agent)).toHaveLength(2);
  });

  test("a forked session's copy of its parent's entries is counted once", async () => {
    const root = copy("pi");
    const original = join(root, "sessions", PI_FILE);
    cpSync(original, join(root, "sessions/--repo--/2026-09-23T18-00-00-000Z_fork.jsonl"));
    expect(await readPiUsage([PI, "fork"], root)).toHaveLength(2);
  });

  test("a parent and two forks share its id: the id reads the parent, each fork's path only its own", async () => {
    const root = copy("pi");
    const original = join(root, "sessions", PI_FILE);
    // Two levels below the root, where pi's lookup by id, one level deep, never reaches.
    const forks = ["a", "b"].map((dir) => {
      const directory = join(root, "sessions", "awf-forks", dir);
      mkdirSync(directory, { recursive: true });
      const file = join(directory, `2026-09-23T18-00-00-000Z_${PI}.jsonl`);
      cpSync(original, file);
      appendFileSync(
        file,
        `${JSON.stringify({
          type: "message",
          id: `own-${dir}`,
          timestamp: "2026-09-23T18:00:01.000Z",
          message: { role: "assistant", model: "m", usage: { input: 1, output: 1 } },
        })}\n`,
      );
      return file;
    });
    mkdirSync(join(root, "sessions", "zz-project"));
    expect(await readPiUsage([PI], root)).toHaveLength(2);
    for (const [index, fork] of forks.entries()) {
      const read = (await readPiUsage([fork], root))!;
      expect(read).toHaveLength(3);
      expect(read.at(-1)?.key).toBe(`own-${"ab"[index]}@2026-09-23T18:00:01.000Z`);
    }
  });

  test("the last compaction's summary, by the pane's path or the launcher's id", async () => {
    const root = copy("pi");
    const path = join(root, "sessions", PI_FILE);
    expect(await readPiCompactSummary(path, root)).toBeUndefined();
    for (const summary of ["first", "second"]) {
      appendFileSync(path, `${JSON.stringify({ type: "compaction", id: summary, summary })}\n`);
    }
    expect(await readPiCompactSummary(path, root)).toBe("second");
    expect(await readPiCompactSummary(PI, root)).toBe("second");
  });

  test("a path outside pi's sessions, a missing id, or a half-written line", async () => {
    const root = copy("pi");
    appendFileSync(join(root, "sessions", PI_FILE), '{"type":"message","id":"x","mess');
    expect(await readPiUsage([PI], root)).toHaveLength(2);
    expect(await readPiUsage([join(FIXTURES, "codex/sessions/x.jsonl")], agent)).toBeUndefined();
    expect(await readPiUsage(["missing"], agent)).toBeUndefined();
  });
});

describe("cursor chats", () => {
  const printed = (requestId: string, input: number) =>
    `${JSON.stringify({
      type: "result",
      session_id: "chat-1",
      request_id: requestId,
      usage: { inputTokens: input, outputTokens: 7, cacheReadTokens: 900, cacheWriteTokens: 3 },
    })}\n`;
  const chatHome = () => {
    const home = mkdtempSync(join(tmpdir(), "cursor-"));
    roots.push(home);
    const chat = join(home, "chats", "workspace", "chat-1");
    mkdirSync(chat, { recursive: true });
    writeFileSync(join(chat, "meta.json"), "{}");
    writeFileSync(join(chat, "store.db"), "");
    return { home, chat };
  };

  test("a headless turn's printed usage is kept beside its chat, one record a request", async () => {
    const { home } = chatHome();
    await keepCursorTurnUsage(printed("r-1", 40), "chat-1", "composer-2.5", home);
    await keepCursorTurnUsage(printed("r-2", 12), "chat-1", "composer-2.5", home);
    const read = await readCursorUsage(["chat-1"], home);
    expect(read?.open).toBe(false);
    expect(
      read?.records.map(({ key, model, delegated, tokens }) => ({ key, model, delegated, tokens })),
    ).toEqual([
      {
        key: "r-1",
        model: "composer-2.5",
        delegated: false,
        tokens: { input: 40, cacheRead: 900, cacheWrite: 3, output: 7 },
      },
      {
        key: "r-2",
        model: "composer-2.5",
        delegated: false,
        tokens: { input: 12, cacheRead: 900, cacheWrite: 3, output: 7 },
      },
    ]);
    expect(await readCursorUsage(["chat-2", "../chat-1"], home)).toBeUndefined();
    // A turn that printed no usage, as one cut off, spent what nobody knows.
    await keepCursorTurnUsage("", "chat-1", "composer-2.5", home);
    expect(await readCursorUsage(["chat-1"], home)).toBeUndefined();
  });

  test("a home's chats, and a chat's own files without the usage awf kept", async () => {
    const { home } = chatHome();
    await keepCursorTurnUsage(printed("r-1", 40), "chat-1", undefined, home);
    expect(await cursorHomeSessions(home)).toEqual(["chat-1"]);
    expect((await cursorSessionFiles(home, "chat-1"))?.sort()).toEqual([
      "chats/workspace/chat-1/meta.json",
      "chats/workspace/chat-1/store.db",
    ]);
    await dropCursorUsage("chat-1", home);
    // With none kept, as for a pane, its usage is unknown.
    expect(await readCursorUsage(["chat-1"], home)).toBeUndefined();
  });

  test("a sandboxed pane's chat is the earliest begun in its home since it launched", async () => {
    const { home } = chatHome();
    const begin = (chat: string, createdAtMs: number) => {
      mkdirSync(join(home, "chats", "workspace", chat), { recursive: true });
      writeFileSync(
        join(home, "chats", "workspace", chat, "meta.json"),
        JSON.stringify({ createdAtMs }),
      );
    };
    writeFileSync(join(home, "chats", "workspace", "chat-1", "meta.json"), '{"createdAtMs":100}');
    begin("chat-3", 300);
    begin("chat-2", 200);
    expect(await findCursorChat(150, home)).toBe("chat-2");
    expect(await findCursorChat(400, home)).toBeUndefined();
  });

  test("nothing is written through a link an agent put in its home", async () => {
    const { home, chat } = chatHome();
    const outside = mkdtempSync(join(tmpdir(), "outside-"));
    roots.push(outside);
    mkdirSync(join(outside, "chat-2"));
    symlinkSync(outside, join(home, "chats", "elsewhere"));
    await keepCursorTurnUsage(printed("r-1", 40), "chat-2", undefined, home);
    expect(() => readFileSync(join(outside, "chat-2", "awf-usage.jsonl"))).toThrow();
    const target = join(outside, "target");
    writeFileSync(target, "");
    symlinkSync(target, join(chat, "awf-usage.jsonl"));
    await expect(
      keepCursorTurnUsage(printed("r-1", 40), "chat-1", undefined, home),
    ).rejects.toThrow();
    expect(readFileSync(target, "utf8")).toBe("");
    // Nor is a usage file read through one: the operator's chats counted as the agent's.
    writeFileSync(target, `${JSON.stringify({ key: "x", at: "t", tokens: { input: 1 } })}\n`);
    expect(await readCursorUsage(["chat-1"], home)).toBeUndefined();
  });

  test("nothing is read or written where an agent swapped its home for a link", async () => {
    const { home } = chatHome();
    const swapped = `${home}-swapped`;
    roots.push(swapped);
    await keepCursorTurnUsage(printed("r-1", 40), "chat-1", undefined, home);
    renameSync(home, swapped);
    symlinkSync(swapped, home);
    await keepCursorTurnUsage(printed("r-2", 40), "chat-1", undefined, home);
    expect(
      readFileSync(join(swapped, "chats", "workspace", "chat-1", "awf-usage.jsonl"), "utf8"),
    ).not.toContain("r-2");
    expect(await readCursorUsage(["chat-1"], home)).toBeUndefined();
    expect(await cursorHomeSessions(home)).toEqual([]);
  });
});

describe("a turn still being written", () => {
  test("claude never waits: an answered agent's session ends on its wf call for good", async () => {
    const root = mkdtempSync(join(tmpdir(), "claude-open-"));
    roots.push(root);
    mkdirSync(join(root, "-repo"), { recursive: true });
    // The tail every awf-launched claude session has: the `wf result` call, its result, nothing.
    const rows = [
      {
        type: "assistant",
        requestId: "r",
        timestamp: "t",
        message: { model: "m", stop_reason: "tool_use", usage: {} },
      },
      { type: "user", timestamp: "t", message: { content: [{ type: "tool_result" }] } },
    ];
    writeFileSync(join(root, "-repo/s.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n"));
    expect((await readClaude(["s"], "/repo", root))?.open).toBe(false);
  });

  test("codex: open from a task's start until it completes or is aborted", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-open-"));
    roots.push(root);
    const rollout = (...events: string[]) => {
      mkdirSync(join(root, "2026/09/23"), { recursive: true });
      const rows = events.map((type) => ({ timestamp: "t", type: "event_msg", payload: { type } }));
      writeFileSync(
        join(root, "2026/09/23/rollout-2026-09-23T10-00-00-abc.jsonl"),
        rows.map((row) => JSON.stringify(row)).join("\n"),
      );
      return readCodex(["abc"], root).then((read) => read?.open);
    };
    expect(await rollout("task_started")).toBe(true);
    expect(await rollout("task_started", "task_complete")).toBe(false);
    expect(await rollout("task_started", "turn_aborted")).toBe(false);
    expect(await rollout("task_started", "task_complete", "task_started")).toBe(true);
  });

  test("a headless codex turn is never open: the host has ended its process", async () => {
    const home = mkdtempSync(join(tmpdir(), "codex-home-"));
    roots.push(home);
    mkdirSync(join(home, "sessions/2026/09/23"), { recursive: true });
    writeFileSync(
      join(home, "sessions/2026/09/23/rollout-2026-09-23T10-00-00-abc.jsonl"),
      JSON.stringify({ timestamp: "t", type: "event_msg", payload: { type: "task_started" } }),
    );
    const codex = { harness: "codex", model: "gpt-5.6-terra" };
    const before = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    try {
      const accounting = createSessionAccounting(unreachable);
      expect((await accounting.read(codex, ["abc"], "/repo"))?.open).toBe(true);
      expect(
        (await accounting.read({ ...codex, placement: "headless" }, ["abc"], "/repo"))?.open,
      ).toBe(false);
    } finally {
      if (before === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = before;
    }
  });

  test("a pi calling session whose records name no provider is unknown, not pi's default", async () => {
    const accounting = createSessionAccounting(unreachable);
    const caller = { harness: "pi", model: "", caller: true as const };
    expect(await accounting.billing(caller, [])).toBe("unknown");
  });

  test("pi never waits: its process has ended by the time the run has", async () => {
    const root = copy("pi");
    appendFileSync(
      join(root, "sessions", PI_FILE),
      `${JSON.stringify({ type: "message", id: "q", timestamp: "t", message: { role: "assistant", stopReason: "toolUse", usage: {} } })}\n`,
    );
    expect((await readPi([PI], root))?.open).toBe(false);
  });
});

describe("billing", () => {
  test("claude: a claude.ai login is a subscription, any other login is metered", () => {
    const status = (fields: object) => JSON.stringify({ loggedIn: true, ...fields });
    expect(claudeBilling(status({ authMethod: "claude.ai", subscriptionType: "max" }))).toBe(
      "subscription",
    );
    expect(claudeBilling(status({ authMethod: "oauth_token" }))).toBe("subscription");
    expect(claudeBilling(status({ authMethod: "api_key" }))).toBe("metered");
    expect(claudeBilling(status({ authMethod: "third_party", apiProvider: "bedrock" }))).toBe(
      "metered",
    );
    expect(claudeBilling(status({ authMethod: "none" }))).toBe("unknown");
    expect(claudeBilling(JSON.stringify({ loggedIn: false }))).toBe("unknown");
    expect(claudeBilling("not json")).toBe("unknown");
  });

  test("codex: ChatGPT is a subscription, an API key is metered", () => {
    expect(codexBilling("Logged in using ChatGPT\n")).toBe("subscription");
    expect(codexBilling("Logged in using an API key - sk-proj-***\n")).toBe("metered");
    expect(codexBilling("Not logged in\n")).toBe("unknown");
  });

  test("codex reads the status it prints on stderr", async () => {
    const run = async () => ({
      stdout: "",
      stderr: "Logged in using ChatGPT\n",
      exitCode: 0,
      timedOut: false,
    });
    expect(await readCodexBilling(run)).toBe("subscription");
    expect(await readCodexBilling(async () => ({ ...(await run()), exitCode: 127 }))).toBe(
      "unknown",
    );
  });

  test("pi: the provider pi logged decides, else the model's, else pi's default", () => {
    const auth = JSON.stringify({ "openai-codex": { type: "oauth" }, openai: { type: "api_key" } });
    const settings = JSON.stringify({ defaultProvider: "openai-codex" });
    expect(piBilling(auth, settings, "gpt-5.6-terra", "openai")).toBe("metered");
    expect(piBilling(auth, settings, "openai-codex/gpt-5.6-terra", undefined)).toBe("subscription");
    expect(piBilling(auth, settings, "openai/gpt-5.6-terra", undefined)).toBe("metered");
    expect(piBilling(auth, settings, "gpt-5.6-terra", undefined)).toBe("subscription");
    expect(piBilling(auth, "", "anthropic/claude-opus-5", undefined)).toBe("unknown");
  });

  test("a headless claude agent is charged whatever its login; a pane asks the login", async () => {
    const statuses: string[][] = [];
    const run = async (input: { argv: readonly string[] }) => {
      statuses.push([...input.argv]);
      return {
        stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }),
        stderr: "",
        exitCode: 0,
        timedOut: false,
      };
    };
    const claude = { harness: "claude", model: "sonnet" };
    const accounting = createSessionAccounting(run);

    expect(await accounting.billing({ ...claude, placement: "headless" }, undefined)).toBe(
      "metered",
    );
    expect(await accounting.billing(claude, undefined)).toBe("subscription");
    expect(statuses).toEqual([["claude", "auth", "status", "--json"]]);
    expect(await accounting.billing({ harness: "cursor", model: "x" }, undefined)).toBe("unknown");
  });

  test("billing follows the provider the records name, and two providers say nothing", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-agent-"));
    roots.push(root);
    writeFileSync(
      join(root, "auth.json"),
      JSON.stringify({ "openai-codex": { type: "oauth" }, openai: { type: "api_key" } }),
    );
    process.env.PI_CODING_AGENT_DIR = root;
    try {
      const accounting = createSessionAccounting(unreachable);
      const pi = { harness: "pi", model: "gpt-5.6-terra" };
      const made = (provider: string) =>
        ({ key: provider, at: "t", model: "m", provider, delegated: false, tokens: none }) as const;
      expect(await accounting.billing(pi, [made("openai")])).toBe("metered");
      expect(await accounting.billing(pi, [made("openai-codex")])).toBe("subscription");
      expect(await accounting.billing(pi, [made("openai"), made("openai-codex")])).toBe("unknown");
      expect(
        await accounting.billing({ harness: "codex", model: "gpt-5.6-terra" }, [made("azure")]),
      ).toBe("unknown");
    } finally {
      delete process.env.PI_CODING_AGENT_DIR;
    }
  });
});

const none = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };

async function unreachable(): Promise<never> {
  throw new Error("no status command should run");
}

describe("a sandboxed agent's own home", () => {
  test("is where its usage is read, for each harness", async () => {
    const accounting = createSessionAccounting();
    const saved = {
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
      CODEX_HOME: process.env.CODEX_HOME,
      PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    };
    // The operator's homes hold none of these sessions, so only the agent's can answer.
    const empty = mkdtempSync(join(tmpdir(), "operator-"));
    roots.push(empty);
    for (const name of Object.keys(saved)) process.env[name] = empty;
    try {
      for (const [harness, session] of [
        ["claude", CLAUDE],
        ["codex", CODEX],
        ["pi", PI],
      ] as const) {
        const execution = { harness, model: "m", placement: "headless" as const };
        const home = join(FIXTURES, harness);
        expect(await accounting.read(execution, [session], "/repo")).toBeUndefined();
        const read = await accounting.read(execution, [session], "/repo", home);
        expect(read?.records.length).toBeGreaterThan(0);
        // No session named at all, as for a pane that never called `wf`: its home names them.
        const unnamed = await accounting.read(execution, [], "/repo", home);
        expect(unnamed?.records).toEqual(expect.arrayContaining(read!.records));
      }
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});
