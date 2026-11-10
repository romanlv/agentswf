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

%% Not yet applied to the text below (owner, 2026-11-10):
1. The review lab was an experiment. It should be refactored to use this approach, not kept
   beside it. Everything below that says "beside `review/`" or "reviews untouched" is out of date.
2. Graders can be code, or another workflow. `expect` and the criteria judge are then the two
   built-in graders, and a dataset (reviews, with their scorer) can bring its own.

What a read of `packages/lab/src/review` found reviews need from this design (2026-11-10):
- A trial's setup fits: a `setup.ts` can restore the frozen code as `fixtures/git.ts` does, with
  `input.json` holding base and head, and `files/` holding `request.md` and the bundle.
- Grading does not fit as written. Reviews label every returned finding (hit, new, wrong, noise,
  duplicate), which gives precision and the wrong share; this design has one verdict per key
  criterion and scalar fields from `read`. A dataset's own grader (point 2) is what covers it.
- A grader must be able to return numbers, not only pass or fail: a review trial never "passes",
  it has weighted recall and precision. The report needs rows for a dataset's numbers.
- A review grader reads the frozen code, and `score` runs it after the scratch folder is gone. So
  a grader needs the setup run again for it, or the trial lifecycle changes.
- The review judge's procedure (match by code, two voters, a tiebreak) differs from "three voters,
  all agree". That belongs to the grader, not to the lab.
- The key is more than one file there (`key/evidence/`, `fixes.bundle`). Either those leave the
  dataset or "copy everything but `key.md`" becomes a hidden folder.
- The `"lab"` sandbox must let agents reach their model; `sandbox` may need to name a provider
  (reviews used a container).
- Generic and worth carrying over: plan, estimate and asking before spending (`execute.ts`
  `planRun`), waiting for a subscription window (`allowance.ts`), `runner.ts`, and `src/compare`
  if the verdict stays. About 3,000 lines go (reuse by version, `loop/`, sealing, `check`,
  `where`, `show`); `build/` (collect, draft-key) is how review cases get made and is not
  `capture`. %%

This story holds the current design. [[workflow-cases]] is the earlier thinking behind it; where
the two differ, this story is right. Every command, file and number below is a sketch to react to.

To decide whether this is what you want, read Outcome, How it works and Scope. The rest is for
whoever builds it.

## Outcome

Today, when a workflow gets something wrong, you fix the prompt, run it again on whatever is at
hand, and hope. Nothing remembers the email it misjudged last week, and nothing tells you whether
your change made things better, or whether a cheaper model would have done as well.

After this story there is a way to give a workflow a made-up input in place of the real one, check
what it returns, and do that for many inputs at once. Three parts, as in any eval:

- **The variant**: a small piece of your own code that feeds a case to the workflow in place of
  the real inbox or the real request, and picks what stays real, such as the model.
- **The cases**: an input and a *key*, which says what a good result looks like, one folder
  each. A workflow's cases together are its *dataset*.
- **The grading**: exact checks done by code, and written criteria judged by an agent. Whether an
  agent judges well enough is tested first (task 1); if it doesn't, only the exact checks ship. A case
  can run several times (`--trials`), since agents don't answer the same way twice.

**The basic thing: run the workflow as it is now, and check it.** Like a test run, on the code in
your checkout:

```sh
awf-lab case new mail/trip-form        # make a case folder, then fill it in
awf-lab run --trials 3                 # the workflow as it is here, on every case, three times
```

```text
mail · 12 cases · 3 trials each · variant haiku · branch shorter-prompt (a1b2c3d, uncommitted changes)
sandbox: the workflow's own

passed all 3 trials          9 cases
passed some                  2 cases
passed none                  1 case
trials that errored          0 of 36
time per trial, median       8s
cost per trial, median       $0.004
judge, all trials            $0.80
criteria left unsettled      0 of 90   (30 criteria × 3 trials)

not passing
  no-school-friday    short    1/3    expected false, got true twice
  trip-form           k2       2/3    unmet once. Judge: "no mention of the lunch"
  grade-3-only        k3       0/3    violated. Judge: "lists the grade 3 trip as an action"
```

That is the whole of it for most days: what the workflow does now, case by case, against what you
said good looks like. This dataset is the only one here and has one variant, so `run` names
neither. Without `--trials`, a case runs once.

**How a trial passes.** `short` is a field your variant reads from the result, checked exactly. `k2` and `k3`
are criteria from the case's key: a `must` is a sentence that should be true of the result, a
`must-not` one that should never be. A trial passes when every exact check matches, every `must`
is judged met and every `must-not` is judged not violated. Three agents vote on each criterion;
one they split on is unsettled and counts as not passed. A trial that errored (the site was down,
the run timed out) counts as not passed, and is shown apart from a wrong answer.

**Reading the report.** The cost per trial is the workflow's own; the judge's is the line under
it. "sandbox" says what fenced the agents in: here the workflow's own sandboxes, which a dataset
chooses (below). `awf-lab report --case trip-form` prints one case in full, with the folder of
each trial's workflow run, so `awf logs` opens what the agents did.

A case can also come from a run that already happened:
`awf-lab capture {run id} --needs-work "{note}"` copies its input into a new case for you to
write the key of. It is the last task here; until it is built, you copy the input by hand.

**Comparing is one run set beside another.** Every `awf-lab run` is kept under a label, which is
the branch's name unless `--label` gives another, with the commit it ran on. To see what your
change did, set this run beside the newest one labelled `main`:

```sh
awf-lab report --beside main
```

```text
mail · 12 cases · 3 trials each          main (9f8e7d6)     shorter-prompt (a1b2c3d, uncommitted changes)
variant                                  haiku              haiku
sandbox                                  workflow's own     workflow's own
passed all 3 trials                      6 cases            9 cases
passed some                              4 cases            2 cases
passed none                              2 cases            1 case
trials that errored                      1 of 36            0 of 36
time per trial, median                   9s                 8s
cost per trial, median                   $0.004             $0.004
judge, all trials                        $0.80              $0.80

changed by 2 trials or more              main               shorter-prompt
  trip-form           k2                 0/3                2/3
  grade-3-only        k3                 3/3                0/3

12 cases can't settle which is better. Read the cases.
```

**Your first run on `main`.** The run on `main` is one you made there: before you started the
change, or in another checkout of `main`. The first time, `main` has no `evals/` folder yet.
Either commit `evals/` to `main` and run there, or run `awf-lab run --label main` on your branch
before editing anything. (A committed key is within reach of agents that work inside the
repository; "How the key stays out of reach" below says what that means for you.) Runs of one
project are kept in one place, whichever checkout made them.

**What counts as the same case.** Only cases whose input is the same in both runs are compared,
and the input includes the files a dataset's cases share: edit those and no case compares until
both sides have run again. Every run costs its full price again; nothing is reused from an
earlier one. If you edit a key between two runs, `report --beside` asks you to run
`awf-lab score` first: it grades the kept trials again, and pays the judge again, without running
the workflow.

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
  `awf-lab run`. The lab does not read the files your own launcher reads.
- Anything you forget to fake stays real. The lab does not stop it.
- Criteria are judged by three agent votes per criterion per trial, on your credentials. That is
  billed apart from the trial, and the report shows its total. On a cheap workflow, judging can
  cost more than the trials.
- The project's own `agentswf` runs the trials. If it is too far from the lab's to be read, `run`
  stops and says so.
- Trials run one at a time.
- A key you commit can be read by an agent that works inside your repository, as the mail
  triage's do until task 2 moves them out. The lab notices a key copied word for word, not one
  put in other words.
- Nothing here is stable yet. Kept runs and your variant files may need redoing after you update
  the lab.
- A variant, and a dataset's optional `setup.ts` (code that prepares a trial), are your own
  trusted code. They run on your machine with your whole
  environment, credentials included.
- A trial of web-to-cli's build (below) acts on a live site. A `must-not` is graded after the act; it prevents
  nothing.
- Cases and results can hold private text, such as real email. Results are kept outside the
  repository, under `~/.awf/lab/`, with a full copy of each trial's input and result; delete a
  run's folder there to be rid of it. A cases folder with real mail belongs in a private
  repository.

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
  awf-lab.json                      marks the folder; may say where results are kept
  datasets/mail/
    dataset.json                    which sandbox a trial runs under
    setup.ts                        optional: code that prepares a trial
    files/                          what every case shares: the priorities
    variants/haiku.variant.ts       your workflow, wired to a case
    cases/trip-form/
      input.json                    optional: small facts, such as today's date
      files/                        optional: what the workflow reads, such as the email
      key.md                        what a good result looks like

  awf-lab run
     for each case, for each trial, in temporary folders outside your repository
     (this hides the key only from agents that work in those folders; see below):
       1. make the case folder: the dataset's files/, then the case's files/ over them, then
          input.json. Never key.md.
       2. make an empty scratch folder. Run setup.ts in it, if the dataset has one.
       3. awf run the variant, told where the case folder is               ─▶ a result
       4. grade the result against the key                                 ─▶ a score
  awf-lab report                    reads the stored scores; runs nothing
```

The words used below:

- **Dataset**: the cases for one workflow, with its variants and its settings.
- **Case**: an input and a key, one folder.
- **Key**: what a good result looks like. It is never copied to where the workflow works.
- **Variant**: a file that runs your workflow on one case.
- **Setup**: `setup.ts`, code that prepares a trial before the workflow starts. Nothing else is
  called setup.
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
- **The key in a file of its own.** The lab copies every file except `key.md`. Skipping one
  named file is simple and easy to test. If the answer sat inside another file, the lab would have to cut it out, and a mistake
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

**The key has two parts.** `expect` lists fields and the values they must have; code checks it, so
it is free and exact. `criteria` are sentences an agent judges: a `must` should be true of a good
result, a `must-not` should never be. The text under the frontmatter is your own note on why the
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
its own (a default it fills in, a call it makes directly) stays real. Only `"sandbox": "lab"`,
below, has the lab cut the network off, and neither workflow here can use it. To use the real thing, pass
the real thing.

**Writing good cases.** Mix in cases where the right answer is "no" (not relevant, declined), or
a workflow that always says yes passes. Before trusting a new key, run its case once and read
why each criterion got its verdict. A case that fails in every column is usually a wrong key, or
a site that changed.

**A dataset says which sandbox its trials run under**, in `dataset.json`:

- `"sandbox": "workflow"` trusts the sandboxes the workflow opens itself. The mail triage puts
  each reader in one that reaches nothing but its model, so this is its setting.
- `"sandbox": "lab"` puts every agent of the trial in one sandbox the lab controls: it reads the
  case folder, writes the scratch folder and reaches no network. A trial whose workflow opens
  its own sandbox errors.

The setting is required; there is no default to grow used to. The report says which one a run
used.

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
  await $`rm -rf ${scratch}/evals`; // configure copies the whole checkout, keys included
  await Bun.write(`${scratch}/workflows.json`, JSON.stringify({ sandbox: true, agents: options.agents ?? {} }));
  await $`git branch -M main && git add -A && git commit -qm base`.cwd(scratch);

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
      const out = await cli`bin/hn ${done.op} --json`.nothrow().json().catch(() => null);
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
                                         build              haiku-builder
passed                                   2 cases            1 case
trials that errored                      0 of 2             0 of 2
time per trial, median                   29m                41m
cost per trial, median                   $4.80              $2.10
judge, all trials                        $0.30              $0.30
criteria left unsettled                  0 of 4             0 of 4

time by stage, median                    build              haiku-builder
  explore                                9m                 12m
  write                                  7m                 9m
  check                                  9m                 16m

not passing
  haiku-builder  search   0/1   expect state, runs, stories: got deferred ("no way to do it")

One trial each: these are examples, not rates.
```

Time by stage comes from the record of the workflow's run; the workflow adds nothing for it. Time
and cost per trial are the workflow's run alone. Setup time and what the judge cost are recorded
apart, and the report gives the judge's total in one line.

**How the key stays out of reach, and how far.** The case folder and the scratch folder are made
outside your repository, and `key.md` is never copied into either. That is enough for a workflow
whose agents work in the scratch folder. It is not enough for one whose agents work inside your
repository: a sandbox lets an agent read the git history of the repository it works in, and a
committed key is in that history. The mail triage is the second kind today: its readers work in
a folder inside the project. Task 2 moves that folder out of the repository, which is right for
the workflow anyway, since its readers handle mail from strangers. (An `evals/` folder you never
commit has no history to read, and comparing still works, since runs are kept outside the
repository.) Because a key can be within reach, every key carries a marker, and the lab looks for it in the
case folder and the scratch folder before the workflow runs, and in the result, the saved files
and what the agents wrote (`awf logs`) after. A trial where it turns up is marked leaked and not
counted as passed; one found before the workflow runs ends the trial there. The marker is a
tripwire, not a wall: it catches a key that was copied, not one that was read and put in other
words, and not one written where `awf logs` hides what looks like a credential.

**Does it tell me which one is better?** No. It shows each case, over a few trials, and you read
it. A handful of cases can't carry a "better" you could trust, and the report says so.

## Scope

In scope:

- Cases written by hand: `input.json`, `files/`, `key.md` with `expect` and `criteria`; files a
  dataset's cases share. `case new`, which makes the folder and the key's marker.
- `defineVariant`, `trialCase` and `defineSetup`, from `@agentswf/lab/cases`; `dataset.json`.
- Trials of the whole workflow, repeated, each given a case folder without the key.
- Grading: `expect` by code, against what `read` and the setup's `check` return; `criteria` by a
  judge.
- `run`, which keeps every run under a label; `report`, for one run, one case, or one run beside
  another; `runs`, which lists them; `score`, which grades a kept run again.
- A past run of the workflow turned into a case, marked as good or as needing work (`capture`).
- Both workflows working end to end, with their datasets in their own repositories.

Out of scope:

- Any change to `engine` or `contract`.
- Any change to how reviews are evaluated. The new kind is built beside `review/`; moving reviews
  onto it comes after both workflows run on it.
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

- Fact: of the lab's 13,000 lines, about 700 (`src/compare`) know nothing of reviews. The rest is
  under `src/review`, the command line included: a trial is stored as `findings.json`, a score is
  a label per finding, a variant's `read` returns review findings, and `awf-lab.json` requires a
  git clone and holds one sandbox setting for every dataset.
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
- Fact: the lab's runner gives every run the lab's whole environment; it has no way to add to it
  for one run (`runner.ts`).
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
  `workspace.ts`; `src/review/format/variant.ts`, `records.ts`; `src/review/judge/`;
  `src/compare/`.
- Relevance: everything a trial does lives under `review/`. The new kind is built beside it, in a
  folder of its own, and `review/` keeps working as it is. The two share what is already general:
  starting `awf run` and reading its result (`runner.ts`, once its one review type moves out),
  and `compare/`. What they share moves to a neutral folder, so the new kind never imports from
  `review/`.

### `packages/engine`, `packages/contract`

- Checked, no change planned. The lab reads a workflow's run through `awf run --json`,
  `awf logs --json` and `contract`'s `readRun`.

### `scripts/check-boundaries.ts`

- Gains the rules that keep the new folder apart from `review/`.

### The two workflows, in their own repositories

- The mail triage: takes `today` as an argument; its readers' working folder moves out of the
  repository. Its `evals/` folder is new.
- web-to-cli: no change to `core/`. Its `evals/` folder is new.

## Proposed design

Your code runs in two places. `setup.ts`, its `check`, and a variant's `read` run inside the lab.
The variant's workflow runs inside `awf run`, and `trialCase()` works only there.

- **`defineSetup`** (in `setup.ts`, optional) gets the checkout being tried (`root`), an empty
  scratch folder, the case's input and the variant's `options` (an empty object when the variant
  gives none). It returns `cwd`, `env` and
  `argv` for the workflow's run, and optionally `check`, a function the lab calls after that run
  and before the scratch folder is deleted. Without a `setup.ts`, the workflow runs in the
  scratch folder with the variant's `argv`.
- **`defineVariant`** wraps the workflow, as `defineReviewVariant` does: `argv`, `timeout`,
  `read`, and `options`, plain data handed to `setup.ts`. When both give an `argv`, the setup's
  comes after the variant's.
- **`trialCase()`** returns the case folder and the input (an empty object when the case has no
  `input.json`). The lab sets `AWF_LAB_CASE` for the workflow's run; without it the call throws
  and says to call it inside a function. Nothing else reads the variable.
- **`dataset.json`** holds what is plain data: `sandbox`, required, and `keep`, the paths saved
  from the scratch folder.
- **The project's own `awf` runs the trial** (`node_modules/.bin/awf` under `root`), not the
  lab's, so the engine is the one the workflow was written for. The lab puts that folder first
  on `PATH` for the workflow's run. If that `awf` writes a record the lab can't read, `run` stops
  before the first trial and names both versions.
- **The folders** are made under the system's temporary folder and deleted when the trial ends.
  Ones a crash left behind are removed at the start of the next `run`.

**Grading.**

- A trial is **errored** when the setup fails, the workflow's run does not complete, `read` or
  `check` throws, or `read` returns a non-empty `error`. An errored trial is counted and shown in
  a row of its own. In a case's row it counts as not passed. A run that finishes with the wrong
  answer, like the build's "deferred", is a fail, not an error.
- A **leaked** trial, one where the key's marker turned up, is shown in a row of its own,
  "trials where the key leaked". It counts as not passed in its case's row and, like an errored
  trial, is left out of "changed by 2 trials or more". The row appears only when a trial leaked;
  the errored and unsettled rows always appear.
- **`expect`** is checked by code against `read`'s fields joined with `check`'s: every named
  field must equal the key's value. Values are strings, numbers and booleans only. A field that
  both `read` and `check` return makes the trial errored.
- **The criteria judge** is the lab's judge with a new question, asked once per criterion. It is
  given the case's input, the workflow's whole result, the saved files, and the criterion's text.
  It is never given the marker or what the agents wrote. Saved files are data to it, never
  instructions. Three voters each give a verdict: `met` or `unmet` for a `must`, `violated` or
  `not violated` for a `must-not`. Unless all three agree the criterion is `unsettled`. An `unsettled` criterion never counts as passing, and is counted
  apart.
- In a dataset with `keep`, every criterion is judged from the saved files, and the report marks
  it "read, not run".
- A case with neither `expect` nor `criteria` runs, and the report lists it as "no key", with its
  time and cost only, and leaves it out of every passed count.

**What is kept.** Each `awf-lab run` is one stored run, under a label that is the branch's name
unless `--label` gives another. `report` shows the newest run of the current branch's label;
`--beside {label}` adds the newest run under that label; `awf-lab runs` lists what is kept. A
run that was interrupted keeps the trials that finished and is marked partial. Nothing is reused from one run to the
next. Results live outside the repository, in one folder per project
(`~/.awf/lab/{project}/`, unless `awf-lab.json` says elsewhere), so every checkout of a project
shares them and none commits them. `{project}` is the name of the folder that holds the
repository's own `.git`, which every worktree of it shares. The records of the workflows' runs are
kept there too, so `awf logs` still opens one after its trial's folders are gone.

- A **run** records: `kind: awf.case-run/0`, its label, the dataset, the variants, cases and
  trials asked for, when it started and when it finished. A run with no finish is partial.
- A **trial** records: `kind: awf.case-trial/0`, the label and run, the dataset, the case and a
  digest of its case folder as built (the shared files included) and its input, the variant, the
  commit and whether there were uncommitted changes, the sandbox setting, the models used, the `awf`
  version, when it ran, the id and outcome of the workflow's run, its time and cost, the setup's
  time, the workflow's
  whole result, what `read` and `check` returned, the saved files, and whether the marker was
  found.
- A **score** records: `kind: awf.case-score/0`, the trial, a digest of the key, each `expect`
  field's outcome, each criterion's verdict and reason, the judge's model, a digest of its
  prompt, and what it cost.
- `/0` means the format may change without a way to read old files. It becomes `/1` after both
  workflows have run on it.

**What a report may set side by side.** Two runs are compared only on cases with the same input.
If their keys or their judge differ, the report asks you to run `score` first. A column says its
label, commit and variant. A column older than 30 days, or on other models than the one beside
it, says so. "Changed by 2 trials or more" counts passes and fails only; errored trials are in
their own row, so a site that was down does not read as a change. With one trial each there is
no such list.

**The marker search** reads the case folder and the scratch folder before the workflow runs, and
after it the result, the saved files, and everything `awf logs` has for the workflow's run, read
to the end. The marker is a few plain words, a shape `awf logs` does not take for a credential and
hide.

Settled:

- **Keys live beside their cases**, and the marker says when one leaked.
  [[0003-autoresearch-tools-here-project-data-there|ADR 0003]] is amended for this kind of case
  before task 2's code.
- **Grade the result, not the path.** A key is about what the workflow produced. Which stages ran
  and how long they took are shown, never graded.
- **A run on current code is the main thing.** Comparing is a second report over kept runs.

What must hold:

- The lab never copies `key.md` into a case folder or a scratch folder, and no stored trial
  holds it. A marker found in either before the workflow runs ends the trial as leaked, without
  running the workflow.
- A trial that errors is counted against its variant and shown.
- A trial where the marker turns up is marked leaked and not counted as passed.
- A captured case is never graded against the run it came from. Only the lab's own trials are
  compared.
- A changed key is graded again by `score`, without running the workflow.
- Nothing under `review/` is imported by the new kind, and nothing in the new kind names a
  workflow.

How "done properly" is checked:

1. `scripts/check-boundaries.ts`: the new folder never imports `review/`, and the shared folder
   imports neither.
2. The same script: no word of a domain (`mail`, `review`, `finding`) in the new folder's code
   or its record names.
3. Every file the new kind writes has a schema with a versioned `kind`, checked before writing.
4. A test: a trial whose scratch folder holds a key's marker is caught.
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

### 1. By hand

None. The bar is in the task.

### 2. The mail triage runs on cases

- Do `run`, `score` and `report` stay one set of commands that look at the dataset's `kind` to
  see which code handles it, or does the new kind get commands of its own until reviews move
  over? Proposed: one set.
- `awf-lab.json` requires a git clone, which the mail dataset has none of. Does the field become
  optional, or move into the review kind's own settings?
- The frontmatter of `key.md` is YAML, which guesses types (`no` becomes false), and `expect` is
  compared exactly. Is a strict reading enough (only quoted strings, numbers, `true` and
  `false`), or does `expect` move to a JSON file?

### 3. Criteria are judged

- Which model judges, and where is it chosen: per dataset, or once for the workspace as the
  review lab's voters are?

### 4. One run set beside another

- Is 30 days the right age for the warning?

### 5. web-to-cli's build

- A trial's setup runs the project's own commands. Is that acceptable, or should a case carry a
  prepared checkout?
- The build's own notes say its run carries the request's id, and the lab gives the workflow's
  run an id of its own. Does anything in the build mind?

### 6. A past run becomes a case

- Where does a dataset say how a run becomes a case? `setup.ts` is the natural place, as a
  second function beside the one that prepares a trial.
- For the mail triage, the run kept only the prompt, so the email has to be fetched again from
  the inbox. Is a case built from the recorded prompt acceptable when the email is gone?

## Task execution rule

Process one task at a time. Every task repeats the checklist shown under its details. Do not begin
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
  judge prompt run by hand.
- [ ] Review: one subagent checks the counting. There is no diff for a second to read.
- [ ] Resolve: record the numbers and the decision here.
- [ ] Verify: the `Done when` items.

Work:

- About ten emails with about thirty criteria, some of them ones the workflow got wrong. At
  least three where the right answer is "not relevant" or "short", so "always relevant" does not
  pass.
- Each email run three times: about 90 verdicts to give (thirty criteria, three runs each).
  Three runs of one email are alike, so this is nearer thirty independent ones than ninety.
- Outputs that should fail, taken from real misses or made by breaking a good summary by hand,
  so a judge that always says `met` is caught: at least fifteen where a `must` is unmet, and at
  least ten where a `must-not` is violated.
- The person gives every verdict before seeing the judge's. Then the judge does, as it will be
  built: three voters, and `unsettled` unless all three agree.

The bar, with `unsettled` counted as disagreeing with the person:

- The judge calls a violated `must-not` not violated at most once.
- The judge finds at least 80% of what the person called `unmet`.
- The judge and the person agree on at least 85% of verdicts overall.
- At most 10% of verdicts are `unsettled`.

Below the bar, criteria leave this story: keys hold `expect` alone, and task 3 builds only the
key's digest and `score`. Task 3 is then done when editing an `expect` value and running `score`
changes the report without a new trial, and task 5 drops "read, not run".

Done when:

- The numbers and the decision are in Implementation notes.

### 2. The mail triage runs on cases, graded by `expect`

Outcome: `awf-lab run` and `report` work for the mail dataset, with two variants. It does not
wait for task 1.

Execution:

- [ ] Plan: amend ADR 0003 and rewrite [[second-case-kind]] as "move reviews onto the case kind",
  first. Then inspect the lab's run, store and load code; settle the new kind's folder, which
  shared files move to a neutral one, the trial and score records, and the commands.
- [ ] Implement: only this task's change, with tests.
- [ ] Review: architecture and scope; correctness and proof.
- [ ] Resolve: disposition every finding.
- [ ] Verify: the `Done when` items.

Work:

- `@agentswf/lab/cases`: `defineVariant`, `trialCase`; `dataset.json`; the case and key formats
  and their checker; `case new`.
- The case folder and the scratch folder, outside the repository; the marker and the search for
  it.
- The runner passes a run its environment, and starts the project's own `awf`.
- A stored run under a label; the trial and score records; the `expect` score; errored trials.
- `run` (with `--dataset`, `--cases`, `--trials`, `--label`; one trial unless told) and `report`,
  for a run (a column per variant) and for one case (`--case`).
- The five checks under How "done properly" is checked.
- In the mail project: `today` becomes an argument; the readers' working folder moves out of the
  repository; the `evals/` folder.

Done when:

- A test runs a small dataset end to end on scripted agents and gets the expected report.
- A test shows the lab copies `key.md` into neither folder, and that a trial whose scratch folder
  holds the marker ends as leaked without running the workflow.
- A test shows a variant that calls `trialCase()` while its file loads is refused with a message
  that says what to do.
- A test shows an errored trial is counted and shown.
- A test shows a `"lab"` dataset's trial errors when the workflow opens its own sandbox, and a
  `"workflow"` dataset runs it.
- Live: `awf-lab run haiku sonnet --trials 3` on the mail dataset. The operator's environment
  carries the model's login (`CLAUDE_CODE_OAUTH_TOKEN`), which the project's own launcher reads
  from a file the lab does not load.

### 3. Criteria are judged, and a changed key is graded again

Outcome: `criteria` appear in the report; `score` runs the judge alone on a kept run.

Execution:

- [ ] Plan: reuse of the lab's voters; the judge's prompt, from task 1.
- [ ] Implement: only this task's change, with tests.
- [ ] Review: architecture and scope; correctness and proof.
- [ ] Resolve: disposition every finding.
- [ ] Verify: the `Done when` items.

Work:

- The criteria judge, its three voters and what it is given; `unsettled`; the key's digest on a
  score; `score`.

Done when:

- Editing a criterion and running `score` changes the report without a new trial.
- A test shows the judge is given neither the marker nor what the agents wrote.
- Live: on task 1's outputs, the built judge agrees with the person's verdicts on at least 85%.

### 4. One run set beside another

Outcome: `awf-lab report --beside {label}` shows two kept runs in two columns.

Execution:

- [ ] Plan: how a label finds a run; what makes two columns comparable.
- [ ] Implement: only this task's change, with tests.
- [ ] Review: architecture and scope; correctness and proof.
- [ ] Resolve: disposition every finding.
- [ ] Verify: the `Done when` items.

Work:

- A second run as a column (`--beside`); `runs`; the rules for what may be set side by side, and
  the notes when a column is old or on other models; "changed by 2 trials or more".

Done when:

- A test sets two stored runs side by side and compares only the cases whose input is the same.
- A test shows two runs scored against different keys are refused, with `score` named.
- Live: the mail dataset on `main` and on a branch with a changed prompt.

### 5. web-to-cli's build runs on cases

Outcome: the builds report above, from real trials. It is the second real use of the formats
before they become `/1`.

Execution:

- [ ] Plan: what `setup.ts` returns; how `keep` reaches the judge.
- [ ] Implement: only this task's change, with tests.
- [ ] Review: architecture and scope; correctness and proof.
- [ ] Resolve: disposition every finding.
- [ ] Verify: the `Done when` items.

Work:

- `defineSetup` with `check`; a variant's `options`; `keep`; time by stage in the report;
  "read, not run" beside criteria judged from saved files.

Done when:

- A test on scripted agents: a setup's `cwd`, `env` and `argv` start the workflow's run,
  `check`'s fields are graded by `expect`, and `keep`'s files are saved.
- A test shows a setup that copies a key into the scratch folder is caught before the workflow
  runs.
- Live: two cases, two variants, one trial each. About two hours and twenty dollars.

### 6. A past run becomes a case

Outcome: `awf-lab capture {run id} --good` or `--needs-work "{note}"` makes a case from a past
run of the workflow, whether a trial's or a real one.

Execution:

- [ ] Plan: where a dataset says how a run becomes a case, and what it is handed.
- [ ] Implement: only this task's change, with tests.
- [ ] Review: architecture and scope; correctness and proof.
- [ ] Resolve: disposition every finding.
- [ ] Verify: the `Done when` items.

Work:

- `capture`: the case's input from the run, through the dataset's own code; the mark and the note
  written into `key.md`, with a marker as `case new` writes; for a good run, `expect` filled in from what `read` returns, for the
  person to check. A run that needed work is never the answer: its case is a draft, listed as
  "no key", until the person writes one.

Done when:

- A run of each workflow becomes a case with one command, and that case runs.

Tasks are checkpoints, not a file-by-file edit script. The implementation agent may adjust the
implementation without changing their outcomes, order, or the story's scope.

## Verification

Automated:

- [ ] A dataset runs end to end on scripted agents: trials, scores, report.
- [ ] The lab copies `key.md` into neither folder, and a leaked marker is caught.
- [ ] The review lab's existing tests pass unchanged.
- [ ] `bun test`
- [ ] `bunx tsc --noEmit`
- [ ] `bun run scripts/check-boundaries.ts`

Manual or live evaluation:

- [ ] The mail dataset, two variants, three trials each: minutes, a few dollars with the judge.
- [ ] The builds dataset, two variants: about two hours and twenty dollars.

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
