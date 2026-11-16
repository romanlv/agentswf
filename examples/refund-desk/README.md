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
- `refunds/` reports what the code did: `action`, `refunded`, `refunds`, `replied`.
- `decide/` reports what the agent decided: `action`, `amount`.

`key.md`'s `expect` gives each fact's right value, and a trial passes when every fact matches.
`marker` is a few random words. If they show up anywhere the agent could see, the key has leaked
into the case, and the lab says so.

To add a case, run `bun awf-lab case new decide/{name}`. It makes the folder and a key with its
marker; then write `files/` and `expect`.

`dataset.json` sets two things. `"sandbox": "workflow"` means the agents run in the sandbox the
workflow gives them. `"agentReach": { "network": [] }` is what the lab checks they could reach
besides their model, which here is nothing.

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

## Grading beyond exact facts

`expect` compares facts exactly. Two more kinds of grading are planned, and this example will gain
both when they ship:

- `must` and `must-not` criteria in `key.md`, judged by an agent, such as "the reply doesn't
  promise a refund that wasn't made";
- a dataset's own code grader, in `graders.ts`.
