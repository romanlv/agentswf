/**
 * How a deprecated name the contract defines reaches the run that used it, the contract doing no
 * I/O: the engine puts a function under this key on what it hands a run, and the name calls it.
 * Registered, so a second copy of this module, a workflow's own install, finds the engine's.
 */
export const REPORT_DEPRECATED = Symbol.for("agentswf.report-deprecated");

/** On a workflow `defineExecutableWorkflow` made, which the engine reports when it runs one. */
export const DEPRECATED_DEFINITION = Symbol.for("agentswf.deprecated-definition");

/** Tells the run that handed out `given` that `name` was used; nothing outside a run. */
export function reportDeprecated(given: unknown, name: string): void {
  if (typeof given !== "object" || given === null) return;
  const report = (given as { [REPORT_DEPRECATED]?: unknown })[REPORT_DEPRECATED];
  if (typeof report === "function") report(name);
}
