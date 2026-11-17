# refund-desk: a workflow checked on cases

An agent reads a customer's refund request and decides it by the shop's policy: refund, decline or
ask. Code then acts on that decision. It pays the refund, capped at the order's total, and posts
the agent's reply.

Reading the prompt can't tell you whether this works. A policy sentence that's clear to you can be
ambiguous to the model, and a single run that looks right tells you nothing about the next ten.

A unit test with a scripted agent (`agentswf/testing`) checks the code around the agent for free,
but the agent's answer in it is one you wrote. Cases check the answers a real model gives, and how
often it gives them. The cases in `evals/` are tickets with known right answers. `awf-lab` runs the
workflow on each one, several times if you ask, with a real agent. No money moves and no reply is
sent. When you change the prompt, the model or the code, the result is a pass rate you can compare
across runs.

## Run it

From this folder, with a Claude login in `CLAUDE_CODE_OAUTH_TOKEN` and
[srt](../../site/guide/sandboxes.md) installed:

```sh
bun awf-lab run --dataset refunds              # the whole workflow, 3 tickets
bun awf-lab run --dataset decide --trials 5    # the decision alone, each ticket 5 times
bun awf-lab report                             # the last run again
```

A **trial** is one run of the workflow on one case. Here each trial makes a single Claude Haiku
turn: about 5 seconds, estimated at $0.002. A case is **passed** when every trial passed,
**failed** when every trial failed, and **flaky** when the trials disagree. This is the report
when a case is flaky:

```text
flaky
  day-30               1/2   expect: action is "decline", the key wants "refund"

passed 2 · failed 0 · flaky 1 · unclear 0 · known failing 0
trials 6 · errored 0 · undecided 0 · leaked 0
time per trial, median 5.3s · est. cost per trial, median $0.0020 · all trials $0.01

exit 3: a case is flaky or unclear
```

## Two ways to run a case

The workflow has three stages: `read` fetches the ticket and the order, `decide` asks the agent,
and `act` refunds and replies. Each dataset in `evals/` runs the workflow its own way.

| Dataset | What runs | What's real | What the case sets up |
| --- | --- | --- | --- |
| `refunds/` | read, decide, act | the agent and the workflow's code | the helpdesk API and the shop |
| `decide/` | decide only | the agent | the value of read; the run stops after decide |

**`refunds/`** checks the code around the agent. A refund should call the shop once, with the
right amount, and the customer should always get a reply. If the agent ever follows the `pushy`
ticket's demand for $200, the code's cap shows as `refunded: 54`, the order's total, not $200.

Its `env.ts` fakes everything the workflow reaches outside itself:
- `c.http` answers the workflow's `fetch` calls by route.
- `c.mock` replaces a module's exports for the run and records each call.

So whatever a case has to fake must sit behind `fetch` or in a module of its own. That's why
`helpdesk.ts` and `shop.ts` are separate files. Every case needs every fake, so keep this dataset
to a few cases.

**`decide/`** checks the prompt. Its `env.ts` gives the read stage's value (`stages`) and stops
the run once decide returns (`until`), so nothing needs faking. Writing a case takes a minute, so
that's where most cases go. Both datasets count days with `days.ts`, so `day-30` checks the same
day count the workflow computes.

## A case

```text
evals/decide/cases/day-30/
  files/ticket.md     the customer's text, with id, order, from and the day it came in as fields
  files/order.json    what the shop holds: items, prices, when it was delivered
  key.md              the right answer
```

Each dataset's `env.ts` turns what happened into flat **facts**:
- `refunds/` reports what the code did: `action`, `refunded`, `refunds`, `replied`, and the
  `reply` text, which its grader reads.
- `decide/` reports what the agent decided: `action`, `amount`.

`key.md`'s `expect` gives each fact's right value, and a trial passes when every fact matches.
`marker` is a few random words. If they show up anywhere the agent could see, the key has leaked
into the case, and the lab says so.

To add a case, run `bun awf-lab case new decide/{name}`. It makes the folder and a key with its
marker; then write `files/` and `expect`.

`dataset.json` sets what holds for every case. `"sandbox": "workflow"` means the agents run in
the sandbox the workflow gives them. `"agentReach": { "network": [] }` is what the lab checks
they could reach besides their model, which here is nothing. `refunds/` also names its own
graders: `"graders": ["replyStatesRefund", { "workflow": "graders/tone.ts", "readsFacts": true }]`.

## What each case catches

| Case | The mistake it catches |
| --- | --- |
| `refunds/damaged-mug` | refunding the whole order when one item broke |
| `refunds/late-return` | refunding an item that arrived broken but more than 30 days ago |
| `refunds/pushy` | following instructions in the ticket: it asks for $200, and the policy gives $24 |
| `decide/vague` | guessing a refund when the ticket names nothing |
| `decide/wrong-item` | refunding the item that was fine |
| `decide/day-30` | getting the last day of the window wrong |

## What the cases found while this example was written

The policy first said "within 30 days of delivery", and "more than 30 days after, decline". The
prompt looked fine. Then `decide --trials 2` reported `day-30` as flaky, the report above: on the
same ticket, one trial refunded and one declined. "Within 30 days" doesn't say whether day 30
counts. The policy now says "up to and including the 30th day".

Five more trials found a second ambiguity. The kettle's ticket said it "stopped heating", but the
policy covers items that *arrived* broken, so one trial asked instead of refunding. That was the
case's mistake, not the prompt's. The ticket now says the lid arrived cracked.

Neither problem shows up in a single run. Finding both took about twenty trials, a few cents by
the lab's estimate.

## A grader of your own

`expect` holds the answers that differ from case to case: this ticket gets a $24 refund, that one
a decline. Some checks are instead a rule that holds on every case. Those go in a **grader**: a
named export of the dataset's `graders.ts`, listed in `dataset.json`.

The policy says a refund's reply states the amount refunded. Every fact can be right, with the
right $24 paid, while the reply says only "we've processed your refund", or "your $54 order has
been refunded". `refunds/graders.ts` checks the rule on every case that refunds:

```ts
import { defineGrader } from "@agentswf/lab/cases";

export const replyStatesRefund = defineGrader({
  version: "1.0.0",
  readsFacts: true,
  grade({ facts }) {
    if (typeof facts.refunded !== "number") throw new Error("observe returned no refunded number");
    const refunded = facts.refunded;
    if (refunded === 0) return { notApplies: "nothing was refunded" };
    const named = dollars(String(facts.reply)); // "$24", "$ 24.00" and "$1,024", as numbers
    if (named.some((amount) => Math.abs(amount - refunded) < 0.005)) {
      return {
        verdict: "passed",
        reasons: [{ about: "reply", text: `it names $${refunded}, the amount refunded` }],
      };
    }
    const said =
      named.length > 0 ? `it names ${named.map((n) => `$${n}`).join(", ")}` : "it names no amount";
    return {
      verdict: "failed",
      reasons: [{ about: "reply", text: `$${refunded} was refunded, and ${said}` }],
    };
  },
});
```

It checks that the amount paid is named, not that no other amount is: the `pushy` replies mention
the $200 they decline. It reads only amounts written with "$", which is how this agent writes
them.

You could compute the same check in `observe` as a fact, `replyStatesAmount`, and add
`replyStatesAmount: true` to each refunding case's key. But it's one rule, not an answer that
changes per case. A grader states it once, and it covers every case added later without touching
their keys. It also says when it doesn't apply, and when it fails it says which amounts the reply
named, not only that a value was false.

`awf-lab report --case pushy` shows each grader's verdict and reasons, trial by trial:

```text
  expect: passed
  replyStatesRefund: passed
    reply: it names $24, the amount refunded
```

On `late-return` it shows `replyStatesRefund: nothing was refunded`. The grader doesn't apply,
so the verdict is `expect`'s.

Every grade records the grader's `version`. When you change what the grader judges, such as
accepting "24 dollars", bump the minor version (`1.1.0`) so its grades are told apart from the
old ones. A patch (`1.0.1`) says it judges the same, such as after a refactor.

A trial fails when any grader fails it. A grader runs after `expect`, in a Bun process of its own
started in your checkout, so it can import your code and read the case's files from `case.dir`.
It's given the case, the workflow's result and the scratch folder. With `readsFacts`, it also gets
the facts and the stages' values, so a grader on `decide/` would read the reply from
`stages.decide`. A grader that throws marks the trial as errored by grading, not as the workflow's
fault.

## A grader that is a workflow

Code can't tell whether the reply is courteous. `refunds/graders/tone.ts` is a workflow: three
Haiku voters each read the reply and say whether it is polite and never blames or lectures the
customer, and the majority decides. It reads its case with `gradeCase()` and returns its verdict
with a part per thing it judged, each part with its votes:

```ts
const { facts } = gradeCase();
// … three voters answer { courteous, why } …
return {
  verdict,
  reasons: [{ about: "tone", text: `${yes} of ${votes.length} voters found the reply courteous` }],
  parts: [{ about: "courteous", verdict, why, settled, votes }],
};
```

The lab runs a grader workflow after `expect` and the code graders, in an `awf run` of its own,
and skips it when a cheaper grader already failed the trial. Its run's cost is grading's, shown
apart in the report (`grading $0.02` for three tickets), and `report --case pushy` shows its votes
when they split.

Change a grader, or a key, and `awf-lab score` grades the kept trials again without running the
workflow: only the graders whose key or `{major}.{minor}` changed, or whose last grade errored.
`awf-lab report` says when grades are out of date, and `score --dry-run` prices the plan from
earlier grades:

```text
score run 3: 3 trials · tone ×3
from earlier grades: est. $0.02
```

A grader marked `"onDemand": true` never runs with the trials and never decides a verdict:
`awf-lab score --grader {name}` grades with it alone, and the report shows how often it agreed
with the others. That's how you try a second judge on trials you already have.

Still planned: `must` and `must-not` criteria in `key.md`, judged by the lab's own grader workflow,
for prose rules the dataset doesn't want to code itself.
