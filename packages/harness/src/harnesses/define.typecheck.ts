import { cursor } from "./cursor";
import { type Absences, defineHarness, type HarnessDefinition } from "./define";

const bare = {
  callingSessionEnv: [],
  meteredCredentials: [],
  herdrSessionIsOwn: false,
  pastesQuoted: false,
  meteredHeadless: false,
  interactive: () => ({ argv: ["bare"] }),
  headlessTurn: (prompt) => ({ argv: ["bare"], stdin: prompt }),
} satisfies HarnessDefinition;

const reasons = {
  ...cursor.absent,
  resumeTurn: "none",
  readSessionId: "none",
} as Required<Absences>;
const { forkSession: _fork, readTranscript: _transcript, ...lacking } = reasons;
const forkless = { ...bare, readTranscript: (stdout: string) => stdout };

defineHarness(bare, { ...lacking, forkSession: "none", readTranscript: "none" });

// @ts-expect-error A capability neither given nor said to be absent.
defineHarness(bare, lacking);

// @ts-expect-error A capability given and also said to be absent.
defineHarness(forkless, { ...lacking, forkSession: "none", readTranscript: "none" });

// @ts-expect-error An absence that names no capability.
defineHarness(bare, { ...lacking, forkSession: "none", readTranscript: "none", interactive: "" });
