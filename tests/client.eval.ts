// Story 040's live check: a program drives a workflow's runs through agentswf/client, in a project
// that pins its own agentswf, a copy of this one at another version than the global awf.
//
// The program, `drive.ts` in the project, imports the project's agentswf/client and:
// - emits to an event workflow, starting its run, waits for it to park, and emits again, waking it;
// - starts a plain workflow with args and waits until it is final;
// - starts a plain workflow whose agent asks a person, finds the question in inbox(), and answers it
//   with `awf reply` typed to the global awf, which hands the command over to the project's.
// Every agent is codex on gpt-6-luna, headless. About 4 turns.

import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertLiveOptIn } from "./live";

const ROOT = join(import.meta.dir, "..");
const PACKAGES = join(ROOT, "packages");
const GLOBAL_AWF = join(PACKAGES, "agentswf/src/awf.ts");
const VERSION = "0.0.0-live";
const CODEWORD = "OSPREY-5120";

const RUNTIME = `{ harness: "codex", model: "gpt-6-luna", placement: "headless" }`;

const EVENTS = `import { defineWorkflow, type OutputSchema } from "agentswf/workflow";
const Task = { type: "object", properties: { word: { type: "string" } }, required: ["word"], additionalProperties: false } as OutputSchema<{ word: string }>;
const Upper = { type: "object", properties: { upper: { type: "string" } }, required: ["upper"], additionalProperties: false } as OutputSchema<{ upper: string }>;
export default defineWorkflow({
  meta: { name: "shout", description: "Uppercases each word it is sent, twice." },
  file: import.meta.path,
  events: { task: Task },
  starts: ["task"],
  async run(wf) {
    const agent = await wf.agents.open({ key: "shouter", runtime: ${RUNTIME} });
    // Each attempt runs from the top, taking the events not yet taken: the word that ends the run
    // decides, not a count kept in memory.
    for await (const next of wf.select({ task: wf.signal("task") }, { label: "waiting for a word" })) {
      if (!next.task) continue;
      const { outcome } = await agent.run({ prompt: \`Return the word \${next.task.data.word} in uppercase letters.\`, schema: Upper });
      if (next.task.data.word === "heron")
        return [outcome.answered ? outcome.value.upper : outcome.kind, next.task.source ?? "no source"];
    }
    return [];
  },
});
`;

const PLAIN = `import { defineWorkflow, type OutputSchema } from "agentswf/workflow";
const Sum = { type: "object", properties: { sum: { type: "number" } }, required: ["sum"], additionalProperties: false } as OutputSchema<{ sum: number }>;
export default defineWorkflow<{ a: number; b: number }, number>({
  meta: { name: "add", description: "Adds two numbers by asking an agent." },
  file: import.meta.path,
  prepare: () => { throw new Error("a run started from code is never prepared"); },
  async run(wf, { a, b }) {
    const agent = await wf.agents.open({ key: "adder", runtime: ${RUNTIME} });
    const { outcome } = await agent.run({ prompt: \`What is \${a} plus \${b}? Answer with the sum.\`, schema: Sum });
    return outcome.answered ? outcome.value.sum : wf.stop(outcome.kind);
  },
});
`;

const ASK = `import { defineWorkflow, type OutputSchema } from "agentswf/workflow";
const Answer = { type: "object", properties: { codeword: { type: "string" } }, required: ["codeword"], additionalProperties: false } as OutputSchema<{ codeword: string }>;
export default defineWorkflow({
  meta: { name: "ask", description: "Asks a person for a codeword." },
  file: import.meta.path,
  async run(wf) {
    const person = await wf.participants.connect({ key: "person" });
    const agent = await wf.agents.open({ key: "asker", runtime: ${RUNTIME} });
    await wf.messages.allow({ between: [agent, person], purpose: "Ask the person what only they know.", timeout: "10m" });
    const { outcome } = await agent.run({
      prompt: "A person outside this run keeps a codeword you need. Ask them for it, waiting for their reply, and return the codeword they give you. Do not guess it.",
      schema: Answer,
      timeout: "10m",
    });
    return outcome.answered ? outcome.value.codeword : wf.stop(outcome.kind);
  },
});
`;

const DRIVE = `import { client } from "agentswf/client";
import shout from "./shout.ts";
import add from "./add.ts";
import ask from "./ask.ts";

const runs = client();
const say = (step: string, value: unknown) => console.log(JSON.stringify({ step, value }));
const signal = () => AbortSignal.timeout(8 * 60_000);

// An event starts the run; it parks; a second event wakes it, and it returns.
say("emit-1", await runs.emit(shout, "s1", "task", { word: "osprey" }, { eventId: "t-1", source: "live-eval" }));
const run = await runs.get(shout, "s1");
say("parked", await run.wait({ signal: signal() }));
say("emit-2", await runs.emit(shout, "s1", "task", { word: "heron" }, { eventId: "t-2", source: "live-eval" }));
say("shout-final", await run.wait({ final: true, signal: signal() }));

// A plain run with args, never prepared.
const added = await runs.start(add, { a: 19, b: 23 }, { id: "sum" });
say("start", { did: added.did });
say("add-final", await added.run.wait({ final: true, signal: signal() }));

// A detached plain run whose agent asks a person: the question in inbox(), the answer by awf reply.
const asked = await runs.start(ask, null, { id: "q1" });
say("ask-start", { did: asked.did });
const deadline = Date.now() + 5 * 60_000;
let question: { id: string; from: string } | undefined;
while (!question && Date.now() < deadline) {
  for (const item of await runs.inbox(ask))
    if (item.kind === "message" && item.asks) question = { id: item.id, from: item.from };
  if (!question) await Bun.sleep(2_000);
}
say("question", question);
if (question) {
  const reply = Bun.spawnSync([process.execPath, "--no-env-file", process.env.GLOBAL_AWF!, "reply", "ask/q1", question.from, "--to", question.id, "${CODEWORD}"], { cwd: import.meta.dir, env: process.env });
  say("reply", { exit: reply.exitCode, stderr: reply.stderr.toString() });
}
say("ask-final", await asked.run.wait({ final: true, signal: signal() }));
`;

function copyPackage(name: string, to: string): void {
  cpSync(join(PACKAGES, name), to, {
    recursive: true,
    filter: (path) => !path.includes("node_modules") && !path.endsWith(".test.ts"),
  });
  const manifest = join(to, "package.json");
  const read = JSON.parse(readFileSync(manifest, "utf8")) as { version: string };
  writeFileSync(manifest, JSON.stringify({ ...read, version: VERSION }, null, 2));
}

function problems(lines: { step: string; value: unknown }[]): string[] {
  const by = new Map(lines.map((line) => [line.step, line.value as Record<string, unknown>]));
  const found: string[] = [];
  const expect = (
    step: string,
    check: (value: Record<string, unknown>) => boolean,
    what: string,
  ) => {
    const value = by.get(step);
    if (!value || !check(value)) found.push(`${step}: ${what}; got ${JSON.stringify(value)}`);
  };
  expect("emit-1", (v) => v.outcome === "accepted" && v.did === "started", "accepted, started");
  expect("parked", (v) => v.state === "parked" && v.final === false, "parked, not final");
  expect("emit-2", (v) => v.outcome === "accepted" && v.did === "continued", "accepted, continued");
  expect(
    "shout-final",
    (v) =>
      v.state === "completed" &&
      JSON.stringify((v.ending as { value?: unknown })?.value) ===
        JSON.stringify(["HERON", "live-eval"]),
    "completed with the second word shouted and its source",
  );
  expect("start", (v) => v.did === "started", "started");
  expect(
    "add-final",
    (v) => v.state === "completed" && (v.ending as { value?: unknown })?.value === 42,
    "completed with 42",
  );
  expect("ask-start", (v) => v.did === "started", "started");
  expect("question", (v) => typeof v?.id === "string", "a question in inbox()");
  expect(
    "reply",
    (v) => v.exit === 0 && String(v.stderr).includes("running the project's"),
    "handed over and delivered",
  );
  expect(
    "ask-final",
    (v) => v.state === "completed" && (v.ending as { value?: unknown })?.value === CODEWORD,
    `completed with ${CODEWORD}`,
  );
  return found;
}

if (import.meta.main) {
  assertLiveOptIn();
  const project = realpathSync(mkdtempSync(join(tmpdir(), "awf-client-live-")));
  const modules = join(project, "node_modules");
  copyPackage("agentswf", join(modules, "agentswf"));
  for (const name of ["engine", "contract", "harness", "sandbox"])
    copyPackage(name, join(modules, "@agentswf", name));
  symlinkSync(
    realpathSync(join(PACKAGES, "engine/node_modules/typebox")),
    join(modules, "typebox"),
  );
  mkdirSync(join(project, ".awf"));
  writeFileSync(
    join(project, "package.json"),
    JSON.stringify({ devDependencies: { agentswf: VERSION } }),
  );
  writeFileSync(join(project, "shout.ts"), EVENTS);
  writeFileSync(join(project, "add.ts"), PLAIN);
  writeFileSync(join(project, "ask.ts"), ASK);
  writeFileSync(join(project, "drive.ts"), DRIVE);
  console.log(`project: ${project}`);
  const child = Bun.spawn({
    cmd: [process.execPath, "--no-env-file", "drive.ts"],
    cwd: project,
    env: { ...process.env, GLOBAL_AWF },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const stdout = await new Response(child.stdout).text();
  const code = await child.exited;
  const lines = stdout
    .trim()
    .split("\n")
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as { step: string; value: unknown }];
      } catch {
        console.log(line);
        return [];
      }
    });
  for (const line of lines) console.log(`${line.step}: ${JSON.stringify(line.value)}`);
  // What the runs cost, as awf runs reports it, through the global awf's hand-over.
  for (const ref of ["shout/s1", "add/sum", "ask/q1"]) {
    const shown = Bun.spawnSync([process.execPath, "--no-env-file", GLOBAL_AWF, "runs", ref], {
      cwd: project,
    });
    console.log(shown.stdout.toString().trim());
  }
  const found = code === 0 ? problems(lines) : [`drive.ts exited ${code}`, ...problems(lines)];
  if (found.length > 0) {
    console.error(`client eval failed:\n${found.map((each) => `- ${each}`).join("\n")}`);
    process.exit(1);
  }
  console.log("client eval passed");
}
