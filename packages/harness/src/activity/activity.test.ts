import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cut, maskCredentials } from "./mask";
import { readActivity } from "./read";

const dir = mkdtempSync(join(tmpdir(), "awf-activity-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let files = 0;
const file = (...rows: object[]) => {
  files += 1;
  const path = join(dir, `${files}.jsonl`);
  writeFileSync(path, rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
  return path;
};
const activities = async (harness: string, path: string) =>
  (await readActivity(harness, path)).rows.map((row) => row.activity);

const at = "2026-10-11T09:00:00.000Z";

describe("claude", () => {
  test("messages, tool calls with their results, a background task and a compaction", async () => {
    const path = file(
      { type: "user", timestamp: at, message: { role: "user", content: "Fix the bug." } },
      { type: "user", timestamp: at, isMeta: true, message: { role: "user", content: "meta" } },
      {
        type: "assistant",
        timestamp: at,
        message: {
          content: [
            { type: "thinking", thinking: "hmm" },
            { type: "text", text: "Looking." },
            { type: "tool_use", id: "t1", name: "Bash", input: { command: "bun test" } },
            {
              type: "tool_use",
              id: "t2",
              name: "Bash",
              input: { command: "bun run eval", run_in_background: true },
            },
          ],
        },
      },
      {
        type: "user",
        timestamp: at,
        message: {
          content: [{ type: "tool_result", tool_use_id: "t1", content: "1 fail", is_error: true }],
        },
      },
      { type: "system", subtype: "compact_boundary", timestamp: at },
      { type: "file-history-snapshot", messageId: "x" },
    );
    expect(await activities("claude", path)).toEqual([
      { type: "message", from: "user", chars: 12 },
      { type: "message", from: "agent", chars: 8 },
      { type: "tool", tool: "Bash", input: "bun test", call: "t1" },
      { type: "tool", tool: "Bash", input: "bun run eval", call: "t2", background: true },
      { type: "tool-result", call: "t1", error: true },
      { type: "compaction" },
    ]);
  });
});

describe("claude's own rows", () => {
  test("a slash command and a compaction summary are not the user's; a task notification ends a background task", async () => {
    const user = (content: unknown, extra: object = {}) => ({
      type: "user",
      timestamp: at,
      message: { role: "user", content },
      ...extra,
    });
    const path = file(
      user("<command-name>/cost</command-name>"),
      user("<local-command-stdout>$0.10</local-command-stdout>"),
      user("This session is being continued…", { isCompactSummary: true }),
      user([
        { type: "text", text: "<task-notification><task-id>b1</task-id></task-notification>" },
      ]),
      user("<b>bold</b> prompt"),
    );
    expect(await activities("claude", path)).toEqual([
      { type: "background-ended" },
      { type: "message", from: "user", chars: 18 },
    ]);
  });
});

describe("codex", () => {
  test("messages, a shell call and a code-mode call with their outputs, and a compaction", async () => {
    const item = (payload: object) => ({ timestamp: at, type: "response_item", payload });
    const path = file(
      { timestamp: at, type: "session_meta", payload: { id: "thread-1" } },
      item({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "<environment_context>…" }],
      }),
      item({ type: "message", role: "user", content: [{ type: "input_text", text: "Review." }] }),
      item({
        type: "function_call",
        name: "shell",
        call_id: "c1",
        arguments: JSON.stringify({ command: ["rg", "-n", "readUntilSettled"] }),
      }),
      item({
        type: "function_call_output",
        call_id: "c1",
        output: JSON.stringify({ output: "", metadata: { exit_code: 1 } }),
      }),
      item({
        type: "custom_tool_call",
        name: "exec",
        call_id: "c2",
        input:
          'text(await tools.exec_command({cmd: "bun test run-usage <<\'X\'\\n{\\"a\\":1}\\nX"}))',
      }),
      item({
        type: "custom_tool_call_output",
        call_id: "c2",
        output: [{ type: "input_text", text: 'Script completed\n{"exit_code":0}' }],
      }),
      item({ type: "reasoning", summary: [] }),
      item({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Done." }],
      }),
      { timestamp: at, type: "compacted", payload: {} },
    );
    expect(await activities("codex", path)).toEqual([
      { type: "message", from: "user", chars: 7 },
      { type: "tool", tool: "shell", input: "rg -n readUntilSettled", call: "c1" },
      { type: "tool-result", call: "c1", error: true, exit: 1 },
      // The script's string literal, its escapes read.
      { type: "tool", tool: "exec", input: `bun test run-usage <<'X' {"a":1} X`, call: "c2" },
      // Its output prints an exit code, but as text: not taken.
      { type: "tool-result", call: "c2" },
      { type: "message", from: "agent", chars: 5 },
      { type: "compaction" },
    ]);
  });

  test("an in-place rewrite at the same length keeps every offset", async () => {
    const row = (text: string) => ({
      timestamp: at,
      type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
    });
    const path = file(row("first"), row("second"));
    const before = await readActivity("codex", path);
    // Codex rewrites its session id in place, at the same length.
    writeFileSync(
      path,
      [row("FIRST"), row("second")].map((each) => `${JSON.stringify(each)}\n`).join(""),
    );
    const after = await readActivity("codex", path);
    expect(after.rows.map((each) => each.offset)).toEqual(before.rows.map((each) => each.offset));
    expect(after.offset).toBe(before.offset);
  });
});

describe("pi", () => {
  test("messages, a tool call with its result, and a compaction", async () => {
    const path = file(
      { type: "session", id: "s", timestamp: at },
      {
        type: "message",
        timestamp: at,
        message: { role: "user", content: [{ type: "text", text: "Go." }] },
      },
      {
        type: "message",
        timestamp: at,
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "On it." },
            { type: "toolCall", id: "p1", name: "bash", arguments: { command: "ls" } },
          ],
        },
      },
      {
        type: "message",
        timestamp: at,
        message: {
          role: "toolResult",
          toolCallId: "p1",
          content: [{ type: "text", text: "a" }],
          isError: false,
        },
      },
      { type: "compaction", timestamp: at },
    );
    expect(await activities("pi", path)).toEqual([
      { type: "message", from: "user", chars: 3 },
      { type: "message", from: "agent", chars: 6 },
      { type: "tool", tool: "bash", input: "ls", call: "p1" },
      { type: "tool-result", call: "p1" },
      { type: "compaction" },
    ]);
  });
});

describe("reading from an offset", () => {
  const row = (text: string) => ({
    type: "assistant",
    timestamp: at,
    message: { content: [{ type: "text", text }] },
  });

  test("resumes where the last read stopped, never repeating or losing a row", async () => {
    const path = file(row("one"), row("two"));
    const first = await readActivity("claude", path);
    expect(first.rows).toHaveLength(2);
    appendFileSync(path, `${JSON.stringify(row("three"))}\n`);
    const next = await readActivity("claude", path, first.offset);
    expect(next.rows.map((each) => each.activity)).toEqual([
      { type: "message", from: "agent", chars: 5 },
    ]);
    expect(next.rows[0]!.offset).toBe(first.offset);
    expect((await readActivity("claude", path, next.offset)).rows).toEqual([]);
  });

  test("a tail read keeps only the whole lines of its last bytes, at their own offsets", async () => {
    const lines = ["one", "two", "three"].map((text) => `${JSON.stringify(row(text))}\n`);
    const path = file(row("one"), row("two"), row("three"));
    const whole = await readActivity("claude", path);
    // Exactly the last two lines, then one byte more: the line that byte ends is not whole.
    for (const tail of [
      lines[1]!.length + lines[2]!.length,
      lines[1]!.length + lines[2]!.length + 1,
    ]) {
      const read = await readActivity("claude", path, 0, { tail });
      expect(read).toMatchObject({ cut: true, offset: whole.offset });
      expect(read.rows.map((each) => each.offset)).toEqual(
        whole.rows.slice(1).map((each) => each.offset),
      );
    }
    expect(await readActivity("claude", path, 0, { tail: 10_000 })).toEqual(whole);
  });

  test("a read of so many bytes stops at the end of the line that reaches them", async () => {
    const path = file(row("one"), row("two"), row("three"));
    const whole = await readActivity("claude", path);
    const some = await readActivity("claude", path, 0, { bytes: 1 });
    expect(some).toEqual({ rows: [whole.rows[0]!], offset: whole.rows[1]!.offset, more: true });
    expect(await readActivity("claude", path, 0, { bytes: 10_000 })).toEqual(whole);
  });

  test("a read of so many lines stops after them", async () => {
    const path = file(row("one"), row("two"), row("three"));
    const whole = await readActivity("claude", path);
    const one = await readActivity("claude", path, whole.rows[1]!.offset, { lines: 1 });
    expect(one).toEqual({ rows: [whole.rows[1]!], offset: whole.rows[2]!.offset, more: true });
  });

  test("stops before a torn last line, and reads it once it is whole", async () => {
    const path = file(row("one"));
    const whole = JSON.stringify(row("two"));
    appendFileSync(path, whole.slice(0, 20));
    const first = await readActivity("claude", path);
    expect(first.rows).toHaveLength(1);
    appendFileSync(path, `${whole.slice(20)}\n`);
    const next = await readActivity("claude", path, first.offset);
    expect(next.rows.map((each) => each.activity)).toEqual([
      { type: "message", from: "agent", chars: 3 },
    ]);
  });

  test("a row's items share its offset, told apart by their index; text only when asked", async () => {
    const path = file({
      type: "assistant",
      timestamp: at,
      message: {
        content: [
          { type: "text", text: "Running it with API_TOKEN=abc123." },
          { type: "tool_use", id: "t", name: "Bash", input: { command: "ls" } },
        ],
      },
    });
    const plain = await readActivity("claude", path);
    expect(plain.rows.map(({ offset, index }) => [offset, index])).toEqual([
      [0, 0],
      [0, 1],
    ]);
    expect(plain.rows[0]).not.toHaveProperty("text");
    const full = await readActivity("claude", path, 0, { full: true });
    expect(full.rows[0]!.text).toBe("Running it with API_TOKEN=***");
  });

  test("a line across the reader's chunks is read whole, at its own offset", async () => {
    const long = "x".repeat(5 * 1024 * 1024);
    const path = file(row("one"), row(long), row("three"));
    const read = await readActivity("claude", path);
    expect(read.rows.map((each) => each.activity)).toEqual([
      { type: "message", from: "agent", chars: 3 },
      { type: "message", from: "agent", chars: long.length },
      { type: "message", from: "agent", chars: 5 },
    ]);
    const second = JSON.stringify(row("one")).length + 1;
    expect(read.rows[1]!.offset).toBe(second);
  });

  test("a file shorter than the offset was replaced, and is read again from its start", async () => {
    const path = file(row("one"), row("two"));
    const first = await readActivity("claude", path);
    writeFileSync(path, `${JSON.stringify(row("new"))}\n`);
    const again = await readActivity("claude", path, first.offset);
    expect(again.rows.map((each) => each.offset)).toEqual([0]);
  });

  test("a harness with no reader, or a file not there, gives nothing", async () => {
    expect(await readActivity("cursor", file(row("one")))).toEqual({ rows: [], offset: 0 });
    expect(await readActivity("claude", join(dir, "missing.jsonl"), 7)).toEqual({
      rows: [],
      offset: 7,
    });
  });
});

describe("masking", () => {
  test("common credential shapes", () => {
    for (const [given, shown] of [
      ["curl -H 'Authorization: Bearer abc.def.ghi'", "curl -H 'Authorization: ***'"],
      ["OPENAI_API_KEY=sk-live-1234567890abcdef bun run", "OPENAI_API_KEY=*** bun run"],
      ["export GITHUB_TOKEN='ghp_x'", "export GITHUB_TOKEN=***"],
      ['{"api_key": "abc"}', '{"api_key": "***"}'],
      ["use sk-ant-abcdefghijklmnopqrstu now", "use *** now"],
      ["ghp_abcdefghijklmnopqrstuvwxyz0123", "***"],
      ["AKIAABCDEFGHIJKLMNOP", "***"],
      [
        "curl -H 'x-api-key: abc123' https://u:p4ss@host/x",
        "curl -H 'x-api-key: ***' https://***@host/x",
      ],
      ["curl -u me:secret https://host", "curl -u *** https://host"],
      ["eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4", "***"],
      ["bun test packages/engine", "bun test packages/engine"],
      ["max_tokens=4096", "max_tokens=4096"],
      ["curl --user admin:pw url", "curl --user *** url"],
      [
        "git config set --global user.password hunter2",
        "git config set --global user.password ***",
      ],
      ["git config set --global user.name me", "git config set --global user.name me"],
      ["curl --proxy-user u:p url", "curl --proxy-user *** url"],
      ["gpg --passphrase hunter2 x", "gpg --passphrase *** x"],
      ["export DB_PASS=hunter2", "export DB_PASS=***"],
      ["curl -H 'X-Auth: abc'", "curl -H 'X-Auth: ***'"],
      ["mysqladmin -u root -pSecret1 status", "mysqladmin -u root -p*** status"],
      ["aws s3 --secret-key abc", "aws s3 --secret-key ***"],
      ["redis-cli -a hunter2", "redis-cli -a ***"],
      ["BYPASS_CACHE=1 curl -H 'X-Request-Id: 12'", "BYPASS_CACHE=1 curl -H 'X-Request-Id: 12'"],
      ["sshpass -p hunter2 ssh x", "sshpass -p *** ssh x"],
      ["mysql -u root -p Secret1", "mysql -u root -p ***"],
      ["openssl enc -k hunter2", "openssl enc -k ***"],
      [
        "aws configure set aws_secret_access_key abcd1234",
        "aws configure set aws_secret_access_key ***",
      ],
      [
        "npm config set //registry.npmjs.org/:_authToken abc123",
        "npm config set //registry.npmjs.org/:_authToken ***",
      ],
      ['curl -H "api_key: abc123"', 'curl -H "api_key: ***"'],
      ["export FOO_PWD=abc", "export FOO_PWD=***"],
      ["curl https://x.io/y?access_token=abc123def", "curl https://x.io/y?access_token=***"],
      ["PWD=/x git config set user.name me", "PWD=/x git config set user.name me"],
      ["mysql --password=hunter2", "mysql --password=***"],
      ["mysql -u root -phunter2 db", "mysql -u root -p*** db"],
      ["gh auth login --token ghx123456", "gh auth login --token ***"],
      ["curl -H 'X-Auth-Token: abcdef123'", "curl -H 'X-Auth-Token: ***'"],
      ["curl -H 'Cookie: sid=abc; theme=dark'", "curl -H 'Cookie: ***'"],
      ["password=hunter2 ./run", "password=*** ./run"],
      ["export aws_secret_access_key = abcd1234efgh", "export aws_secret_access_key = ***"],
      ["docker login -p s3cr3t registry", "docker login -p *** registry"],
      [
        "echo //registry.npmjs.org/:_authToken=npm_abcdef",
        "echo //registry.npmjs.org/:_authToken=***",
      ],
      ["mkdir -p dir && git log -p", "mkdir -p dir && git log -p"],
    ] as const) {
      expect(maskCredentials(given)).toBe(shown);
    }
  });

  test("a cut is one line, masked first, about 120 characters with an ellipsis", () => {
    expect(cut("a\n  b")).toBe("a b");
    const long = cut(`TOKEN=${"x".repeat(200)} ${"y".repeat(200)}`);
    expect(long.startsWith("TOKEN=*** ")).toBe(true);
    expect(long).toHaveLength(120);
    expect(long.endsWith("…")).toBe(true);
  });
});
