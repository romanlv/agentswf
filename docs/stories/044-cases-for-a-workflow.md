---
id: "044"
title: "Try a workflow on cases you wrote, and see what it does"
summary: "A person writes a case (an input and what a good result looks like), before a workflow exists or after a run went wrong; awf-lab runs the workflow as it is now on every case, as many times as you ask, and shows case by case what passed, how long it took and what it cost. A run can be set beside an earlier one."
type: story
status: draft
epic: loop
discovered_in: "a conversation about evals built from runs, 2026-11-09"
depends_on: ["008", "010", "011"]
---

# Try a workflow on cases you wrote, and see what it does

This story holds the current design. [[workflow-cases]] is the earlier thinking behind it; where
the two differ, this story is right. The commands and example reports are sketches to react to;
the formats, the rules and what is marked settled or costly to change are the design.

To decide whether this is what you want, read Outcome, How it works and Scope. The rest is for
whoever builds it.

## Outcome

Today, when a workflow gets something wrong, you fix the prompt, run it again on whatever is at
hand, and hope. Nothing remembers the email it misjudged last week, and nothing shows you, case
by case, what your change or a cheaper model did differently.

After this story there is a way to give a workflow a made-up input in place of the real one, check
what it returns, and do that for many inputs at once. Three parts, as in any eval:

- **The variant**: a small piece of your own code that feeds a case to the workflow in place of
  the real inbox or the real request, and picks what stays real, such as the model.
- **The cases**: an input and a *key*, which says what a good result looks like, one folder
  each. A workflow's cases together are its *dataset*.
- **The grading**: graders, which are code or another workflow. Two are built in: exact checks
  done by code, and written criteria judged by an agent. A dataset can bring its own, such as a
  review scorer that gives recall and precision. Whether an agent judges criteria well enough is
  tested first (task 1); if it doesn't, the criteria judge does not ship. A case can run several
  times (`--trials`), since agents don't answer the same way twice.

**The basic thing: run the workflow as it is now, and check it.** Like a test run, on the code in
your checkout:

```sh
awf-lab case new mail/trip-form        # make a case folder, then fill it in (the first time,
                                       # also awf-lab.json and the dataset's dataset.json)
awf-lab run haiku --trials 3           # the workflow as it is here, on every case, three times
                                       # (keys with criteria need a judgeAgent, in awf-lab.json or dataset.json)
```

```text
mail · 12 cases · 3 trials each · variant haiku · branch shorter-prompt (a1b2c3d, uncommitted changes 5e6f)
sandbox: the workflow's own · judge claude-sonnet-5-5, same family as the variant

passed every decided trial   10 cases
passed some                  1 case
passed none                  1 case
too few trials decided       0 cases
trials that errored          0 of 36
trials whose grading errored 0 of 36
trials undecided             1 of 36
time per trial, median       8s
est. cost per trial, median  $0.004
est. cost, all trials        $0.15
grading, all trials          $0.80
criteria left unsettled      1 of 90   (criteria judged: 30 × 3 trials)

not passing, or undecided
  no-school-friday    short    1/3    expected false, got true twice
  trip-form           k2       2/2, 1 undecided    Judge split on k2 once
  grade-3-only        k3       0/3    violated. Judge: "lists the grade 3 trip as an action"
```

That is the whole of it for most days: what the workflow does now, case by case, against what you
said good looks like. With one dataset and one variant, `run` needs neither name. Without `--trials`, a case runs once.

**How a trial passes.** In the report above, `short` is a field your variant reads from the
result and the lab compares exactly. `k2` and `k3` are criteria from the case's key: a `must` is
something that should be true of the result, a `must-not` something that should never be.
Three agents vote on each criterion.

Each trial ends one of three ways:

- **Passed**: every exact check matched and every criterion was judged the right way.
- **Failed**: at least one check or criterion went the wrong way.
- **Not decided**: something other than the workflow's answer got in the way. The judges split
  on a criterion (*undecided*), the run timed out or crashed (*errored*), grading itself broke,
  or the key leaked to the agents. These are counted on their own rows, never as failures.

A case is counted in the "passed" rows when at least two of its three trials were decided, and
its line says what happened to the rest ("2/2, 1 undecided"). A case with fewer decided trials
goes in "too few trials decided". A case with no key yet is counted only under "cases with no
key".

**Reading the report.**

- **Cost** is an estimate from list prices, not a bill. If some usage had no known price, the
  cell says "partly unpriced", so a model without a price never looks cheap.
- **Per trial** figures are the workflow's own; what the judge cost is on its own line.
- **Medians** of time and cost leave out errored trials, so one timeout doesn't skew them. A
  variant that often times out can then look fast; the errored row is where that shows, and
  "est. cost, all trials" includes every trial.
- **sandbox** says what kept the agents in: here, the sandboxes the workflow opens itself.
- `awf-lab report --case trip-form` prints one case in full, with each trial's workflow run, so
  `awf logs` shows what the agents did.

A case can also come from a run that already happened:
`awf-lab capture {run id} --needs-work "{note}"` rebuilds its input from what the run left (an
email's id, a request) into a new case for you to write the key of. With `--good` in place of
`--needs-work`, it also drafts `expect` from what the run returned, for you to check: a run you
call good is not proof. It is the last task here; until it is built, you make the case by hand.

**Comparing is one run set beside another.** Every `awf-lab run` is kept under a label, which is
the branch's name unless `--label` gives another (the short commit on a detached checkout), with
the commit it ran on. To see what your change did, set this run beside the comparable run
labelled `main`, picked as the rules below say:

```sh
awf-lab report --beside main
```

```text
mail · 12 cases in both · 3 trials each  main (9f8e7d6)     shorter-prompt (a1b2c3d, uncommitted 5e6f)
variant                                  haiku              haiku
sandbox                                  workflow's own     workflow's own
judge's family                           same               same
passed every decided trial               12 cases           10 cases
passed some                              0 cases            1 case
passed none                              0 cases            1 case
too few trials decided                   0 cases            0 cases
trials that errored                      1 of 36            0 of 36
trials whose grading errored             0 of 36            0 of 36
trials undecided                         0 of 36            1 of 36
time per trial, median                   9s                 8s
est. cost per trial, median              $0.004             $0.004
est. cost, all trials                    $0.16              $0.15
grading, all trials                      $0.77              $0.80
criteria left unsettled                  0 of 87            1 of 90

cases whose passes differ by 2 or more   main               shorter-prompt
  no-school-friday    short              3/3                1/3
  grade-3-only        k3                 3/3                0/3

The lab does not say which is better. Read the cases.
```

The last line is printed under every comparison of more than one trial, by design: the lab
never says which is better. At one trial each it reads "One trial each: these are examples, not
rates." instead.

The rules, in order. T is the trials asked for per case, and the **threshold** is max(2,
ceil(T/3)): 2 at 3 trials, 4 at 10. The list's heading names the threshold it used.

1. **Pick.** `--beside {label}` takes, under that label, the finished run of the same dataset
   with the same T that shares the most (case, variant) pairs with the current run, the newest
   among equals. The header says which run it took, and whether it skipped a newer one and why.
   If a current variant has no partner in that run, the header names a run of the label that
   has it. `--beside {label}:{n}`
   takes that run. Runs are never combined.
2. **Refuse.** `--beside {label}:{n}` naming a run of another T, or a label with no run of the
   same T, refuses, naming the counts.
3. **Each case**, the first that applies. At one trial each, each column lists its own "not
   passing, or undecided", each line naming its variant, and the order is:
   - ungraded on either side: left out;
   - leaked, input changed, in one run only, or the dataset's error or grading errored on either
     side: could not compare;
   - one side errored (the variant's error) or undecided and the other not: **differ (errored)**
     or **differ (undecided)**;
   - passed on one side and failed on the other: listed under "differ, one trial each".

   From two trials up:
   - ungraded on either side (no key, a draft, or numbers only): left out, shown only in
     `--case`;
   - leaked on either side, input not the same (both runs' case folders as built, and the
     current case, must have one digest), or in only
     one run (by case name: "not in {label}'s run"): **could not compare**;
   - the variant's own errors (below), or the undecided trials, differ in count by the threshold:
     **differ (errored)** or **differ (undecided)**, listed apart from pass-rate changes, so a
     variant that times out on the hard cases, or pushes outputs to where the judge splits, does
     not look better than one that answers them wrongly. One split is noise; a gap in splits of
     the threshold's size is a signal about the outputs, and is shown as such, not as a pass or
     fail;
   - fewer than two thirds of its trials decided on either side, leaving out errored (the
     dataset's errors included, which are never differ (errored)), grading errored
     and undecided ones (a site that was down or a judge that split is not a change), or
     fewer trials of it in a partial run: **could not compare**, with the reason;
   - passes differ by the threshold even counting every trial not decided the way that narrows
     the gap: each side has lo = its passes and hi = its passes plus its trials not decided, and
     the case **differs** when one side's lo minus the other's hi reaches the threshold,
     naming the check that failed. 3 passes against 1 is listed (3−1 = 2); 3 against 0 passes
     with one undecided is listed (3−1 = 2); 2 passes with one undecided against 0 with one
     undecided is not (2−1 = 1).

At 3 trials a case that passes two times in three can show 3/3 on one side and 1/3 on the other
by chance, so the list is of cases to read, not of changes found. The header says how many cases
are in both runs, and when the picked run covered fewer of the dataset's cases. Every row of a
side-by-side report, the summary rows and a grader's pooled numbers included, counts only those
cases; a line under the header gives how many each side had outside them, left out when both
are zero.

The same rules set two variants of one run side by side, as two columns with a "differs" list
between them: same commit, same inputs, same trials, the cleanest comparison there is. Across
runs, columns pair by variant name, variant by variant, the earlier run first; a variant in only
one run is shown alone, so renaming a variant's file, or a dataset's folder, stops it comparing
with its kept runs.

**Your first run on `main`.** The run on `main` is one you made there: before you started the
change, or in another checkout of `main`. The first time, `main` has no `evals/` folder yet.
Either commit `evals/` to `main` and run there, or run `awf-lab run --label main` on your branch
before editing anything. (A committed key is within reach of agents that work inside the
repository; "How the key stays out of reach" below says what that means for you.) Runs of one
project are kept in one place, whichever checkout made them. The same goes for every case you
add later: run the dataset again under `main`'s label (`awf-lab run --label main`) before you
change the workflow, or the new case shows only as "not in main's run". When the dataset is too
costly to run again whole, `--cases {new}` makes a run of its own, which `--beside main` does not
pick over a fuller one; set it beside with `--beside main:{n}`. A run records the branch it was
made on, and a column whose label is not that branch says so: "main (made on shorter-prompt,
a1b2c3d)".

**What counts as the same case.** Only cases whose input is the same in both runs are compared,
and the input includes the files a dataset's cases share: edit those and no case compares until
both sides have run again. Every run costs its full price again; nothing is reused from an
earlier one. If you edit a key between two runs, `report --beside` asks you to run
`awf-lab score` first: it grades both runs' kept trials again against the keys in your checkout,
and pays the judge again, without running the workflow. A trial keeps every score it was given;
the report reads the one made against the current key and graders.

**Two variants in one run are two columns.** A variant is a file that wires your workflow to a
case; a second one with another model or other settings is a second variant. `awf-lab run haiku sonnet` runs both and reports them side by
side, the same way.

**Before you start:**

- It needs git: a run is kept under its branch and commit.
- The lab is not published. A project uses it by linking `@agentswf/lab` from a checkout of this
  repository (`bun link`), which also gives it `awf-lab`.
- Your workflow has to take the services it talks to, and things like today's date, as
  arguments, or there is nothing to swap.
- Put your model's login (such as `CLAUDE_CODE_OAUTH_TOKEN`) in the environment before
  `awf-lab run`, and the login of the judge's harness too when it is another provider's. The lab does not read the files your own launcher reads.
- Anything you forget to fake stays real. The lab does not stop it.
- Criteria are judged by three agent votes per criterion per trial, on your credentials. That
  costs apart from the trial, at the rates the report uses, and the report shows its total. On a cheap workflow, judging can
  cost more than the trials.
- The project's own `agentswf` runs the trials. If it is too far from the lab's to be read, `run`
  stops and says so.
- One `run` or `score` of a project at a time, whatever the dataset; a long run holds up the
  others. Judging adds one judge run per trial, about as long as the trial again for cheap
  workflows.
- Trials run one at a time, round by round: trial 1 of every case and variant, then trial 2, so
  a live site that changes during a long run does not fall on one variant.
- A key you commit can be read by an agent that works inside your repository, as the mail
  triage's do until task 2 moves them out. The lab notices a key copied word for word, not one
  put in other words.
- Nothing here is stable yet. Kept runs and your variant files may need redoing after you update
  the lab.
- A variant, and a dataset's optional `setup.ts`, `graders.ts` and `capture.ts` (the dataset's
  own code), are your own trusted code. They run on your machine with your whole environment,
  credentials included, outside any sandbox. A `check` that runs what the agents built, as
  web-to-cli's does, runs code agents wrote: give that command only the environment it needs,
  as the example below does; the lab does not sandbox it.
- A trial of web-to-cli's build (below) acts on a live site. A `must-not` is graded after the act; it prevents
  nothing.
- Cases and results can hold private text, such as real email. Results are kept outside the
  repository, under `~/.awf/lab/`, with a full copy of each trial's input and result; delete a
  run's folder there to be rid of it. A cases folder with real mail belongs in a private
  repository.
- What is kept in `~/.awf/lab/` can hold a key: a judge's reasons quote it in other words, and
  the record of a grader that is a workflow holds it word for word, without its marker. An
  agent whose sandbox can read your home folder could read them, and the tripwire would see
  neither.
  A `"workflow"` dataset trusts its workflow's sandboxes to keep agents out of your home folder,
  and out of your repository's `evals/`, where the keys sit; tasks 2 and 5 check both for the
  two workflows here.

The lab is tried on two workflows that pull in opposite directions:

- **A mail triage.** A scheduled workflow reads new mail and has one agent per email decide
  whether it matters and summarize it. The question: given this email, what would it produce? A
  trial takes seconds and costs cents, the answer is structured, and nothing real is touched.
- **web-to-cli's build** ([`core/workflows/build.ts`](https://github.com/romanlv/web-to-cli)).
  From one sentence, agents explore a live site, write a command for it, check it and merge it.
  The question: can it be faster or better, and on which models? A trial takes half an hour and
  costs dollars, it writes code, and it needs the real site.

## How it works

```text
evals/                              in your project, beside your workflows
  awf-lab.json                      marks the folder: { "kind": "awf.lab-workspace/0",
                                    "datasets": "datasets",
                                    "judgeAgent": { "harness": "claude",
                                                    "model": "claude-sonnet-5-5" } }; may say where
                                    results are kept ("store")
  datasets/mail/
    dataset.json                    which sandbox a trial runs under
    setup.ts                        optional: prepares a trial
    graders.ts                      optional: the dataset's own graders
    capture.ts                      optional: turns a past run into a case
    files/                          what every case shares: the priorities
    variants/haiku.variant.ts       your workflow, wired to a case
    cases/trip-form/
      input.json                    optional: small facts, such as today's date
      files/                        optional: what the workflow reads, such as the email
      key.md                        what a good result looks like
      key/                          optional: files a grader needs, such as a review's evidence

  awf-lab run
     for each case, for each trial, in temporary folders outside your repository
     (this hides the key only from agents that work in those folders; see below):
       1. make the case folder: the dataset's files/, then the case's files/ over them, then
          input.json. Never key.md or key/.
       2. make an empty scratch folder. Run the setup in it, if the dataset has one.
       3. look for the key's marker in both folders; if found, the trial ends as leaked
       4. awf run the variant, told where the case folder is               ─▶ a result
       5. call the setup's check; then look for the marker in what the run and the check left
       6. run each grader on the result and the key, while the scratch
          folder still exists                                              ─▶ a score
  awf-lab report                    reads the stored scores; runs nothing
```

The words used below:

- **Dataset**: the cases for one workflow, with its variants and its settings.
- **Case**: an input and a key, one folder.
- **Key**: what a good result looks like: `key.md`, and `key/` when a grader needs files. It is
  never copied to where the workflow works.
- **Grader**: code, or another workflow, that turns a trial's result and the key into a score: a
  verdict, numbers, or both. `expect` and the criteria judge are the two built in.
- **Variant**: a file that runs your workflow on one case.
- **Setup**: the default export of `setup.ts`, code that prepares a trial before the workflow
  starts. Nothing else is called setup. The dataset's graders live in `graders.ts` and its
  `capture` in `capture.ts`, each a file of its own so that editing one never makes the others'
  scores stale.
- **Trial**: one run of one variant on one case.
- **Run**: one `awf-lab run`: every trial it made, kept together under a label. (A trial's own
  `awf run` is called "the workflow's run" where the two could be confused.)
- **Case folder**: the copy of a case a trial may read. **Scratch folder**: an empty folder a
  trial may write in. Both are made per trial and deleted after.

Why it is laid out this way:

- **A folder per dataset**, because the sandbox, the setup and the shared files belong to one
  workflow's cases.
- **A folder per case**, because a case can hold any file (an attachment), and a diff shows
  whether its input or its key changed.
- **The key in a file of its own.** The lab copies every file except `key.md` and the `key/`
  folder beside it. Skipping two fixed names is simple and easy to test. If the answer sat inside another file, the lab would have to cut it out, and a mistake
  there would show the agent the answer.
- **Variants inside the dataset**, because a variant imports one workflow and so belongs to one.

**A case** can be written before any workflow exists. For the mail triage:

```json
// cases/trip-form/files/email.json
{
  "id": "m1",
  "from": "Office <office@school.example>",
  "subject": "Grade 4 trip to the science centre",
  "date": "2026-10-26T15:00:00Z",
  "deliveredTo": "parent@example.com",
  "body": "Grade 4 classes visit the science centre on Friday, November 6. Please return the signed form and $12 by Tuesday, November 3. Students need a packed lunch.\n\nGrade 5 families: your trip is in the spring.",
  "attachments": []
}
```

```markdown
<!-- cases/trip-form/key.md -->
---
kind: awf.case-key/0
marker: lantern-copper-walrus-tangerine
expect:
  relevant: true
  short: false
criteria:
  - id: k1
    kind: must
    text: the summary gives the deadline for the form and the money, Tuesday November 3
  - id: k2
    kind: must
    text: the summary says to pack a lunch for Friday November 6
  - id: k3
    kind: must-not
    text: the summary presents the grade 5 spring trip as something to act on
---

Two dates in one email, and a paragraph for another grade.
```

A key made by `capture` (task 6) also has `captured: { run: {run id}, mark: good | needs-work,
note: "{note}" }` in its frontmatter (no `note` with `--good`), and `draft: true` until the
person has written it.

**The key has two parts.** `expect` lists fields and the values they must have; code checks it, so
it is free and exact. `criteria` are sentences an agent judges: a `must` should be true of a good
result, a `must-not` should never be. A criterion's `id` is how two runs and two scores pair it,
so keep it once the criterion has been scored: a renumbered criterion reads as a new one and is
judged again. The text under the frontmatter is your own note on why the
case exists. `marker` is a few random words `case new` writes; the lab uses it to notice a key that
got out (below).

**A variant** is a small file that runs your workflow on one case. Both workflows already take
the outside world as arguments (an inbox, git, the site), so their tests can pass fakes. A variant
does the same, in ordinary code of your own: where the workflow would talk to the real inbox, the
variant hands it one built from the case. You choose there what is fake, what is real, and what
throws. The lab gives it two things: `defineVariant`, and `trialCase()`, which says where this
trial's case folder is.

```ts
// evals/datasets/mail/variants/triage.ts
import { defineVariant, trialCase } from "@agentswf/lab/cases";
import type { Email, Mailbox } from "../../../../mail-triage/mail";
import { mailTriage } from "../../../../mail-triage/workflow";

const notAllowed = (what: string) => async (): Promise<never> => {
  throw new Error(`not allowed in a trial: ${what}`);
};

export function triage(choice: { model: string }) {
  // Read the case only inside functions. The lab also loads this file just to read its
  // settings, and there is no case then.
  const file = (name: string) => Bun.file(`${trialCase().dir}/${name}`);
  const email = async (): Promise<Email> => {
    const raw = await file("email.json").json();
    return { ...raw, date: new Date(raw.date) };
  };
  const inbox: Mailbox = {
    inbox: "case",
    listNew: async () => [await email()],
    read: email,                                                 // faked: the case's one email
    markDone: notAllowed("labelling an email"),
    reply: notAllowed("sending a reply"),
  };

  return defineVariant({
    workflow: mailTriage({
      env: { ...process.env, MAIL_API_KEY: "unused", TRIAGE_MODEL: choice.model }, // the model is real
      connect: async () => inbox,
      priorities: () => file("priorities.md").text(),            // faked
      notes: { recent: async () => "", add: notAllowed("writing notes") },
      posts: notAllowed("reading a class post"),
      today: () => new Date(trialCase<{ today: string }>().input.today),
    }),
    argv: ["--dry-run"],
    timeout: "10m",
    // What `expect` is compared with. A non-empty `error` makes the trial errored: the workflow
    // catches a failure per email and still completes, so the lab would not see it otherwise.
    read: ({ items: [item] }) => ({ relevant: item.relevant, short: item.short, error: item.error }),
  });
}
```

```ts
// evals/datasets/mail/variants/haiku.variant.ts
import { triage } from "./triage";

export default triage({ model: "claude-haiku-5-5" });
```

A second file, `sonnet.variant.ts`, with another model is a second variant. A variant's name is
its file's, without `.variant.ts`; other files in the folder, like `triage.ts`, are ordinary
code. A workflow that needs nothing faked still needs a variant file, of a few lines. With one
variant in a dataset you never name it; with more, `awf-lab run` without a name stops and lists
them. Datasets are the same: with one you never name it, with more `run` and `report` take
`--dataset {name}`. `case new` takes `{dataset}/{case}`, or `{case}` alone when there is one
dataset. `--cases trip-form,fundraiser` runs only those.

**What is fake, what is real, and what fails.** The lab does not make a service fail because you
forgot to fake it. Your variant does, by handing the workflow a function that throws. The
workflow's types make you supply every argument it requires, but anything the workflow reaches on
its own (a default it fills in, a call it makes directly) stays real. The lab cuts nothing off. To use the real thing,
pass the real thing.

**Writing good cases.** When comparing models, judge with a model from another family than
either: a judge tends to favour its own family's output, and the report marks a column whose
model shares the judge's family. A model's family is its provider, read from its id by a small
table in the lab; an id the table does not know is marked "family unknown". The models are the
trial's recorded "models used", every one of them. Mix in cases where the right answer is "no" (not relevant, declined), or
a workflow that always says yes passes. Before trusting a new key, run its case once and read
why each criterion got its verdict. A case that fails in every column is usually a wrong key, or
a site that changed.

**A dataset says which sandbox its trials run under**, in `dataset.json`:

- `"sandbox": "workflow"` trusts the sandboxes the workflow opens itself. The mail triage puts
  each reader in one that reaches nothing but its model, so this is its setting.

It is the only value this story accepts. The setting is still required, with no default to grow
used to, so a second value can come without breaking a dataset file: `"lab"`, one sandbox the lab
controls around every agent of the trial, which reaches nothing but the model. Neither workflow
here could use it, since both open sandboxes of their own; reviews will, so it comes with the
move. The report says which setting a run used.

**For web-to-cli, a case is a sentence, and the dataset sets up the rest.** Each trial needs a
fresh copy of the CLI, set up for the site, with the request filed. That takes the project's own
commands, so the dataset has a `setup.ts`. It runs in the lab before the trial, and returns how
to start the workflow's run and how to check what was built:

```ts
// evals/datasets/builds/setup.ts
import { $ } from "bun";
import { defineSetup } from "@agentswf/lab/cases";

type Input = { site: string; request: string };
type Options = { agents?: Record<string, unknown> }; // what a variant may change

export default defineSetup<Input, Options>(async ({ root, scratch, input, options }) => {
  // root: the folder that holds evals/. scratch: this trial's empty folder.
  await $`bun run configure hn --url ${input.site} --public --yes --prefix WEBCLI_ --into ${scratch}`.cwd(root);
  // configure copies the whole checkout, keys and git history included: start a fresh history.
  await $`rm -rf ${scratch}/evals ${scratch}/.git`;
  await Bun.write(`${scratch}/workflows.json`, JSON.stringify({ sandbox: true, agents: options.agents ?? {} }));
  await $`git init -q -b main && git add -A && git commit -qm base`.cwd(scratch);

  // A shell of its own: `$.cwd()` would change the default for every later trial.
  const cli = new $.Shell().cwd(scratch).env({ ...process.env, WEBCLI_HOME: `${scratch}/.state`, WEBCLI_NO_WORKER: "1" });
  await cli`bin/hn context:add me --url ${input.site}`;
  await cli`bin/hn context:login me`;
  await cli`bin/hn request ${input.request}`.nothrow(); // filing exits non-zero by design
  const { data: [request] } = await cli`bin/hn requests --json`.json();

  return {
    cwd: scratch,
    env: { WEBCLI_HOME: `${scratch}/.state` },
    argv: [request.id],
    // Runs after the trial, before the scratch folder is deleted. Its fields join `read`'s for
    // `expect`: this is how "does the built command work" gets checked by running it.
    check: async () => {
      // The build names the op itself, so ask the CLI what it was called.
      const { data: [done] } = await cli`bin/hn requests --json`.json();
      if (!done.op) return { runs: false, stories: false };
      // The op is code the agents wrote: run it with the scratch folder's state and nothing of yours.
      const op = new $.Shell().cwd(scratch).env({ PATH: process.env.PATH, WEBCLI_HOME: `${scratch}/.state`, WEBCLI_NO_WORKER: "1" });
      const out = await op`bin/hn ${done.op} --json`.nothrow().json().catch(() => null);
      return { runs: out?.ok === true, stories: Array.isArray(out?.data) && out.data.length > 0 };
    },
  };
});
```

```json
// evals/datasets/builds/dataset.json
{ "kind": "awf.case-dataset/0", "sandbox": "workflow", "keep": ["site/ops/**", "site/knowledge/**"] }
```

```ts
// evals/datasets/builds/variants/haiku-builder.variant.ts
import { defineVariant } from "@agentswf/lab/cases";
import build from "../../../../core/workflows/build";

export default defineVariant({
  workflow: build,
  options: { agents: { builder: { harness: "claude", model: "claude-haiku-5-5" } } }, // handed to setup.ts
  timeout: "90m",
  read: (result) => ({ state: result.state }),
});
```

`build.variant.ts` is the same file without `options`: the build as it ships.

```markdown
<!-- cases/front-page/key.md -->
---
kind: awf.case-key/0
marker: harbor-violet-pepper-anvil
expect:
  state: "done"
  runs: true
  stories: true
criteria:
  - id: k1
    kind: must
    text: the op's code reads a title, points and a comment count for each story
  - id: k2
    kind: must-not
    text: the op submits, votes or signs in
---
```

`expect` covers what running the built command can show. The agent judges the criteria here by
reading the saved code, not by running it. The report marks them that way.

```text
builds · 2 cases · 1 trial each · branch main (4c5d6e7) · sandbox: the workflow's own
judge claude-sonnet-5-5 (same family as both: models are compared here, so judge with
another family's model before trusting the criteria rows)
                                         build              haiku-builder
models                                   other models than the column beside
judge's family                           same               same
passed every decided trial               2 cases            1 case
passed some                              0 cases            0 cases
passed none                              0 cases            1 case
too few trials decided                   0 cases            0 cases
trials that errored                      0 of 2             0 of 2
trials whose grading errored             0 of 2             0 of 2
trials undecided                         0 of 2             0 of 2
time per trial, median                   29m                41m
est. cost per trial, median              $4.80              $2.10
est. cost, all trials                    $9.60              $4.20
grading, all trials                      $0.30              $0.30
criteria left unsettled                  0 of 4             0 of 4
criteria read, not run                   4 of 4             4 of 4

time by stage, median                    build              haiku-builder
  explore                                9m                 12m
  write                                  7m                 9m
  check                                  9m                 16m

not passing, or undecided
  haiku-builder  search   0/1   expect state, runs, stories: got deferred ("no way to do it")

differ, one trial each
  search          build passed · haiku-builder failed (expect state)

One trial each: these are examples, not rates.
```

Time by stage comes from the record of the workflow's run; the workflow adds nothing for it. Time
and cost per trial are the workflow's run alone. Setup time and what each grader cost are recorded
apart, and the report gives grading's total in one line.

**How the key stays out of reach, and how far.** The case folder and the scratch folder are made
outside your repository, and neither `key.md` nor `key/` is ever copied into either. That is enough for a workflow
whose agents work in the scratch folder. It is not enough for one whose agents work inside your
repository: a sandbox lets an agent read the git history of the repository it works in, and a
committed key is in that history. The mail triage is the second kind today: its readers work in
a folder inside the project. Task 2 moves that folder out of the repository, which is right for
the workflow anyway, since its readers handle mail from strangers. (An `evals/` folder you never
commit has no history to read, and comparing still works, since runs are kept outside the
repository.) Because a key can be within reach, every key carries a marker, and the lab looks for it in the
case folder and the scratch folder before the workflow runs, and in the result, the saved files
and what the agents wrote (`awf logs`) after. A git repository in either folder is searched
through its whole history, where a committed key is stored compressed and a plain search would
miss it. A file of `key/` carries no marker, so the lab looks for a copy of it by its digest,
in the same places. A trial where it turns up is marked leaked and not
counted as passed; one found before the workflow runs ends the trial there. The marker is a
tripwire, not a wall: it catches a key that was copied, not one that was read and put in other
words, not part of a `key/` file, and not one written where `awf logs` hides what looks like a
credential.

**Does it tell me which one is better?** No. It shows each case, over a few trials, and you read
it. A handful of cases can't carry a "better" you could trust, and the report says so.

## Scope

In scope:

- Cases written by hand: `input.json`, `files/`, `key.md` with `expect` and `criteria`; files a
  dataset's cases share. `case new`, which makes the folder and the key's marker.
- `defineVariant`, `trialCase`, `defineSetup`, `defineGrader` and `gradeCase`, from
  `@agentswf/lab/cases`;
  `dataset.json`.
- Trials of the whole workflow, repeated, each given a case folder without the key.
- Grading: `expect` by code, against what `read` and the setup's `check` return; `criteria` by a
  judge. Both are graders behind one interface a dataset can bring its own to, as code or as a
  workflow, shaped against what the review scorer needs, though no review grader ships here.
- `run`, which keeps every run under a label; `report`, for one run, one case, or one run beside
  another; `runs`, which lists them; `score`, which grades a kept run again.
- A past run of the workflow turned into a case, marked as good or as needing work (`capture`).
- Both workflows working end to end, with their datasets in their own repositories.

Out of scope:

- Any change to `engine` or `contract`.
- Moving reviews onto the new kind. The review lab was an experiment; it is replaced by this
  design in the next story ([[second-case-kind]], rewritten for it), not kept beside it. Here
  reviews are the testing ground for the design: every interface below is checked against what
  they would need, and `review/` keeps running, with only its import paths changed, until the
  move.
- The `"lab"` sandbox setting, one sandbox around every agent of a trial. It comes with the move,
  since only reviews use it.
- Running another branch for you (`--baseline {branch}`): the lab making a checkout of old code,
  installing it and laying today's cases over it. Until then a run on another branch is one you
  make there.
- Reusing trials across runs. Every run stands alone and runs what it is asked; `--cases` and
  `--trials` keep a long dataset affordable.
- Faking a stage or an agent's answer, to tune one part alone. A recorded answer goes stale as
  soon as an earlier step changes, so what this story lets you fake is the outside services a
  workflow takes as arguments. Starting from a later stage with `awf run --from-stage` is the
  next step ([[workflow-cases]]).
- A verdict, the loop, and holdouts for these cases.
- A ceiling on what a workflow's own sandboxes may allow. It is needed before an agent writes
  variants for you (the loop), because a variant could loosen its own sandbox.
- Keys kept outside the repository. Wanted once a dataset's key must be hidden from agents that
  work inside the repository.
- A shadow: a variant that runs beside the real workflow on each real input, with nothing sent,
  so the two results can be compared and the ones that differ become cases. It needs `capture`
  and a variant that touches nothing real, both of which this story builds; the shadow itself is
  the story after.
- Workflows with events.

## Context and evidence

- Fact: of the lab's 13,000 lines, about 700 (`src/compare`) know nothing of reviews. Almost all the
rest is
  under `src/review`, the command line included: a trial is stored as `findings.json`, a score is
  a label per finding, a variant's `read` returns review findings, and `awf-lab.json` requires a
  git clone and holds one sandbox setting for every dataset.
- Fact, from a read of `packages/lab/src/review` against this design (2026-11-10):
  - A review trial's setup fits: a `setup.ts` can restore the frozen code as `fixtures/git.ts`
    does, with `input.json` holding base and head and `files/` holding `request.md` and the
    bundle.
  - Its grading does not fit `expect` and criteria. Reviews label every returned finding (hit,
    new, wrong, noise, duplicate). A review trial never "passes"; it has weighted recall and
    precision. The judge matches by code, with two voters and a tiebreak, not three that must
    agree.
  - Its grader reads the frozen code, which is gone once the trial's scratch folder is deleted.
  - Its key is more than one file (`key/evidence/`, `fixes.bundle`).
  - Its `"lab"` sandbox must let agents reach their model; reviews used a container.
  - Generic and worth carrying over at the move: plan, estimate and ask before spending
    (`execute.ts` `planRun`), waiting for a subscription window (`allowance.ts`), `runner.ts`,
    and `src/compare` if the verdict stays. About 3,000 lines go then (reuse by version, `loop/`,
    sealing, `check`, `where`, `show`). `build/` (collect, draft-key) is how review cases are
    made, and is not `capture`.
- Fact: neither workflow's argv is its input (one reads an inbox, the other a ledger by id), so
  both need code between a case and a run. [[evaluation]] named this `defineEnvironment` and left
  it for a second kind of case; here it is the variant and `setup.ts`.
- Fact: `awf run --sandbox`, which the lab puts every review trial in
  ([[010-eval-isolation|story 010]]), refuses a workflow that opens a sandbox of its own, and it
  refuses when the workflow opens it, mid-run ([[permissions]], The model). The mail triage opens
  one per reader, with no paths and no network. web-to-cli's build opens one when its
  `workflows.json` says so, and its browser is reached only through a socket that sandbox opens.
  With `"workflow"`, the lab no longer puts every agent in a sandbox of its own, as story 010
  promised.
- Fact: a sandbox lets an agent read the `.git` of the repository its working folder is in
  (`packages/sandbox/src/resolve.ts`, `srt/profile.ts`). The mail readers work inside the
  project.
- Fact: the lab imports a variant file into its own process to read its settings
  (`packages/lab/src/review/lab/load.ts`), so the variant's imports load there too. `awf run`
  loads it again, in a process that has the lab's environment.
- Fact: the lab starts the `awf` of its own checkout (`runner.ts`), which refuses a project whose
  installed `agentswf` is another version. Both projects have their own.
- Fact: the lab's runner gives every run the lab's environment, less the calling session's
  variables; it has no way to add to it for one run (`runner.ts`).
- Fact: `awf` finds the sandbox program on `PATH`, and both projects put their own
  `node_modules/.bin` there before running it.
- Fact: the record of a workflow's run has the time of each stage. It has no count of a stage's
  rounds.
- Fact: the mail result has `relevant`, `short`, `why` and `preview` for each email, and an
  email that fails inside the workflow leaves an `error` there while the run completes.
- Fact: the lab's own numbers say a few cases rarely settle a comparison: 16 review cases ended
  undecided ([[011-compare-variants|story 011]]).
- Fact: the lab's variants ([[008-review-scorer|story 008]]) carry a version raised by hand, and
  results belong to it. This kind has none; a run's label and commit say what ran.
- Constraint: the lab runs workflows only through `awf run` (boundary 5).
- Constraint: [[0003-autoresearch-tools-here-project-data-there|ADR 0003]] keeps evaluation data
  in a repository of its own. This story keeps cases in the project's repository, so the ADR is
  amended first.
- Constraint: `@agentswf/lab` is private and linked, with no promise that its exports stay
  (`packages/lab/AGENTS.md`). `@agentswf/lab/cases` is one more such export.
- Assumption: an agent judging prose criteria agrees with the person who wrote them often enough
  to be useful. Task 1 tests this before anything is built.
- Assumption: the mail workflow can take today's date as an argument, as it takes its inbox.

## Code map

### `packages/lab`

- Paths and symbols: `src/review/lab/execute.ts`, `runner.ts`, `store.ts`, `load.ts`,
  `workspace.ts`; `src/review/format/variant.ts`, `records.ts`, `workspace.ts` (the schema and
  `RENAMED_CONFIG_KEYS`); `src/review/judge/`;
  `src/compare/`.
- Relevance: everything a trial does lives under `review/`. The new kind is built in a folder of
  its own, and `review/` keeps working as it is until the next story moves it over. The two share
  what is already general: starting `awf run` and reading its result (`runner.ts`, once its one
  review type moves out), and `compare/`, which the new kind may import as it stands. What they
  share moves to a neutral folder, so the new
  kind never imports from `review/`. The command line, now `src/review/lab/cli.ts`, moves up to
  a neutral entry that hands a dataset to the new kind or to `review/`; `package.json`'s `bin`
  follows it and gains a `./cases` export for `@agentswf/lab/cases`. `awf-lab.json`'s schema,
  serving both kinds, moves to the shared folder with the part of its loader,
  `src/review/lab/workspace.ts`, that reads the common fields, and with `validate.ts`'s generic
  `checkSchema` and `describeProblems`. The review defaults (`match-first.scorer.ts`,
  `default.compare.ts`) and the checks that need `format/grading` stay in `review/`.

### `packages/engine`, `packages/contract`

- `awf run --run-root` already exists; the lab uses it to keep the workflows' run records in the
  store.

- Checked, no change planned. The lab reads a workflow's run through `awf run --json`,
  `awf logs --json` and `contract`'s `readRun`.

### `scripts/check-boundaries.ts`

- Gains the rules that keep the new folder apart from `review/`: the new folder imports the
  shared folder, `compare/` and contract only, among the lab's own folders (third-party imports,
  `typebox` and `yaml`, are not policed by the script); `review/` may now import the shared
  folder; the shared folder imports neither; only the command-line entry imports both. The new
  kind's loader imports variants, `setup.ts`, `graders.ts` and `capture.ts` by computed path, so it joins
  `allowsComputedWorkflowImport` in `scripts/boundary-paths.ts`, as `review/lab/load.ts` is. A
  new rule refuses the words `mail`, `review` and `finding` in the new folder's identifiers,
  strings, file names and record names; comments are not checked. The new folder and the shared
  folder each get `review/`'s `pure` rule, with their own I/O files named: `runner.ts` and the
  workspace loader in the shared one; in the new one, the loader, the key reader, the store, the
  trial's folders, the marker search, `case new` and `trialCase()`, which task 2's plan lists by
  file; `gradeCase()` and the judge's workflow file, which task 3 adds; and `capture`, which
  task 6 adds.

### The two workflows, in their own repositories

- The mail triage: takes `today` as an argument; its readers' working folder moves out of the
  repository. Its `evals/` folder is new.
- web-to-cli: no change to `core/`. Its `evals/` folder is new.

## Proposed design

Your code runs in two places. `setup.ts` (with `check`), `graders.ts`, `capture.ts` and a
variant's `read` run inside the lab. The variant's workflow, and a grader that is a workflow, run
inside `awf run`, and `trialCase()` works only in the variant's.

- **`defineSetup`** (in `setup.ts`, optional) gets the checkout being tried (`root`), an empty
  scratch folder, the case folder as built (`caseDir`), the case's input and the variant's
  `options` (an empty object when the variant
  gives none). It returns `cwd`, `env` and
  `argv` for the workflow's run, and optionally `check`, a function the lab calls after that run
  and before the scratch folder is deleted. It is `setup.ts`'s default export; without one, the
  workflow runs in the scratch folder with the variant's `argv`.
- **`defineVariant`** wraps the workflow, as `defineReviewVariant` does: `argv`, `timeout`,
  `read`, and `options`, plain data handed to `setup.ts`. When both give an `argv`, the setup's
  comes after the variant's.
- **`trialCase()`** returns the case folder and the input (an empty object when the case has no
  `input.json`). The lab sets `AWF_LAB_CASE` for the workflow's run; without it the call throws
  and says to call it inside a function. Nothing else reads the variable.
- **`dataset.json`** holds what is plain data: `kind: awf.case-dataset/0`; `sandbox`, required;
  `keep`, the paths saved from the scratch folder; `graders`, the dataset's own; and `judgeAgent`, the
  judge's model, when it is not the workspace's.
- **`awf-lab.json`** serves both kinds until the move. `datasets` (the folder) is shared, and the
  new kind adds `judgeAgent`, the workspace's judge as `{ harness, model }`, so a judge from
  another provider can be named (not `judge`, which the review loader
  refuses as the old name of `scorer`), and an optional `store`, which replaces
  `~/.awf/lab/{project}/`; `run` refuses a `store` inside the repository, which holds keys and
  private input that agents working there could read. The review fields (`clone`, `dataset`, `results`, `runs`, `variants`,
  `scorers`) become optional, and are checked only when a review dataset is used; the new kind
  never reads them, `dataset` included, so its results never land in a review `results` folder.
  Without `--dataset`, a command picks a dataset only when the workspace has one dataset, or
  only review datasets and a review `dataset` default; otherwise it asks for `--dataset`.
- **One set of commands.** A dataset folder with a `dataset.json` of `kind`
  `awf.case-dataset/0` is the new kind; one without is a review dataset, as every dataset is
  today. `run`, `score` and `report` hand it to the code for
  its kind, so reviews keep their commands until they move.
- **`capture.ts`** exports, by default, the function that turns a past run into a case (task
  6); **`graders.ts`** exports the dataset's graders by name (below).
- **The project's own `awf` runs the trial** (`node_modules/.bin/awf` under `root`), not the
  lab's, so the engine is the one the workflow was written for. The lab puts that folder first
  on `PATH` for the workflow's run; the criteria judge, on the lab's own `awf`, gets the lab
  checkout's `node_modules/.bin` instead. Before the first trial, `run` runs that `awf` once on a
  workflow that does nothing, written into a temporary folder with no `agentswf` installed above
  it (the engine is found from the `agentswf` above a file, so any `awf` runs this one; the
  binary started is what is checked; a file under the project would bind to the project's),
  and stops, naming both versions, when the record
  version `awf run --json` prints is not the `OUTPUT_RECORD_VERSION` the lab reads, the check
  `runner.ts` already makes after each run.
- **The folders** are made under the system's temporary folder and deleted when the trial ends.
  Each holds an owner file with its run's id and process id. At its start, `run` removes only
  folders whose process is gone. Only one `run` or `score` of a project goes at a time, every
  dataset included, so a two-hour builds run holds up the mail dataset ("Before you start"), under
  an exclusive lock in the store. A grade folder, which holds a key without its marker, is made
  only after its trial's workflow has ended, so with one run at a time no workflow is alive to
  read it.

**Grading.**

- A **grader** is given the case (its folder, input and key, `key/` included), the workflow's
  whole result, what `read` and `check` returned, the saved files (`keep`), and the scratch
  folder. It returns `{ verdict?, numbers?, reasons }`: `passed`, `failed` or `undecided`
  (the grader could not tell, as when the judge's voters split); numbers by name, each a
  count out of a total (`recall: { count: 7, of: 10 }`) or a plain value; and why, as a list of
  `{ about, text }`, `about` naming the field, criterion or finding it explains. A grader may
  also return `parts`: one per thing it judged (a criterion, a finding), each with its own key
  digest, verdict and raw `votes`, and give `settle(votes)`, its rule for turning votes into a
  verdict. The lab stores parts and votes for any grader and knows nothing of what they mean;
  how a grader votes (three that must agree, or two and a tiebreak) is its own business. Whether
  this fits the review scorer is part of M2.
- **Code**: `defineGrader({ grade, settle?, rebuild?, readsFields? })`, a named export of `graders.ts`, named in
  `dataset.json`'s `graders`: `"graders": ["recall"]`.
- **A workflow**: `"graders": [{ "workflow": "graders/judge.ts", "settle": "twoAndTiebreak",
  "rebuild": true, "readsFields": true }]`, a path inside the dataset; `settle` names an export
  of `graders.ts` (a function cannot travel in a workflow's JSON result), and the other two are
  flags, all optional.
  The lab starts it with the project's own `awf run`, under its own sandboxes, as a `"workflow"`
  dataset's trial runs, with `AWF_LAB_GRADE` naming a grade folder, which `gradeCase()` (from
  `@agentswf/lab/cases`, as `trialCase()` is) reads. The lab makes that folder
  beside the trial's other temporary folders, outside the repository, and deletes it after. It
  holds the case with its key (written without `marker`, so no grader is ever given it; for the
  criteria judge, only the criteria to judge, never `expect` or `key/`),
  `result.json`, `fields.json` (what `read` and `check` returned),
  `kept/`, and `grade.json` (`kind: awf.case-grade/0`), which names the scratch folder's path
  when there is one; the
  scratch folder is named, not copied, so the grader's own sandboxes must allow reading it. The
  grader's run is recorded with the trials' runs, in the results folder, never in the project's
  `.awf/runs`. Its result must have the shape above. Its run's cost is grading's cost.
- `expect` and the criteria judge are graders like any other, stored under the names `expect`
  and `criteria`, which are reserved: the loader refuses a dataset grader of either name. A
  dataset uses them by having `expect` or `criteria` in its keys.
- A trial passes when at least one grader gives a verdict and every one that does passed it,
  fails when any failed it, and
  is otherwise undecided. A trial no grader gives a verdict on is neither: its case is "no key"
  when no grader applies, and has only numbers when only numbers were given. Counts are pooled over trials
  and cases before they are divided, so recall over a dataset is weighted as the review scorer
  weights it; a plain value is shown as a median. A dataset whose graders give no verdict has no
  "passed" rows. This shape is a first guess: it is settled by trying it (M2), not argued.
- Graders run inside the trial, after `check` and while the scratch folder holds what the
  workflow left. `score` grades a kept trial again from what was stored: the result, `check`'s
  stored fields (it never calls `check` again) and the saved files. It keeps the stored `read`
  fields unless the variant's `read` digest (below) changed; then it applies the current `read`
  to the stored result, which costs nothing, and the column is marked as below. There is no scratch folder
  then (its path is absent), unless the grader sets `rebuild`: it is then given one the setup
  makes again, from the current checkout and the variant's current `options`: the state before
  the workflow ran, such as a review's frozen code. `rebuild` is designed here and sketched in
  M2 but built with the reviews' move, the first grader to need it; until then the loader
  refuses it, and the score record's rebuilt fields are optional and absent. A grader that needs what the workflow wrote
  names it in `keep`. The score records whether the folder was rebuilt, and from which commit.
- **One outcome per trial.** When several apply, the first in this order counts: leaked,
  input changed, errored, grading errored, needs score, failed, undecided, passed, ungraded. A
  trial whose stored input no longer matches the current case is **input changed**: not
  decided, never graded again, and its case goes under "too few trials decided" in a single
  run. A trial **needs
  score** when a grader that now applies has no entry for it; it is not decided, and a
  single-run report counts it in a row of that name. A trial is **ungraded** when no
  grader gave it a verdict (a draft key, no key, or numbers only); it is not decided, and its
  case is left out of comparisons, listed under its own reason only in `--case`. A known fail is
  therefore shown as grading errored until `score` succeeds, so that a grader that broke is never
  read as a verdict. `score` runs again only the grader that errored, and the trial's outcome is
  worked out again from the entries the report reads (below).
- **What a grader's digest covers**, so a score says when it is out of date:
  - code: `graders.ts` and the files in the dataset folder it imports (the inputs `Bun.build`
    reports for it); editing a code grader's `settle` therefore runs it again, which costs
    nothing. A `settle` also has a digest of its own, `settle.toString()`, which is what lets a
    workflow grader, the judge among them, settle stored votes again without running. Editing the
    setup or `capture` never asks for `score`. A file imported from
    outside the dataset folder is not covered: after editing one, run `score` yourself;
  - a variant's `read`: its own `.variant.ts` file and the files in `variants/` that are not
    variants (such as `triage.ts`). Every grader that reads `read`'s fields (`expect`, a grader
    with `readsFields`) records the `read` digest it graded, so editing `triage.ts` makes those
    stale, and editing `sonnet.variant.ts` touches only
    sonnet's;
  - a workflow: its file and the dataset files it imports, with its `dataset.json` entry's flags;
  - `expect`: nothing beyond the key's values and the `read` digest; its rule, exact equality,
    is part of the score record's format: before the reviews move it is a `/0` change, after it
    a new `kind`;
  - the criteria judge: only what changes a vote: its model, its number of voters, and its
    prompt, meaning the template and the code that assembles each voter's input from the case,
    the result and the saved files. Its `settle` rule (all three agree, today) has a digest of its own, as every
    grader's has: when only that changed, `score` settles the stored votes again, for a
    workflow grader with parts, without running it, so changing the rule, or refactoring the judge's code, never pays to judge old
    trials again.
- A grader that throws, or a grader workflow whose run fails, leaves the trial's score
  **grading errored**: counted in a row of its own, which always appears, not decided, and graded
  again by `score` without running the workflow.
- A trial is **errored** when the setup fails, the workflow's run does not complete, `read` or
  `check` throws, or `read` returns a non-empty `error`. `error` is reserved: a key's `expect`
  cannot name it. An errored trial is counted and shown in a row of its own, and is not
  decided. The stage it errored in says whose it was: the workflow's run failing or timing out,
  `read` throwing and `read`'s `error` are the variant's; setup, `check`, `fields-collide` and
  `fields-missing` are the dataset's. The variant's errors, and undecided trials, are weighed first when two runs are
  compared (the Outcome's rule). Graders do not run on an errored trial, so it costs no
  grading. A run that finishes with the wrong
  answer, like the build's "deferred", is a fail, not an error.
- A **leaked** trial, one where the key's marker turned up, is shown in a row of its own,
  "trials where the key leaked". It is not decided, and a case with a leaked trial on either
  side is left out of a comparison whole and listed under "could not compare". The row appears
  only
  when a trial leaked; "cases with no key", "cases graded by numbers only", "trials that need
  score" and "trials whose input changed" appear when there are any; the three passed rows and
  "too few trials decided" always appear when any grader gives a verdict; the errored,
  grading-errored and undecided rows always appear, the unsettled row
  whenever the dataset has criteria, and "criteria read, not run" whenever a criterion was
  judged from saved files.
- **`expect`** is checked by code against `read`'s fields joined with `check`'s, by flat name,
  `error` reserved, and names starting with `_` reserved for the lab, so a later name it needs
  never collides with a key's. The flat names are costly to change, as `key.md` is: every named
  field must equal the key's value. Values are strings, numbers and booleans only, and `expect`'s
  values are read strictly, with the `yaml` package (YAML 1.2's core schema, a new dependency of
  the lab), in the key reader, one of the new folder's I/O files; it keeps each value's style,
  so a string value under `expect` must be quoted, only `true` and `false` are booleans,
  so `no` is refused rather than read as false. A field that both `read` and `check` return makes
  the trial errored at stage `fields-collide`; a field `expect` names that neither returns, at
  stage `fields-missing`; on `score`, a field the current `expect` names that the stored or
  re-read fields lack makes the new score grading errored at stage `fields-missing`. Both are
  the dataset's, since its key and code disagree, and a wiring
  mistake never reads as the workflow's fail.
- A case row gives its passes out of its decided trials, and how many were not decided and why
  ("2/2, 1 undecided", "2/2, 1 errored").
- **The criteria judge** is a grader workflow in the new folder, run on the lab's own `awf` (the
  project's would refuse a file of another engine), one run per trial, a part per criterion. It is
  given the trial's stored copy of the case folder as built (`input.json` and `files/`, such as
  the email), never a rebuild, the workflow's
  whole result, the saved files, and the criterion's text.
  It is never given the marker or the agents' logs (`awf logs`). The result and the saved files, which
  agents wrote, and which can carry a stranger's email, are data to it, never
  instructions. Three voters each give a verdict, each recorded with its reason, so a later
  change of the rule that settles them reads old scores again without paying for them:
  `met` or `unmet` for a `must`, `violated` or
  `not violated` for a `must-not`. Unless all three agree the criterion is `unsettled`, and the
  judge's verdict is `undecided` unless another criterion failed. "Criteria left unsettled" is
  the report's row for the judge's undecided parts; a dataset's own grader with parts gets the
  same row under its name. A `judgeAgent` or prompt other than the one task 1 checked against
  the person (recorded in Implementation notes) makes the report mark the judge "not checked
  against a person". Its harness and model are `judgeAgent`, set once for the workspace, in `awf-lab.json`, and a dataset may set
  another in `dataset.json`. A dataset with criteria and no `judgeAgent` in either file stops
  `run` before the first trial, naming both files; there is no default model.
- Each voter says whether its verdict rests on the saved files; a criterion any voter judged
  from them is marked "read, not run".
- A case no grader applies to (no `expect`, no `criteria`, and no grader of the dataset's own),
  or whose key says `draft: true`, runs with no grader, and the report counts it under "cases
  with no key", with its time and cost only, and leaves it out of every passed count. A key
  `capture` writes is a draft until the person writes or checks it and removes the line, so no
  grader runs on a key no one has read. Whether a grader also needs to say "does not apply" for
  a case is for M2.

**What is kept.** Each `awf-lab run` is one stored run, under a label that is the branch's name
unless `--label` gives another, or the short commit on a detached checkout. `report` shows the
newest run of the current branch's label, `report --label {label}` or `report {label}:{n}` another;
`--beside {label}` adds the finished run of the same dataset under that label with the same
trials per case and the most (case, variant) pairs shared with the current run (the Outcome's
rule), and `--beside {label}:{n}` a given one, as the Outcome says. A lab run's id is
`{label}:{n}`; no git branch name holds a `:`, and `--label` refuses one, so an id is never read
as a label; `awf-lab runs` lists what is
kept. A
run that was interrupted keeps the trials that finished and is marked partial. Nothing is reused from one run to the
next. Results live outside the repository, in one folder per project
(`~/.awf/lab/{project}/`, unless `awf-lab.json` says elsewhere), so every checkout of a project
shares them and none commits them. `{project}` is the hash of the repository's root commit,
recorded in the store on the first run; later the store is found by any root commit the
repository has, so merging an unrelated history never moves it. Every full clone and worktree
shares it, and renaming or moving the folder does not change it; `run` refuses a shallow clone,
whose root differs;
the folder also holds the repository's name, for people. Two unrelated repositories never share
it. This is costly to change once runs are kept: changing it orphans them. The records of the workflows' runs are
kept there too, so `awf logs` still opens one after its trial's folders are gone, with the
`awf` version the trial recorded; after the project upgrades `agentswf`, an older trial's logs
may be refused, though its stored result and scores still read. The marker search reads them
through the project's `awf`, at the time of the trial.

- A **run** records: `kind: awf.case-run/0`, its label and `n`, the branch it was made on (or
  "detached"), the commit it started on and
  whether there were uncommitted changes, the dataset, the variants, cases and trials asked for,
  when it started and when it finished. A run with no finish is partial. `n` counts from 1 per
  label. A label is stored as one folder name, escaped, so `feat/1` never nests inside `feat`,
  with the label itself in each run record. Beside a label's runs sits a counter file; `run`
  takes the next `n` from it under an exclusive lock, so two checkouts sharing the store never
  clash, and deleting a run's folder never frees its number. `awf-lab runs` lists newest first.
  This layout is costly to change once runs are kept, as the project's identity is.
- A **trial** records: `kind: awf.case-trial/0`, the label and run, the dataset, the case and a
  copy of its case folder as built (the shared files and `input.json` included, never the key),
  with its digest, a digest of the
  setup (`setup.ts` and the files in the dataset folder it imports), the variant and a digest
  of its code (its `.variant.ts` and the non-variant files in `variants/`, the same files as its
  `read` digest), the
  commit, whether there were uncommitted changes and a digest of them (the diff against the
  commit, with untracked files, but not the workspace's `evals/`, whose cases and keys carry
  digests of their own), the sandbox setting, the models used, the `awf`
  version, when it ran, the id and outcome of the workflow's run, its time and cost (the
  accounting's `estimate`, with its `known` and `priced` counts), the setup's
  time, the workflow's
  whole result, what `read` and `check` returned with the digest of the `read` that ran, the
  saved files, whether the marker was found, and, for a trial that errored, where and why
  (`errored: { stage, reason }`, the stage being setup, the workflow's run, `read`, `check`,
  `read`'s `error`, `fields-collide` or `fields-missing`).
- A run whose trials ran on different uncommitted changes (a file edited during a long run) is
  flagged in its report, and a column's header shows the digest whenever there were uncommitted
  changes, so two runs on one commit with different edits are told apart.
- A **score** records: `kind: awf.case-score/0`, the trial, when it was made, and one entry per
  grader: its name, a digest of the part of the key it reads (`expect`'s values for `expect`,
  each criterion for the judge, keyed by its `id`, the whole key with `key/` for a dataset's
  own), a digest of its
  code (or of its workflow file, with the grader run's id), for a grader that reads `read`'s
  fields (`expect`, and a dataset's own that sets `readsFields: true` in `defineGrader`, or in `dataset.json` for a workflow) the
  digest of that `read` and the
  commit it came from, so the judge, which reads the whole result, does not go stale when a
  variant's model changes, its verdict, numbers with their counts,
  reasons, model, what it cost (as a trial's), a digest of its `settle`, where and why it errored (`errored: { stage, reason }`, as a
  trial's), and whether its scratch folder was rebuilt
  and from which commit, and its parts, if any, each with its key digest, verdict and votes.
  For `expect`, the reasons are each field's outcome; for the judge, the parts are its criteria,
  with a digest of its prompt and the id of the judge run that judged them (one run judges every
  criterion of a trial, each by its own three voters, given that criterion alone, as task 1
  tested; `score` judges the changed criteria again in one new run). A trial keeps every score it is given.
- **Which entry the report reads**, per grader (per part, for a grader with parts), the one rule.
  A trial with no entry at all for a grader that now applies is not decided ("needs score")
  until `score` runs, and the report names the command. A case compares, and a trial is graded
  again, only when its stored input digest equals the current case's (and, beside another run,
  that run's); otherwise it shows "input changed", its case goes under "could not compare", and
  no `score` is asked for. Otherwise, the
  newest entry whose digests match the current ones and that did not error; when every matching
  entry errored, the newest errored one, and the trial counts as grading errored. When the
  current `read` errors on a column's stored results, its graders that read `read`'s fields fall
  back to the newest entry made with that column's own `read`. Whenever the code that graded a
  column's entries (a `read`, or a rebuilt folder) is from a commit other than the one the
  column ran on, the column says so in one mark, "graded with {commit}'s code". With no entry
  whose digests match, a single run's report shows the newest entry, marked "graded against
  older keys or graders", and names the exact `score` command; `report --beside` refuses until
  `score` has run, and names it. It refuses the same way when a grader that now applies has no
  entry on one run or both, such as criteria added to a key that had only `expect`.
- **`awf-lab score [{label}:{n} | --label {label}] [--beside {label} | --beside {label}:{n}] [--dataset {name}]`**, the
  current branch's newest run unless told, with the `--beside` run too when given, grades again
  only the graders whose digests no longer match, whose newest entry errored, or that have no
  entry at all (a draft key made final, criteria added to a key, a grader added to
  `dataset.json`), so editing the
  note under a key's frontmatter costs nothing for `expect` and the judge (a dataset's own
  grader reads the whole key). Graders are given the trial's stored case folder and the current
  key. A trial whose stored case digest no longer matches the current case is not graded again;
  it shows as "input changed", and its case cannot be compared until it runs again. When the
  current `read`, applied again, throws, returns `error` or collides with `check`'s fields, the
  trial's new score is grading errored at stage `read`, and the report reads the fallback above,
  so a change of the result's shape never leaves the other side unreadable.
- **What may change, and what may not.**
  - `/0` on what the lab writes means the format may change without a way to read old files.
    The formats people write by hand start at `/0` too, but the converter rule below covers
    them from the first release: their next incompatible change makes them `/1`, with a
    converter.
    Every record the lab writes, run, trial, score and `grade.json`, stays `/0` until the
    reviews move: reviews will bring what the records have not met yet (the `"lab"` sandbox,
    `rebuild`'s frozen code, a `key/` of several files, a grader's own parts), and the move is
    where they become `/1`. The score record keeps
    each judge voter's verdict, so a changed voting rule never needs old runs judged again.
  - Costly to change, and not covered by the `/0` waiver: a change ships with a converter in the
    lab, or the lab keeps reading the old form.
    - The project's identity, by which kept runs are found, and the store's layout: the escaped
      label folder, its counter file, and `{label}:{n}`.
    - The names that pair kept runs and scores: a case's folder name, a variant's file name, a
      dataset's folder name, a grader's name (a workflow grader's is its path inside the
      dataset) and a criterion's `id`.
    - What each digest covers and how it is computed. The input digest is recomputed from each
      trial's stored copy of its case folder when its rule changes, so no kept run reads as
      "input changed" for it; a change to a code digest only asks for `score`.
    - The case and dataset layout and its reserved names: `cases/`, `files/`, `input.json`,
      `key.md`, `key/`, `variants/*.variant.ts`, `setup.ts`, `graders.ts` and `capture.ts`.
    - The formats people write by hand and commit: `key.md`, `dataset.json` and `awf-lab.json`.
      `awf-lab.json` gains `kind: awf.lab-workspace/0`, optional until a new-kind dataset is
      used, so review workspaces load as they are; the review loader accepts `kind`,
      `judgeAgent` and `store`. `dataset.json`'s `graders` field is exempt until the reviews
      move.
  - Unstable, with no converter, as "Before you start" says: the code shapes people write
    against, variants, `defineSetup`'s return and a grader's result.

**What a report may set side by side.** Two runs are compared only on cases with the same input,
and only when they asked for the same trials per case. Columns pair by variant name.
If their keys or graders differ from the current checkout's, the report asks you to run `score`
first, which grades both runs' trials against the current ones. A column says its
label, commit and variant. A column that started more than 30 days before the one beside it, on other models than the one beside
it, or whose model shares the judge's family, says so, and so does a column whose trials ran a different setup (`setup.ts` and the files in the dataset folder it
imports, by digest) from the other's, or different variant code (the variant's
digest, above). Which cases are compared, and how, is the Outcome's numbered rules, stated only
there; the report prints the "differs" list as "cases whose passes differ by {threshold} or
more".
A grader's numbers are shown pooled per column, side by side, with no "differs" list of their
own; M2 checks that the stored per-trial counts are enough for a per-case comparison when
reviews move.

**The marker search** reads the case folder and the scratch folder before the workflow runs, and
after it the result, the saved files, and everything `awf logs` has for the workflow's run, read
to the end. In a git repository inside either folder it also searches every commit
(`git grep` over `git rev-list --all`). For `key/`, it looks for a file whose digest matches one
of the key's files, and, in a git repository, for each `key/` file's blob id (`git hash-object`)
among `git rev-list --all --objects`. The marker is a few plain words, a shape `awf logs` does not take for a credential and
hide.

Settled:

- **Keys live beside their cases**, and the marker says when one leaked.
  [[0003-autoresearch-tools-here-project-data-there|ADR 0003]] is amended for this kind of case
  before task 2's code.
- **Grade the result, not the path.** A key is about what the workflow produced. Which stages ran
  and how long they took are shown, never graded.
- **A run on current code is the main thing.** Comparing is a second report over kept runs.
- **Reviews move over in the next story, not this one** (owner, 2026-11-14). Getting the design
  right matters more than moving early; reviews are where it is tested on paper first.
- **Grading is pluggable**: graders are code or a workflow, and the two built in are graders like
  any other (owner, 2026-11-10, confirmed 2026-11-14). Their exact shape is settled by trying it (M2).
- **A past run becomes a case from its traces.** A run leaves enough (an email's id, a request's
  id) for the dataset's own code to rebuild the case in the variant's fake world; nothing records
  more for it, and the engine does not change (owner, 2026-11-14).

What must hold:

- One `run` or `score` of a project at a time. The lock is what keeps a grade folder, which holds
  a key without its marker, from any live agent; trials in parallel first need grade folders
  the running agents cannot reach.
- The lab never copies `key.md` or `key/` into a case folder or a scratch folder, and no trial
  record holds them; a grader workflow's run record, kept in the store, does, as "Before you
  start" says. A marker found in either before the workflow runs ends the trial as leaked, without
  running the workflow.
- A trial that errors is shown, never counted as passed, and its stage says whether it was the
  variant's.
- A trial where the marker turns up is marked leaked and not counted as passed.
- A captured case is never graded against the run it came from. Only the lab's own trials are
  compared.
- A changed key is graded again by `score`, without running the workflow.
- Nothing under `review/` is imported by the new kind, and nothing in the new kind names a
  workflow. (The move to come deletes `review/`; it does not import it either.)

How "done properly" is checked:

1. `scripts/check-boundaries.ts`: the new folder never imports `review/`, and the shared folder
   imports neither.
2. The same script: no word of a domain (`mail`, `review`, `finding`) in the new folder's
   identifiers, strings, file names or record names; comments are not checked.
3. Every record the new kind writes (run, trial, score, and a grade folder's `grade.json`), and
   every `key.md`, `dataset.json` and new-kind `awf-lab.json` it writes or reads, has a schema with a versioned `kind`, checked before writing and on
   reading. A case's `input.json` and `files/` are the dataset's own and have none.
4. A test: a trial whose scratch folder holds a key's marker, in a file or only in a commit of a
   git repository there, or a copy of a `key/` file, is caught.
5. A test: an errored trial is in the report's count.

Alternatives rejected:

- Reusing a trial when the code is unchanged: if "the code" includes the cases, editing a note
  runs everything again. If it doesn't, editing a variant runs nothing again.
- A version number in the variant file, raised by hand, as reviews have: easy to forget.
- The lab checking out another branch to run it: a second checkout, its dependencies, today's
  cases laid over old code, old code run with today's credentials. Deferred, not refused.
- A larger setup surface (`defineEnvironment` with `prepare`, `network` and `capture`; file
  helpers; a variant's `files` and `measures`; placeholders in `argv`): about 25 names where the
  two workflows need 8.
- A grader kind that runs a command: `check` in `setup.ts` does it with your own code and no new
  kind.
- The changed prompt as something a variant passes in: clean, but a workflow would have to expose
  every part someone might change.
- One markdown file per case: easiest by hand, but it holds no attachment and hiding the key
  becomes parsing.
- One table per dataset, as most eval tools have: good for many small text cases, poor for a long
  email and for a case made from a run.
- Faking outside services in the engine: the workflows already take them as arguments.
- Making the lab's review code general first: thousands of working lines and a stored format
  reworked before the new kind has shown any value, and a shared part guessed from one example.
- One sandbox setting for the whole workspace, as `awf-lab.json` has now: datasets differ.
- Turning a workflow's own sandbox off for every trial: the mail triage's is stricter than the
  lab's, web-to-cli's browser is reached only through its own, and a trial should run what ships.
- The whole trial in a container: the workflow's own sandbox would have to run inside it.

## Tasks at a glance

- [ ] 1. By hand: ten mail cases, and whether a judge agrees with the person
- [ ] 2. The mail triage runs on cases, graded by `expect`
- [ ] 3. Criteria are judged, and a changed key is graded again
- [ ] 4. One run set beside another
- [ ] 5. web-to-cli's build runs on cases
- [ ] 6. A past run becomes a case

## Open questions

None open. Answered (owner, 2026-11-14), and written into the design above:

- Q1. When reviews move onto the new kind: in the next story. Here they shape the design only.
- Q2. What a grader is: code or a workflow, returning a verdict, numbers or both; graded while
  the scratch folder exists, and `score` can rebuild the scratch folder for a grader that needs
  it (`rebuild`), designed here and built with the reviews' move; a
  `key/` folder for a key of more than one file. Settled by trying it (M2).
- Q3. How a past run becomes a case: the dataset's own `capture`, in `capture.ts`, rebuilds it from
  what the run left (the email fetched again by its id). No engine change.
- Q4. One set of commands for both kinds: yes; a `dataset.json` of the new `kind` marks the new
  kind.
- Q5. `awf-lab.json`'s git clone: optional, with the other review fields, until the move.
- Q6. YAML in `key.md`: read strictly; `expect` stays in the frontmatter.
- Q7. The judge's model: once for the workspace, a dataset may override it.
- Q8. The age warning on a column: 30 days.
- Q9. A setup that runs the project's own commands: accepted; a case does not carry a prepared
  checkout.

## To measure

- M1. Whether web-to-cli's build minds that its run's id is the lab's, not the request's. Its
  notes say the run carries the request's id. Checked in task 5's plan.
- M2. Whether the grader interface carries the review scorer: in task 2's plan, before the score
  record is built, write the review grader
  against it as a sketch that does not ship (per-finding labels, recall and precision, reading
  the frozen code through `rebuild`, `key/evidence/`), once as code and once with its judge as a
  grader workflow, so both forms have a consumer before they are built. It checks that `parts`,
  `votes` and `settle` carry per-finding labels and a two-voters-and-a-tiebreak rule, and writes
  a review trial against the trial and run records, which stay `/0` until the move. It also
  settles whether
  a grader needs to say "does not apply" for a case, and whether the stored per-trial counts are
  enough for a per-case comparison of numbers. What does not fit changes the interface before
  it is built.

## Task execution rule

Process one task at a time, with one exception: task 2 may start before task 1's decision is
recorded, since task 1 is the person's work and no code. Every task repeats the checklist shown under its details. Do not begin
the next task because the current implementation merely compiles: its design must be recorded, its
diff reviewed by subagents, findings resolved, and focused verification complete.

After all tasks are complete, run story-level verification and request human review of the complete
deliverable.

## Task details

### 1. By hand: ten mail cases, and whether a judge agrees with the person

Outcome: a yes or no on whether prose criteria are worth building, before any code. One day.

Execution:

- [ ] Plan: pick the emails; write the bar below into Implementation notes before looking at any
  result.
- [ ] Implement: no code in this repository. Runs with the workflow's own `--dry-run --again`,
  which reads the real inbox, so a case is an email already there or one forwarded to it. A
  judge prompt run by hand, given exactly what the built judge will be: the case folder, the
  whole result and one criterion per call, voted three times.
- [ ] Review: one subagent checks the counting. There is no diff for a second to read.
- [ ] Resolve: record the numbers and the decision here, and keep each email as a case folder
  (`files/email.json`), with every output that was judged (each run and each broken output, as
  a `result.json`), the person's verdicts and the hand-run judge's per criterion,
  as fixtures, which task 3's live check reads. They hold real mail, so they live in the
  mail project's own private repository, beside its `evals/`, never in this one.
- [ ] Verify: the `Done when` items.

Work:

- About ten emails with about thirty criteria, some of them ones the workflow got wrong. At
  least three where the right answer is "not relevant" or "short", so "always relevant" does not
  pass.
- Each email run three times: about 90 verdicts to give on real outputs (thirty criteria, three
  runs each). Three runs of one email are alike, so this is nearer thirty independent ones than
  ninety.
- On top of those, outputs that should fail, taken from real misses or made by breaking a good
  summary by hand, so a judge that always says `met` is caught: at least fifteen verdicts where a
  `must` is unmet, and at least fifteen where a `must-not` is violated. About 120 verdicts in
  all.
- Before any result is seen, a third of the emails, with at least five broken outputs of each
  kind, is set aside.
  The judge's prompt is written and tried on the other two thirds; task 3's live check uses
  only the third set aside.
- The person gives every verdict before seeing the judge's. Then the judge does, as it will be
  built: three voters, and `unsettled` unless all three agree.

The bar, over all verdicts in the part tried (real and broken together), with `unsettled`
counted as disagreeing with the person. The samples are small (about 30 independent real
criteria, 15 broken outputs of each kind), so Implementation notes give each bar as a count
out of its sample ("2 good results failed, of 61") beside the percentage, and a bar missed or
met by one verdict is said to be:

- The judge calls a violated `must-not` not violated in at most 10% of the `must-not`s the person
  called violated.
- The judge finds at least 80% of what the person called `unmet`.
- On real misses alone (the workflow's own wrong outputs, not broken by hand), the judge finds at
  least 80% of `unmet`s and violated `must-not`s, over at least five of them. With fewer than
  five real misses, Implementation notes say the judge's catch of real misses was not measured.
- The judge and the person agree on at least 85% of verdicts overall.
- Of the verdicts the person called `met` or `not violated`, the judge calls at most 5% `unmet`
  or `violated`, so good results are not failed.
- At most 3% of verdicts are `unsettled`. An unsettled criterion leaves its trial undecided. At
  3%, with about nine verdicts per case over three trials, about one trial in ten is undecided,
  and a case drops out of a comparison, or is listed as differ (undecided), only when two of its
  three are, which is rare.

The bars are measured on the two thirds the prompt was written on: they are in-sample, and
Implementation notes say so wherever they quote them; the held-out tolerance below is what
guards against a prompt fitted to its examples. An `unsettled` verdict on a criterion the
person called `met` or `not violated` counts against the 5% bar, as a good result not passed. The third set aside, which
holds at least five broken outputs of each kind, about 40 verdicts in all, which Implementation
notes give beside the result, is too small to measure a rate; it is a check
that the prompt was not fitted to its examples, with a fixed tolerance: at most one violated
`must-not` missed, at most one `unmet` missed, at most one good result failed, and agreement
within 10 points of the tuned part. It is run once, by hand, at the end of task 1, with the
prompt frozen, and is part of task 1's decision; the prompt is not tuned again on it. Task 3
then checks only that the built judge gives the hand-run judge's verdicts on that part.

Below the bar, criteria leave this story: keys hold `expect` alone, and the key reader refuses
`criteria`, and task 3 builds the grader
interface with `expect` behind it, a dataset's own graders, the key's digest and `score`, with no
judge. Task 3 is then done when its `Done when` items hold, but for the six that need the
judge or its path (editing a criterion, what the judge is given, the grader workflow's test,
the live mail run with criteria judged, the live check on task 1's held-out part, and the
model-family table and column mark); editing an `expect` value and running `score` must then change the report
without a new trial, so a changed key is still graded again; and task 5 drops
"read, not run" and the person's check of the judge's verdicts. With no judge, the grader
workflow path (the grade folder, `gradeCase()`, `grade.json`) has no user that ships, so it is
not built, `gradeCase` leaves Scope, the Verification item on the built judge and the
model-family table are dropped, and
check 3 does not cover `grade.json`; it comes with the reviews' move, and `dataset.json`'s `graders` takes names of code
graders only until then.

Done when:

- The numbers and the decision are in Implementation notes.

### 2. The mail triage runs on cases, graded by `expect`

Outcome: `awf-lab run` and `report` work for the mail dataset, with two variants. It does not
wait for task 1.

Execution:

- [ ] Plan: amend ADR 0003 and rewrite [[second-case-kind]] as "move reviews onto the case kind",
  first. Do M2, so the score record and its grader entries are shaped once. Then inspect the lab's run, store and load code; settle the new kind's folder, which
  shared files move to a neutral one, the trial and score records, and the commands.
- [ ] Implement: only this task's change, with tests.
- [ ] Review: architecture and scope; correctness and proof.
- [ ] Resolve: disposition every finding.
- [ ] Verify: the `Done when` items.

Work:

- The docs and schemas the move changes: `packages/lab/AGENTS.md` (layout, I/O files, layer
  order, `bin`), the root `AGENTS.md` (boundary 5 and the `packages/lab` row), and
  `packages/lab/schema/`, written again with `bun packages/lab/src/write-schemas.ts`.
- The structural moves in the Code map: the neutral command-line entry, which hands a dataset to
  its kind by `dataset.json`; `package.json`'s `bin` and its `./cases` export; `runner.ts` and
  `awf-lab.json`'s schema (`review/format/workspace.ts`), the common part of its loader
  (`review/lab/workspace.ts`) and the generic schema check to the shared folder, the review
  fields made optional and the review defaults left behind; the version check's do-nothing
  workflow, written at run time (`review/lab/nop.workflow.ts` is the review's zero baseline, not
  that, and stays); the boundary
  rules.
- `@agentswf/lab/cases`: `defineVariant`, `trialCase`; `dataset.json`; the case and key formats
  and their checker; `case new`, which the first time also writes `awf-lab.json` (its `kind`
  and `datasets`) and the dataset's `dataset.json` (`sandbox: "workflow"`), for the person to
  check.
- The case folder and the scratch folder, outside the repository; the marker and the search for
  it.
- The runner passes a run its environment, and starts the project's own `awf`.
- The lock on `run` and `score`, and the owner files that let a start clean only dead trials'
  folders.
- A stored run under a label, with its number from the label's counter, marked partial when it
  has no finish; the flag on a run whose trials ran on different uncommitted changes; the trial and score
  records; the `expect` score; errored trials.
- `run` (with `--dataset`, `--cases`, `--trials`, `--label`; one trial unless told) and `report`,
  for a run (a column per variant) and for one case (`--case`).
- `defineSetup` without `check` or `options`, so the marker search has a scratch folder with
  something in it, a git repository included; task 5 adds `check` and `options`.
- The checks under How "done properly" is checked, but for check 3's `grade.json`, which comes
  with the grade folder in task 3.
- The key reader reads and checks `criteria`, but they are not graded until task 3; the
  `judgeAgent` check comes with the judge.
- In the mail project: `today` becomes an argument; the readers' working folder moves out of the
  repository; the `evals/` folder. Check that the readers' sandboxes cannot read the home folder,
  where results are kept, nor the project's `evals/`, where the keys are.

Done when:

- M2's sketch is in Implementation notes, with what it changed in the score record and the
  grader interface.
- A test runs a small dataset end to end on scripted agents and gets the expected report.
- Tests of the costly parts: two worktrees of one repository share the store, found by root
  commit, and a shallow clone is refused; a run's `n` comes from the label's counter under the
  lock, and deleting a run's folder never frees it; a label with `/` is stored as one escaped
  folder; `--label` refuses a `:`.
- The review lab's tests pass, with only their import paths changed, and `awf-lab` still runs a
  review dataset.
- A test shows the lab copies neither `key.md` nor `key/` into either folder, and that a trial whose scratch folder
  holds the marker ends as leaked without running the workflow.
- A test: `case new` in a project with no `evals/` writes `awf-lab.json`, `dataset.json` and the
  case folder, and `run` then runs it.
- A test shows a variant that calls `trialCase()` while its file loads is refused with a message
  that says what to do.
- A test shows an errored trial is counted and shown.
- A test shows a dataset whose `sandbox` is anything but `"workflow"` is refused, and a
  `"workflow"` dataset runs a workflow that opens its own sandbox.
- The mail readers' sandboxes are checked to keep agents out of the home folder and the
  project's `evals/`.
- Live: `awf-lab run haiku sonnet --trials 3` on the mail dataset. The operator's environment
  carries the model's login (`CLAUDE_CODE_OAUTH_TOKEN`), which the project's own launcher reads
  from a file the lab does not load.

### 3. Criteria are judged, and a changed key is graded again

Outcome: `criteria` appear in the report; `score` runs the judge alone on a kept run.

Execution:

- [ ] Plan: the grader interface as M2 left it; the judge's prompt, from task 1's working part.
  The review judge's voting (`review/judge/voting.ts`) is built around finding labels, so the
  criteria judge's three voters are written fresh in the new folder, reusing only the shared
  runner; the review voting moves with reviews. The judge is a workflow of the lab's that reads
  its input through the grade folder and `gradeCase()`, as a dataset's grader workflow does, so
  that path has a user that ships. The judge workflow reads the folder with `gradeCase()` in its
  own process and puts what the voters need into their prompts; the voters read no files, so
  "read, not run" means a voter's verdict cites saved-file content. It runs on the lab's own `awf` (the project's would refuse a file of another engine), under its own
  sandbox, which reaches nothing but its model, with its records in the store and its cost on
  the score entry. The runner takes the `awf` to start as an argument: the project's for trials
  and a dataset's grader workflows, the lab's for the judge.
- [ ] Implement: only this task's change, with tests.
- [ ] Review: architecture and scope; correctness and proof.
- [ ] Resolve: disposition every finding.
- [ ] Verify: the `Done when` items.

Work:

- Finding a run: `{label}:{n}`, `--label`, and `--beside`'s choice, for `score` here and for
  `report` in task 4; and `awf-lab runs`, which shows each run's `n`. `{label}:{n}` names one
  run, and so one dataset; `--dataset` is needed only with a bare label.
- The grader interface: `defineGrader` and `gradeCase`, as code and as a workflow, a workflow
  grader named by its path inside the dataset; `expect` moved behind it; the criteria judge,
  its three voters and what it is given; `unsettled`; pooled counts in the report; grading
  errors; the key's and graders' digests on a score; `score`; the "graded with {commit}'s code"
  mark and the single-run "trials whose input changed" row.
- For the live check, a script calls the criteria judge directly on each of task 1's fixtures
  (its case folder and `result.json`); fixtures are not imported as a run.

Done when:

- Editing a criterion and running `score` changes the report without a new trial.
- A test of Pick: `score --beside {label}` takes the run sharing the most (case, variant) pairs,
  the newest among equals, and prints which run it took and any newer one it skipped and why;
  the report's header is task 4's.
- Live: `awf-lab run haiku sonnet --trials 3` on the mail dataset with criteria judged.
- A test shows the judge is given neither the marker nor the agents' logs.
- A test: a dataset's own code grader, named in `dataset.json`, returns counts that are pooled
  into rows of the report, and a dataset whose graders give no verdict has no "passed" rows.
- A test on scripted agents: a grader that is a workflow is given its folder, and its result
  and cost reach the score.
- A test: `score` never runs the setup or calls `check`; a grader that sets `rebuild` is refused
  until the reviews' move.
- A test: a trial whose case was edited after it ran shows "input changed" and is not graded
  again; a column graded with another commit's `read` carries the mark.
- A test: a grader that throws leaves the trial grading errored, and `score` grades it again.
- The model-family table and the column mark.
- Tests: only `settle` changed re-settles stored votes without running the grader; a changed
  `read` is applied again at no cost, with the fallback when it errors; `score` grades only the
  stale, errored or missing graders.
- A test pins the one-outcome order: a failed `expect` with a grader that errored reads as
  grading errored; a leaked trial that also errored reads as leaked.
- The interface built is the one M2 left, or Implementation notes say what changed and why.
- Live: on task 1's held-out part, the built judge gives the verdicts the hand-run judge gave,
  but where the voters split; a difference beyond that is a bug in the built judge, fixed before
  the task is done.

### 4. One run set beside another

Outcome: `awf-lab report --beside {label}` shows two kept runs in two columns.

Execution:

- [ ] Plan: what makes two columns comparable; finding a run is task 3's.
- [ ] Implement: only this task's change, with tests.
- [ ] Review: architecture and scope; correctness and proof.
- [ ] Resolve: disposition every finding.
- [ ] Verify: the `Done when` items.

Work:

- A second run as a column (`--beside`); `report {label}:{n}` and `report --label`
  (task 2's `report` shows the current branch's newest run only); the rules for what may be set side by side, and
  the notes when a column is old, on other models or on a different setup; two variants of one
  run compared as two runs are; the variant's errors and undecided trials
  weighed first; "cases whose passes differ by" the threshold or more.

Done when:

- A test sets two stored runs side by side and compares only the cases whose input is the same.
- A test shows a run whose scores do not match the current keys or graders asks for `score`,
  naming the command, and so does one where criteria were added to a key after both runs.
- A test shows two runs that asked for different trials per case are refused, naming both
  counts, and that a case with too few decided trials on one side is listed under "could not
  compare".
- A test: a case that times out twice on one side and never on the other is listed as differ
  (errored), apart from pass-rate differences, not under "could not compare"; one undecided twice on one side
  and never on the other is listed as differ (undecided).
- Live: the mail dataset on `main` and on a branch with a changed prompt.

### 5. web-to-cli's build runs on cases

Outcome: the builds report above, from real trials. It is the second real use of the formats;
reviews, the third, come before they become `/1`.

Execution:

- [ ] Plan: what `setup.ts` returns; how `keep` reaches the judge; M1.
- [ ] Implement: only this task's change, with tests.
- [ ] Review: architecture and scope; correctness and proof.
- [ ] Resolve: disposition every finding.
- [ ] Verify: the `Done when` items.

Work:

- `defineSetup` with `check`; a variant's `options`; `keep`; time by stage in the report;
  "read, not run" beside criteria judged from saved files.

Done when:

- A test: a criterion any voter judged from saved files is marked "read, not run" in the report.
- A test on scripted agents: a setup's `cwd`, `env` and `argv` start the workflow's run,
  `check`'s fields are graded by `expect`, and `keep`'s files are saved.
- A test shows a setup that copies a key into the scratch folder is caught before the workflow
  runs.
- Live: two cases, two variants, one trial each. About two hours and twenty dollars. The person
  checks the judge's verdicts on these trials, since task 1 tested it on mail only, and the
  agreement is recorded in Implementation notes. More than one disagreement is recorded there,
  and the builds dataset's criteria are not used to compare variants until a larger check
  passes; nothing in the lab stores it.
- The build's sandbox is checked to keep agents out of the home folder, where results are kept,
  and out of the project's `evals/`, where the keys are.

### 6. A past run becomes a case

Outcome: `awf-lab capture {run id} --good` or `--needs-work "{note}"` makes a case from a past
run of the workflow, whether a trial's or a real one.

Execution:

- [ ] Plan: confirm the shape below against both workflows' run records.
- [ ] Implement: only this task's change, with tests.
- [ ] Review: architecture and scope; correctness and proof.
- [ ] Resolve: disposition every finding.
- [ ] Verify: the `Done when` items.

Work:

- `awf-lab capture {run id} --good | --needs-work "{note}"`, with `--dataset {name}` as for
  `run`, needed only when the project has more than one dataset, and `--variant {name}`,
  needed only with `--good`, for a real run, when the dataset has more than one variant (a
  trial's run knows its variant).
- The run id is looked up first in the lab's store, for a trial's run, then in the project's
  `.awf/runs`, for a real one. A trial's run already has its case: `capture` copies the source
  case's own `files/` and `input.json` (not the merged copy, so later edits to the shared files
  still apply), skips the dataset's `capture`, and with `--good` drafts `expect` from the
  trial's stored `read` and `check` fields.
- `capture({ run, root })`, the default export of the dataset's `capture.ts`: given the run's record (argv,
  result, and the folder of its logs) and the checkout, it returns one or more
  `{ name, input, files, part }`, one per case, where `files` maps a path inside the case's
  `files/` to its contents, written as given, and `input` becomes `input.json`: a mail run that read five emails gives five, each
  named from its email, with the email fetched again by its id. `part` is that case's share of
  the run's result, in the shape of a whole result (`{ items: [item] }` for mail), so the
  variant's `read` applies to it. A name already taken gets a number.
- `key.md` is written with the mark, the note, `draft: true` and a marker, as `case new` writes
  one. With
  `--good`, `expect` is drafted by the variant's `read` applied to `part` (`--variant` when the
  dataset has more than one), for the person to check, leaving out the reserved `error`. For a
  real run, fields only `check` returns are left for the person to write, since a past run's scratch folder is
  gone. Either way the case counts under "cases with no key" until the person removes
  `draft: true`; a run that needed work is never the answer, so its key is the person's to write.

Done when:

- A run of each workflow becomes a case with one command, and that case runs.
- A test: a trial's run is captured from its source case without the dataset's `capture`; a
  name already taken gets a number; a captured key stays a draft, and no grader runs on it.

Tasks are checkpoints, not a file-by-file edit script. The implementation agent may adjust the
implementation without changing their outcomes, order, or the story's scope.

## Verification

Automated:

- [ ] A dataset runs end to end on scripted agents: trials, scores, report.
- [ ] The lab copies `key.md` and `key/` into neither folder, and a leaked marker is caught.
- [ ] The review lab's existing tests pass, with only their import paths changed.
- [ ] `bun test`
- [ ] `bunx tsc --noEmit`
- [ ] `bun run scripts/check-boundaries.ts`

Manual or live evaluation:

- [ ] The mail dataset, two variants, three trials each: minutes, a few dollars with the judge.
- [ ] The builds dataset, two variants: about two hours and twenty dollars.
- [ ] The built judge gives the hand-run judge's verdicts on task 1's held-out part (task 3).
- [ ] The mail dataset on `main` beside a branch with a changed prompt (task 4).
- [ ] A real run of each workflow captured as a case, and that case run (task 6).

## Review record

### Refinement

- Draft 1 of [[workflow-cases]] was reviewed by three subagents (feasibility against the code, an
  adversarial pass, prior art and coherence). What they removed is in that document's Considered
  and dropped.
- The setup sketch for both workflows was reviewed by three more (the case layout, the setup
  code, the sandbox and the lab's structure). From them: variants under their dataset, shared
  `files/`, `key.md` flat; the smaller setup surface; that a sandbox reads the repository's
  `.git`; that web-to-cli's `configure` copies `evals/` and renames the environment prefix.
- This story was then reviewed by four (feasibility against the code, eval method, consistency,
  scope and risk). From them: `trialCase()` called inside functions; the project's own `awf`;
  two folders, not one; `check` for a built command; errored trials apart from failed ones; what
  the judge is given; the stronger bar in task 1; runs kept under a label in place of trials
  filed by code state; `--baseline {branch}` deferred; record fields and `/0` kinds; results
  outside the repository; the notes on what to know before using it.
- A second round of two (a builder's read against the code; the owner's goals and eval method).
  From them: how the first run on `main` is made; that the lab does not make an unfaked service
  fail; why a stage is not faked; the op's name read back in `check`; `PATH` and the project's
  `awf`; where results and run records live; the judge as three voters and the tighter bar; one
  trial unless asked; advice on writing cases.
- Two more rounds of two (a strict check against the code and the doc rules; a reader who saw
  only this file). From them: example reports that agree with each other and with the rules; the
  verdicts for a `must-not`; what runs in the lab and what in `awf run`; naming a dataset; the
  judge's cost; "Before you start".
- Three further rounds of two, the same two angles with new reviewers each time. From them: the
  mail readers' folder moved out of the repository; a run's own record; a leaked trial's place in
  the report; what happens to tasks 3 and 5 if task 1 fails its bar; the marker's shape; labels
  and `score` explained where they are first used. The last round returned no blocking and no
  should-fix finding from either reviewer.

## Readiness

- [ ] Outcome and boundaries are concrete.
- [ ] Relevant implementation, callers, and tests are mapped.
- [ ] Evidence and research support the proposed design.
- [ ] Expensive interface, record-format, and stage-gate decisions are settled.
- [ ] Tasks are ordered, coherent, and independently verifiable.
- [ ] Open questions are resolved or explicitly moved out of scope.

## Implementation notes

## Human review

- [ ] Every task is complete and story-level verification passes.
- [ ] Set the story status to `awaiting-human-review` and present the outcome, architecture
  decisions, task-level subagent findings and dispositions, exact verification results, deviations,
  and remaining risks.
- [ ] Record the human's explicit approval or requested changes here.
- [ ] If changes are requested, return to the affected task and repeat its review and verification.
- [ ] Only after explicit approval, mark the story `done` and update `Stories at a glance`.
