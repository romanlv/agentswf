import { runProbe } from "./sandbox-probe";

/**
 * The sandbox probe under docker: three agents in boxes, one shared and one private, against
 * canaries this host planted. Builds the default image first when it is missing, and fails,
 * saying why, where docker cannot run.
 */
if (import.meta.main) await runProbe("docker");
