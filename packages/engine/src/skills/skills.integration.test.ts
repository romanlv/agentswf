import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue, WorkflowContext } from "@agentswf/contract/workflow";
import { createHeadlessRunHostFactory } from "@agentswf/harness";
import type { AgentRuntimeConfig } from "@agentswf/harness/adapter";
import { createFakeSandboxProvider } from "@agentswf/sandbox/testing";
import { createTempRunDirs, future } from "../testing";
import { runWorkflow, WorkflowRunError } from "../workflow-runner";

// A harness that answers through the launcher its prompt names, and logs what it was started with
// and which skills it could find, to `$LOG_DIR` on the host or to its home in a sandbox.
const FAKE = (name: string, logs: string, output: string) => `#!/bin/sh
prompt=$(cat)
log="${logs}/${name}.log"
{ printf 'argv:'; printf ' %s' "$@"; printf '\\n'; echo "CODEX_HOME=$CODEX_HOME";
  ls "$CODEX_HOME/skills" 2>/dev/null | sed 's/^/skill: /'; echo ---; } >> "$log"
line=$(printf '%s\\n' "$prompt" | grep " result .* <<'WF_JSON'$" | head -1)
launcher=\${line%% result *}
rest=\${line#* result }
printf '"answered"' | "$launcher" result "\${rest%% *}" >/dev/null 2>&1
${output}
`;
const CODEX_OUTPUT = `echo '{"type":"thread.started","thread_id":"thread-1"}'`;
const PI_OUTPUT = `echo '{"type":"session","id":"s"}'`;

const runDirs = createTempRunDirs();
const root = realpathSync(mkdtempSync(join(tmpdir(), "wf-skills-")));
const work = join(root, "work");
const logs = join(root, "logs");
const saved = { PATH: process.env.PATH, CODEX_HOME: process.env.CODEX_HOME };

async function skill(name: string, body = "Say the word."): Promise<string> {
  const directory = join(root, "library", name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: Use when asked.\n---\n${body}\n`,
  );
  return directory;
}

beforeAll(async () => {
  await mkdir(join(root, "bin"), { recursive: true });
  for (const [name, logs, output] of [
    // codex's log goes to the home it was given; a sandbox passes nothing else through.
    ["codex", "$CODEX_HOME", CODEX_OUTPUT],
    ["pi", "$AWF_FAKE_LOG", PI_OUTPUT],
  ] as const) {
    await writeFile(join(root, "bin", name), FAKE(name, logs, output));
    await chmod(join(root, "bin", name), 0o755);
  }
  await mkdir(join(root, "operator-codex", "skills", "operators-own"), { recursive: true });
  await writeFile(join(root, "operator-codex", "auth.json"), '{"tokens":{"access_token":"op"}}');
  await mkdir(work, { recursive: true });
  await mkdir(logs, { recursive: true });
  process.env.PATH = `${join(root, "bin")}:${saved.PATH}`;
  process.env.CODEX_HOME = join(root, "operator-codex");
  process.env.AWF_FAKE_LOG = logs;
});

afterAll(async () => {
  process.env.PATH = saved.PATH;
  if (saved.CODEX_HOME === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = saved.CODEX_HOME;
  delete process.env.AWF_FAKE_LOG;
  runDirs.cleanup();
  await rm(root, { recursive: true, force: true });
});

const codex = { harness: "codex", model: "gpt-test", placement: "headless" } as const;
const pi = { harness: "pi", model: "openai-codex/gpt-test", placement: "headless" } as const;

function run<Result extends JsonValue>(
  body: (context: WorkflowContext) => Promise<Result>,
  runRoot = runDirs.tempRunDir(),
) {
  const fake = createFakeSandboxProvider();
  const runtime: AgentRuntimeConfig = {
    aliases: {},
    host: createHeadlessRunHostFactory({}),
  };
  return runWorkflow({ meta: { name: "skills", description: "test" }, run: body }, null, {
    runRoot,
    runtime,
    deadline: future(),
    cwd: work,
    sandboxes: { providers: { installed: { srt: fake.provider }, default: "srt" } },
    skillCache: join(root, "cache"),
  });
}

async function turns(log: string): Promise<string[]> {
  return (await readFile(log, "utf8")).split("---\n").filter(Boolean);
}

describe("agent skills", () => {
  test("two agents in one sandbox each have their own, copied into their homes", async () => {
    const alpha = await skill("alpha");
    const beta = await skill("beta");
    const result = await run(async (context) => {
      const box = await context.sandboxes.open({ key: "shared" });
      const [one, two] = await Promise.all([
        context.agents.open({
          key: "one",
          runtime: codex,
          sandbox: box,
          skills: [{ path: alpha }],
        }),
        context.agents.open({ key: "two", runtime: codex, sandbox: box, skills: [{ path: beta }] }),
      ]);
      await one.run({ prompt: "go" });
      await two.run({ prompt: "go" });
      return null;
    });
    const homes = result.sandboxes![0]!.agents;
    const seen = new Map<string, string[]>();
    for (const { agent, home } of homes) {
      const [turn] = await turns(join(home, "codex.log"));
      expect(turn).toContain("-c skills.bundled.enabled=false");
      expect(turn).toContain(`CODEX_HOME=${home}`);
      seen.set(
        agent,
        [...turn!.matchAll(/^skill: (.+)$/gm)].map((match) => match[1]!),
      );
    }
    expect(Object.fromEntries(seen)).toEqual({ one: ["alpha"], two: ["beta"] });
    expect(result.skills).toEqual([
      expect.objectContaining({ agent: expect.any(String), skills: [expect.any(Object)] }),
      expect.objectContaining({ agent: expect.any(String), skills: [expect.any(Object)] }),
    ]);
    expect(
      result.skills!.map((given) => [given.agent, (given.skills as { name: string }[])[0]!.name]),
    ).toEqual(
      expect.arrayContaining([
        ["one", "alpha"],
        ["two", "beta"],
      ]),
    );
  });

  test("a host codex gets a home of its own: its credential and its skills, not the operator's", async () => {
    const alpha = await skill("alpha");
    const runRoot = realpathSync(runDirs.tempRunDir());
    const result = await run(async (context) => {
      const agent = await context.agents.open({
        key: "coder",
        runtime: codex,
        skills: [{ path: alpha }],
      });
      await agent.run({ prompt: "go" });
      return null;
    }, runRoot);
    const found = result.skills?.[0]?.home ?? "";
    expect(found.startsWith(join(runRoot, result.runId, "agents"))).toBe(true);
    const log = await turns(join(found, "codex.log"));
    expect(log[0]).toContain("skill: alpha");
    expect(log[0]).not.toContain("operators-own");
    expect(log[0]).toContain("-c skills.bundled.enabled=false");
    expect(await readFile(join(found, "auth.json"), "utf8")).toContain("op");
    expect(log[0]).toContain(`CODEX_HOME=${found}`);
    expect(result.skills).toEqual([
      {
        callPath: [],
        agent: "coder",
        skills: [{ name: "alpha", source: { path: alpha }, digest: expect.any(String) }],
        home: found,
      },
    ]);
  });

  test("a host codex given skills forks into a home of its own, its parent's rollout copied in", async () => {
    // This codex keeps rollouts and forks on its app-server, as the real one does.
    const bin = join(root, "forking-bin");
    await mkdir(bin, { recursive: true });
    await writeFile(
      join(bin, "codex"),
      `#!/bin/sh
day="$CODEX_HOME/sessions/2026/10/03"
mkdir -p "$day"
if [ "$1" = "app-server" ]; then
  while IFS= read -r line; do
    case "$line" in *'"id":2'*)
      [ -f "$day/rollout-2026-10-03T00-00-00-thread-1.jsonl" ] || exit 1
      echo '{"type":"session_meta","payload":{"id":"thread-2","forked_from_id":"thread-1"}}' > "$day/rollout-2026-10-03T00-00-01-thread-2.jsonl"
      echo '{"id":2,"result":{"thread":{"id":"thread-2"}}}' ;;
    esac
  done
  exit 0
fi
thread=thread-1
[ "$2" = "resume" ] && thread=$3
[ "$thread" = thread-1 ] && echo '{"type":"session_meta","payload":{"id":"thread-1"}}' >> "$day/rollout-2026-10-03T00-00-00-thread-1.jsonl"
echo "$*" >> "$CODEX_HOME/argv.log"
prompt=$(cat)
line=$(printf '%s\\n' "$prompt" | grep " result .* <<'WF_JSON'$" | head -1)
launcher=\${line%% result *}
rest=\${line#* result }
printf '"answered"' | "$launcher" result "\${rest%% *}" >/dev/null 2>&1
printf '{"type":"thread.started","thread_id":"%s"}\\n' "$thread"
`,
    );
    await chmod(join(bin, "codex"), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try {
      const alpha = await skill("alpha");
      const result = await run(async (context) => {
        const agent = await context.agents.open({
          key: "coder",
          runtime: codex,
          skills: [{ path: alpha }],
        });
        await agent.run({ prompt: "go" });
        const fork = await agent.fork({ key: "tester" });
        return (await fork.run({ prompt: "go" })).outcome.kind;
      });
      expect(result.value).toBe("answered");
      const [parent, child] = result.skills!.map((record) => record.home!);
      expect(child).not.toBe(parent);
      const rollouts = async (home: string) =>
        (await readdir(join(home, "sessions", "2026", "10", "03"))).sort();
      expect(await rollouts(parent!)).toEqual(["rollout-2026-10-03T00-00-00-thread-1.jsonl"]);
      expect(await rollouts(child!)).toEqual([
        "rollout-2026-10-03T00-00-00-thread-1.jsonl",
        "rollout-2026-10-03T00-00-01-thread-2.jsonl",
      ]);
      expect(await readdir(join(child!, "skills"))).toContain("alpha");
      expect(await readFile(join(child!, "argv.log"), "utf8")).toContain("exec resume thread-2");
    } finally {
      process.env.PATH = path;
    }
  });

  test("a host pi loads exactly its skills, and one left out records the operator's", async () => {
    const alpha = await skill("alpha");
    await rm(join(logs, "pi.log"), { force: true });
    const result = await run(async (context) => {
      const given = await context.agents.open({
        key: "given",
        runtime: pi,
        skills: [{ path: alpha }],
      });
      const left = await context.agents.open({ key: "left", runtime: pi });
      await given.run({ prompt: "go" });
      await left.run({ prompt: "go" });
      return null;
    });
    const [first, second] = await turns(join(logs, "pi.log"));
    const skillPath = /--skill (\S+)/.exec(first!)?.[1];
    expect(first).toContain("--no-skills --skill ");
    expect(await readFile(join(skillPath!, "SKILL.md"), "utf8")).toContain("name: alpha");
    expect(second).not.toContain("--no-skills");
    expect(result.skills?.find((given) => given.agent === "left")?.skills).toBe("operator");
  });

  test("none named: a sandboxed agent records none, and a host pi given [] loads none", async () => {
    await rm(join(logs, "pi.log"), { force: true });
    const result = await run(async (context) => {
      const boxed = await context.agents.open({ key: "boxed", runtime: codex, sandbox: {} });
      const empty = await context.agents.open({ key: "empty", runtime: pi, skills: [] });
      await boxed.run({ prompt: "go" });
      await empty.run({ prompt: "go" });
      return null;
    });
    expect(result.skills?.find((given) => given.agent === "boxed")?.skills).toEqual([]);
    expect(result.skills?.find((given) => given.agent === "empty")?.skills).toEqual([]);
    const [turn] = await turns(join(logs, "pi.log"));
    expect(turn).toContain("--no-skills");
    expect(turn).not.toContain("--skill ");
  });

  test("a source that will not resolve, and a harness with no route, refuse the agent", async () => {
    for (const [runtime, skills, message] of [
      [codex, [{ path: join(root, "nowhere") }], "does not exist"],
      [codex, ["alpha"], "name a source"],
      [
        { harness: "cursor", model: "m", placement: "headless", metered: true },
        [{ path: await skill("alpha") }],
        "no way to be given skills",
      ],
    ] as const) {
      const failed = await run(async (context) => {
        // biome-ignore lint/suspicious/noExplicitAny: an untyped workflow is what is being refused.
        await context.agents.open({ key: "a", runtime, skills: skills as any });
        return null;
      }).catch((error: unknown) => error);
      expect(failed).toBeInstanceOf(WorkflowRunError);
      expect((failed as Error).message).toContain(message);
      // Refused before it was given anything: nothing says it had skills.
      expect((failed as WorkflowRunError).skills).toBeUndefined();
    }
  });

  test("reopening an agent with other skills is a conflict", async () => {
    const alpha = await skill("alpha");
    const beta = await skill("beta");
    const failed = await run(async (context) => {
      await context.agents.open({ key: "a", runtime: pi, skills: [{ path: alpha }] });
      await context.agents.open({ key: "a", runtime: pi, skills: [{ path: beta }] });
      return null;
    }).catch((error: unknown) => error);
    expect((failed as Error).message).toContain("different skills");
  });
});
