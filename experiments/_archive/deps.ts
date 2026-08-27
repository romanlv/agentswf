/**
 * Everything the archived experiments pull from the packages, in one place.
 *
 * The experiments are frozen: they are evidence, and rewriting their imports every time a
 * package moves would be editing evidence. This file absorbs that instead, and it is also the
 * boundary — it imports public package entrypoints only, so nothing here reaches into a
 * package's internals.
 */
export * from "@wf/contract";
export * from "@wf/harness";
export * from "@wf/harness/testing";
export * from "@wf/engine";
export { tempRunDir } from "@wf/engine/testing";
export { COUNT_SCHEMA } from "@wf/contract/testing";
export * from "./run-log";

/** The three ways E2 had a terminal agent hand a value back. Production settles through one. */
export type ReturnMethod = "cli-callback" | "write-a-file" | "delimited-line";
