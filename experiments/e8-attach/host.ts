import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";

const D = import.meta.dir;
const t0 = Date.now();
const log = (m: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s ${m}`);
const herdr = (...a: string[]) => {
  const p = Bun.spawnSync(["herdr", ...a]);
  return (p.stdout.toString() + p.stderr.toString()).trim();
};
const status = (s: string) => s.match(/"agent_status":"(\w+)"/)?.[1] ?? s.slice(0, 200);
const paneFor = async (code: string) => {
  for (const end = Date.now() + 60_000; Date.now() < end; await Bun.sleep(1000)) {
    const panes = JSON.parse(herdr("pane", "list")).result.panes as {
      pane_id: string;
      agent?: string;
    }[];
    const hits = panes.filter(
      (p) =>
        p.agent &&
        herdr("pane", "read", p.pane_id, "--source", "recent-unwrapped", "--lines", "200").includes(
          code,
        ),
    );
    if (hits.length === 1) return hits[0]?.pane_id;
    if (hits.length > 1) return log(`code on ${hits.length} panes`);
  }
};

async function drive(session: string, tag: string) {
  const log = (m: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s [${tag}] ${m}`);
  const pane = await paneFor(session);
  if (!pane) return log(`no pane shows code ${session}`);
  const run = `${D}/run-${tag}-${Date.now()}`;
  mkdirSync(`${run}/results`, { recursive: true });
  const wf = `${run}/wf`;
  writeFileSync(
    wf,
    `#!/bin/bash\n[ "$1" = result ] || { echo "usage: wf result <id>"; exit 2; }\ncat > "${run}/results/$2.json"; echo "result accepted for $2"\n`,
  );
  chmodSync(wf, 0o755);
  const answer = async (id: string, ms = 180_000) => {
    // Bun.file(...).exists() caches a miss, so poll the filesystem directly.
    const f = `${run}/results/${id}.json`;
    for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(500))
      if (existsSync(f)) return readFileSync(f, "utf8").trim();
    return null;
  };
  const how = (id: string, json: string) =>
    `Answer only by running: ${wf} result ${id} <<< '${json}'`;
  const prompt = (text: string) => status(herdr("agent", "prompt", pane, text));

  log(`session ${session} -> pane ${pane}; waiting for the attaching turn to settle`);
  log(`settled: ${status(herdr("agent", "wait", pane, "--timeout", "120000"))}`);
  for (const [id, text] of <[string, string][]>[
    [
      "s1",
      `[workflow step 1/4] Pick a random integer between 1000 and 9999 and remember it. ${how("s1", '{"n": <number>}')}`,
    ],
    [
      "s2",
      `[workflow step 2/4] Double the number you picked in step 1. ${how("s2", '{"double": <number>}')}`,
    ],
  ]) {
    log(`push ${id}: ${prompt(text)}`);
    log(`${id} -> ${await answer(id)}`);
    log(`settled: ${status(herdr("agent", "wait", pane, "--timeout", "60000"))}`);
  }
  log(
    `push s3: ${prompt(`[workflow step 3/4] Run the shell command \`sleep 25\`, then ${how("s3", '{"slept": true}')}`)}`,
  );
  log(
    `working: ${status(herdr("agent", "wait", pane, "--until", "working", "--timeout", "15000"))}`,
  );
  await Bun.sleep(3000);
  log(
    `push s4 while working: ${prompt(`[workflow step 4/4] What number did you pick in step 1? ${how("s4", '{"n": <number>}')}`)}`,
  );
  log(`s3 -> ${await answer("s3")}`);
  log(`s4 -> ${await answer("s4")}`);
  log(`settled: ${status(herdr("agent", "wait", pane, "--timeout", "60000"))}`);
  log(
    `final: ${prompt("[workflow finished] All 4 steps answered. Control is back with the user; reply only 'ok'.")}`,
  );
  log("DONE");
}

mkdirSync(`${D}/spool`, { recursive: true });
log("host watching spool");
for (;;) {
  for (const f of readdirSync(`${D}/spool`).filter((f) => f.endsWith(".req"))) {
    renameSync(`${D}/spool/${f}`, `${D}/spool/${f}.taken`);
    const code = f.replace(/\.req$/, "");
    drive(code, readFileSync(`${D}/spool/${f}.taken`, "utf8").trim() || code);
  }
  await Bun.sleep(500);
}
