import { runProbe } from "./sandbox-probe";

/**
 * The sandbox probe under srt: three agents, one shared sandbox and one private, against canaries
 * this host planted. Fails, saying why, where srt is not installed. About 2½ minutes; claude runs
 * headless.
 */
if (import.meta.main) await runProbe("srt");
