import { runProbe } from "./sandbox-probe";

/**
 * The sandbox probe with its codex, claude and pi in terminal panes of the box's own Herdr (story
 * 004, Task 5): typed in behind a prelude that sets the pane's environment and loads its secret,
 * adopted by name, and answering through `wf result`. Fails, saying why, where docker cannot run.
 * About 3 minutes; claude in a pane is billed to its subscription.
 */
if (import.meta.main) await runProbe("docker", ["coder", "tester", "reviewer"]);
