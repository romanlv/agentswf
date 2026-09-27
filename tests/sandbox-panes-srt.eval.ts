import { runProbe } from "./sandbox-probe";

/**
 * The sandbox probe with its codex and claude in terminal panes under srt, in the run's own Herdr
 * (story 004, Task 5): typed into each pane after a prelude that confines its shell, adopted by
 * name, and answering through `wf result`. Also refused the run's Herdr socket, and leaving no
 * secret or process behind. Fails, saying why, where srt is not installed. About 3 minutes; claude
 * in a pane is billed to its subscription.
 */
if (import.meta.main) await runProbe("srt", ["coder", "tester"]);
