import {
  type ChoiceQuestion,
  choice,
  type DecisionSpec,
  type Question,
  score,
  type WorkflowContext,
  yesNo,
} from "./index";

declare const context: WorkflowContext;
declare const issues: { id: string; mechanism: string }[];

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function expectType<T extends true>(_proof?: T): void {}

async function inline(): Promise<void> {
  const { answers, record } = await context.decisions.decide({
    key: "triage:1",
    model: "jev",
    state: { ticket: "Checkout double-charges on retry" },
    questions: {
      team: choice("Which team owns `ticket`?", { payments: "Checkout, billing", frontend: null }),
      bug: yesNo("Does `ticket` report broken behaviour?"),
      urgency: score("How urgent is `ticket`?", ["later", "this week", "now"]),
    },
  });
  expectType<Equal<typeof answers.team.choice, "payments" | "frontend">>();
  expectType<Equal<typeof answers.urgency.level, 0 | 1 | 2>>();
  expectType<Equal<typeof answers.urgency.probabilities, readonly number[]>>();
  expectType<Equal<typeof answers.bug.yes, number>>();
  const payments: number = answers.team.probabilities.payments;
  const expected: number = answers.urgency.expected;
  const snapshot: string | undefined = record.snapshot;
  // @ts-expect-error Not an option.
  void answers.team.probabilities.account;
  // @ts-expect-error Not a question.
  void answers.severity;
  // @ts-expect-error A yes-no has no pick of its own.
  void answers.bug.choice;
  void [payments, expected, snapshot];
}

/** A decision reused across workflows: a function that returns the call. */
function matchIssue(text: string) {
  const options = Object.fromEntries(issues.map((issue) => [issue.id, issue.mechanism]));
  return {
    key: "match:fixture",
    model: "jev",
    state: { finding: text },
    questions: { issue: choice("Which known problem does `finding` raise?", options) },
  };
}

const SEVERITY = score("How severe is `issue`?", ["nit", "could-fix", "should-fix", "must-fix"]);

async function reused(): Promise<void> {
  const { answers } = await context.decisions.decide(matchIssue("a finding"));
  // Options only known at run time widen to `string`.
  expectType<Equal<typeof answers.issue.choice, string>>();
  const graded = await context.decisions.decide({
    key: "grade:1",
    model: "jev",
    state: "an issue",
    questions: { severity: SEVERITY },
  });
  expectType<Equal<typeof graded.answers.severity.level, 0 | 1 | 2 | 3>>();
  const dynamic = await context.decisions.decide({
    key: "grade:2",
    model: "jev",
    state: "an issue",
    questions: {
      severity: score(
        "How severe?",
        issues.map((issue) => issue.id),
      ),
    },
  });
  expectType<Equal<typeof dynamic.answers.severity.level, number>>();
}

function rejectedShapes(): void {
  // @ts-expect-error A question's type is one of three.
  const unknownType: Question = { type: "rank", instructions: "Rank it" };
  // @ts-expect-error Questions are required.
  const noQuestions: DecisionSpec = { key: "k", model: "jev", state: "s" };
  // A question written as a bare literal outside the call needs `satisfies`, or its type widens.
  const bare = {
    type: "choice",
    instructions: "Which?",
    options: { a: null },
  } satisfies ChoiceQuestion;
  void [unknownType, noQuestions, bare];
}

void [inline, reused, rejectedShapes];
