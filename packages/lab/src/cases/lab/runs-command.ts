import { basename } from "node:path";
import type { RunRecord } from "../format/records";
import { type Context, workspaceOf } from "./command-context";
import { readRunRecord, readTrials, runIds, UnreadableRecord } from "./store";
import { plural } from "./text";

/** `runs`: the store's runs, newest first, and any whose records don't read. */
export function runs(context: Context): number {
  const workspace = workspaceOf(context);
  const lines = runIds(workspace.store)
    .reverse()
    .flatMap((n) => {
      let run: RunRecord | undefined;
      let state: string;
      try {
        run = readRunRecord(workspace.store, n);
        if (run) readTrials(workspace.store, n);
        state = run?.broke ? "the lab broke" : run?.finished ? "finished" : "partial";
      } catch (error) {
        if (!(error instanceof UnreadableRecord)) throw error;
        // "{file} is not valid:" then its problems: the file's name and the first problem do.
        const [head = "", first] = (error as Error).message.split("\n");
        const why = `${basename(head.replace(/ is not valid:$/, ""))}${first ? `: ${first.trim()}` : ""}`;
        if (!run) return [`${n}  records don't read: ${why}`];
        state = `records don't read (${why}), left out of history`;
      }
      if (!run) return [];
      const trials = run.asked.reduce((sum, a) => sum + a.trials, 0);
      return [
        `${n}  ${run.dataset}  ${plural(run.asked.length, "case")}, ${plural(trials, "trial")}  ${state}`,
      ];
    });
  context.stdout(lines.length > 0 ? lines.join("\n") : "no runs yet: awf-lab run makes one");
  return 0;
}
