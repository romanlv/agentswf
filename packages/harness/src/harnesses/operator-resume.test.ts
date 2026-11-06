import { expect, test } from "bun:test";
import { sandboxedArgs, sandboxedOperatorArgs } from "../sandbox-needs";
import { HARNESSES } from "../spec";

/** What lets an agent's turns run its commands unasked: never on a person's resume. */
const UNATTENDED = [
  "--allowed-tools",
  "--dangerously-skip-permissions",
  "never",
  "--force",
  "--yolo",
];

test("each harness resumes a session for a person on its model and effort, asking as it would", () => {
  const settings = { model: "m-1", effort: "high" } as const;
  const expected = {
    claude: ["claude", "--resume", "s-1", "--model", "m-1", "--effort", "high"],
    codex: ["codex", "resume", "s-1", "-c", 'model_reasoning_effort="high"', "--model", "m-1"],
    cursor: ["cursor-agent", "--resume", "s-1", "--trust", "--model", "m-1"],
    pi: ["pi", "--session-id", "s-1", "--model", "m-1", "--thinking", "high"],
  };
  for (const [harness, argv] of Object.entries(expected)) {
    const spec = HARNESSES[harness as keyof typeof HARNESSES];
    const plan = spec.operatorResume!("s-1", settings, ["--last"]);
    expect(plan.argv.slice(0, argv.length)).toEqual(argv);
    expect(plan.argv.at(-1)).toBe("--last");
    expect(plan.stdin).toBeUndefined();
    for (const flag of UNATTENDED) expect(plan.argv).not.toContain(flag);
  }
});

test("codex in awf's sandbox runs with its own off, as an agent's turns do, and asks on request", () => {
  const args = sandboxedOperatorArgs("codex", false);
  expect(args.slice(0, 4)).toEqual([
    "-c",
    'sandbox_mode="danger-full-access"',
    "--ask-for-approval",
    "on-request",
  ]);
  expect(args.slice(4)).toEqual([...sandboxedArgs("codex", false)]);
  expect(sandboxedOperatorArgs("pi", false)).toEqual(sandboxedArgs("pi", false));
});

test("a sandboxed agent's resume takes its sandboxed arguments, last", () => {
  for (const harness of ["codex", "cursor", "pi"] as const) {
    const args = sandboxedArgs(harness, false);
    const plan = HARNESSES[harness].operatorResume!("s-1", {}, args);
    expect(plan.argv.slice(-args.length)).toEqual([...args]);
    for (const flag of UNATTENDED) expect(plan.argv).not.toContain(flag);
  }
});
