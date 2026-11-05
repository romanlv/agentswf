import type { TickResultJson } from "@agentswf/contract/records";
import { messageOf } from "./errors";
import { exists } from "./files";
import help from "./help/tick.txt" with { type: "text" };
import { listProjects, projectRunRoot } from "./projects";
import type { Out } from "./run-commands";
import { parsePlace } from "./run-commands";
import { runLockFile, withRunLock } from "./run-lock";
import { listRunEntries } from "./run-state";
import { RunUnreadable } from "./runs";
import { type Launch, wake } from "./wake";

export const tickUsage = help.trimEnd();

export async function tickCommand(
  argv: readonly string[],
  shellCwd: string,
  out: Out,
  context: {
    home: string;
    environment: Readonly<Record<string, string | undefined>>;
    launch?: Launch;
    now?: () => number;
  },
): Promise<number> {
  if (argv.includes("-h") || argv.includes("--help")) {
    out.stdout(tickUsage);
    return 0;
  }
  let parsed: ReturnType<typeof parsePlace>;
  try {
    parsed = parsePlace(argv, shellCwd);
    const unknown = parsed.rest.find((word) => word !== "--all");
    if (unknown !== undefined) throw new Error(`tick takes no ${unknown}`);
    if (parsed.rest.includes("--all") && parsed.place.repeat.length > 0)
      throw new Error("--all wakes every project's runs; it takes no --cwd or --run-root");
  } catch (error) {
    out.stderr(`awf: ${messageOf(error)}\n\n${tickUsage}`);
    return 2;
  }
  const { place, json } = parsed;
  const woke: TickResultJson["woke"] = [];
  const unreadable: string[] = [];
  let failed = false;
  const roots: string[] = [];
  if (!parsed.rest.includes("--all")) roots.push(place.runRoot);
  else
    for (const project of await listProjects(context.home)) {
      if (await exists(project)) roots.push(projectRunRoot(project));
      else {
        failed = true;
        out.stderr(`awf: ${project}, in ~/.awf/projects, is gone; its runs are not woken`);
      }
    }
  for (const root of roots) {
    for (const run of await listRunEntries(root)) {
      if (run instanceof RunUnreadable) {
        // One with events is one a tick would have woken: it is named, not an error.
        if (run.events) unreadable.push(run.ref);
        continue;
      }
      if (!run.record.events) continue;
      const ref = `${run.record.workflow}/${run.record.id}`;
      try {
        const { workflow, id } = run.record;
        const why = await withRunLock(runLockFile(root, workflow, id), async () => {
          const woken = await wake(run, { ...context, nudgeLive: false });
          if (woken.why === "launch-failed") throw new Error(woken.error ?? "launch failed");
          if ((woken.did !== "started" && woken.did !== "continued") || !woken.cause)
            return undefined;
          return { did: woken.did, why: woken.cause };
        });
        if (why) woke.push({ ref, ...why });
      } catch (error) {
        failed = true;
        out.stderr(`awf: ${ref}: ${messageOf(error)}`);
      }
    }
  }
  if (unreadable.length > 0 && !json) {
    const runs = unreadable.length === 1 ? "1 run" : `${unreadable.length} runs`;
    out.stderr(
      `awf: ${runs} with events can't be read and ${unreadable.length === 1 ? "is" : "are"} not woken; awf runs says why`,
    );
  }
  if (json) {
    const result: TickResultJson = { v: 1, woke, ...(unreadable.length ? { unreadable } : {}) };
    out.stdout(JSON.stringify(result));
  } else for (const each of woke) out.stdout(`${each.did} ${each.ref}: ${each.why}`);
  return failed ? 1 : 0;
}
