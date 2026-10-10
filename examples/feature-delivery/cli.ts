import type { AdditionalReviewer, FeatureArgs } from "./schema";

const USAGE = "feature-delivery: -- {ticket} [--revisions {n}] [--reviewer {name}={runtime}]…";

/** A claude planner, codex for the rest, and an additional reviewer per `--reviewer`. */
export function parseArgs(argv: readonly string[]): FeatureArgs {
  const args: FeatureArgs = {
    ticket: "",
    runtimes: { planner: "claude", implementer: "codex", reviewer: "codex" },
  };
  const additionalReviewers: AdditionalReviewer[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--revisions") {
      const revisions = argv[++i] ?? "";
      if (!/^\d+$/.test(revisions)) throw new Error(USAGE);
      args.maxRevisions = Number(revisions);
    } else if (arg === "--reviewer") {
      const [name, runtime, ...rest] = (argv[++i] ?? "").split("=");
      const taken = additionalReviewers.some((extra) => extra.name === name);
      if (!name || !runtime || rest.length > 0 || taken) throw new Error(USAGE);
      additionalReviewers.push({ name, runtime });
    } else if (arg && !arg.startsWith("-") && !args.ticket) {
      args.ticket = arg;
    } else {
      throw new Error(USAGE);
    }
  }
  if (!args.ticket) throw new Error(USAGE);
  return additionalReviewers.length === 0 ? args : { ...args, additionalReviewers };
}
