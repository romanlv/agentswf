---
id: "044"
title: "Run a workflow on cases you wrote, with its services faked, and get a score"
summary: "A person writes cases (an input and what a good result looks like); awf-lab runs the workflow, with outside services swapped for the case, and says case by case what passed. A case that must pass and fails is a regression, and the command exits non-zero. The same cases can run on code in another folder, such as a worktree of main, or with parameters set on the command line, side by side. Reviews and the improvement loop move onto it, so an agent can change a workflow, compare, keep what is better and check it on a holdout, for any workflow."
type: story
status: in-progress
epic: loop
discovered_in: "a conversation about evals built from runs, 2026-11-09"
depends_on: ["008", "010", "011", "013"]
---

# Run a workflow on cases you wrote, with its services faked, and get a score

**How to read this.** Outcome and How it works say what is planned and how you would use it;
read those two to decide whether it is right. Proposed design holds the exact rules for whoever
builds it. Commands and reports are sketches to react to; the file formats and the rules are the
design. [[workflow-cases]] is the earlier thinking; where the two differ, this story wins.

## Outcome

Today, when a workflow gets something wrong, you fix the prompt, run it again on whatever is at
hand, and hope. Nothing remembers the email it misjudged last week, and nothing tells you that
your fix broke an email it used to get right.

The story has three angles. The first is most of the work; the second is small once the first
exists; the third, added later, moves the review lab and its loop onto the first two.

**1. Run and score: the regression loop.**

- You write **cases**: an input (an email, a request) and a **key** that says what a good result
  looks like. Often a case starts as a run that went wrong.
- A small file of your own per dataset, the **environment** (`env.ts`), sets up each case's world
  the way a unit test's setup does: `bun:test` mocks in place of the inbox, `fetch` routes in
  place of a site, the clock set to the case's day. Then it says what to read off once the run is over.
  The workflow runs as it ships; its settings, such as the model, are its code, or parameters
  `env.ts` reads (`--param`, `--vary`, task 9).
- `awf-lab run` runs the workflow, as it is in your checkout, on every case, as many times as you
  ask, each trial in a throwaway folder, and grades each result against the key.
- Each case says whether it **must pass** (the default) or is **known failing** (a problem you
  have written down but not fixed). The report lists what failed and why, and `run` exits
  non-zero when a case that must pass failed.
- The loop: add a case for what went wrong; it fails; fix the workflow; run that case until it
  passes reliably; run them all to see nothing else broke. Unchanged code reuses its trials
  (Q11); `--fresh` asks for new samples of the same code.

**2. Compare: the same cases on other code.**

- `awf-lab run --against ../worktrees/app-main` runs the same cases, in the same run, on the code
  in another folder: a worktree of `main`, another branch, an experiment. The change can be
  anything (a prompt, a tool, a stage), since each side is a whole folder of code.
- The report puts the two side by side and lists the cases that came out differently. It does not
  say which side is better, unless the dataset says how to compare in code (Q14), which the loop
  uses too.

Also here: `awf-lab capture {run id}` turns a past run into a new case.

It is built and tried on two workflows that pull in opposite directions, and the story ends with
working evals in each one's own repository:
- **A mail triage**, `school-mail` in `romanlv/mini-workflows` (`~/dev/mini-workflows`). A
  scheduled workflow reads new mail; one agent per email decides whether it
  matters and summarizes it. A trial takes seconds, costs cents, and touches nothing real.
- **web-to-cli's build** ([`core/workflows/build.ts`](https://github.com/romanlv/web-to-cli),
  `~/dev/web-cli/web-to-cli`).
  From one sentence, agents explore a live site, write a command for it, check it and merge it. A
  trial takes half an hour, costs dollars, writes code and needs the real site.

Then the review workflows, with the autoresearch repository running on this design alone (tasks
11 to 13).

**3. Iterate: reviews and the loop move over** (tasks 7 to 13, added 2026-11-16). The point of
running, comparing and grading is a framework where an agent iterates on a workflow and finds a
better one quickly: it changes the workflow or a setting, runs the cases, compares, keeps what is
better, and checks it on cases it never tuned on. The review lab already does this for one kind of
workflow, with its own runner, store, commands and loop. Those move onto this design, for any
workflow, on the same branch as the rest of this story, so what the design gets wrong shows while
it can still change. The old review lab is then retired.

Scope lists what is left out.

## How it works

### The parts

| Part | What it is | Who writes it |
| --- | --- | --- |
| **Case** | One folder: the input (files, small facts) and the key | you, by hand or with `capture` |
| **Environment** | `env.ts`: a code file that sets up one case's world (mocks, `fetch` routes, a prepared folder, stages given), runs the workflow as it ships, and returns the facts to grade | you |
| **Grader** | Turns a trial's result and the key into passed, failed or undecided. Two are built in: exact checks done by code (`expect`) and written criteria judged by agents (`criteria`). A dataset can add its own | built in, or you |

A workflow's cases, environment and settings together are its **dataset**. One run of the
workflow on one case is a **trial**. One `awf-lab run`, with all its trials, is a **run**. Each
folder of code, your checkout and with angle 2 each other folder, and each combination of
parameters (task 9), is a **column** of the report.

```text
evals/                              in your project, beside your workflows
  awf-lab.json                      marks the folder; names the judge's model
  mail/                             a dataset: a folder holding dataset.json
    dataset.json                    the sandbox setting, agents' reach, other settings
    files/                          what every case shares, such as the priorities
    env.ts                          each case's world, and what to read off after the run
    graders.ts                      optional: the dataset's own graders, and compare
    graders/                        optional: grader workflows
    capture.ts                      optional: turns a past run into a case
    cases/trip-form/
      input.json                    optional: small facts, such as today's date
      files/                        optional: what the environment reads, such as the email
      key.md                        what a good result looks like
      key/                          optional: files a grader needs
```

A dataset is a folder directly in `evals/` that holds a `dataset.json`, so the mail cases are
`evals/mail/` and the dataset's name is `mail`; there is no `datasets/` level to remember.

### The environment: a case's world, set up in code

A case runs the workflow as it ships, in a world the case makes up: an inbox holding one email, a
clock reading a Tuesday, a site that answers with two pages. That world is written once per
dataset, in `env.ts`, the way a unit test's setup is written, and with the same tools: `bun:test`'s
mocks as an agent or a person already writes them in tests, and the web's own `Request` and
`Response` for a site. The lab adds no package for your project to install, and adds only what a test
runner would otherwise do: it reads the case, stands in for `fetch`, and starts each trial in a
fresh process.

```ts
// evals/mail/env.ts
import { defineEnv } from "@agentswf/lab/cases";
import * as clock from "../../school-mail/clock";
import * as mail from "../../school-mail/mail";
import * as notes from "../../school-mail/notes";

export default defineEnv({
  workflow: () => import("../../school-mail/workflow"),

  setup(c) {
    const file = c.json<Omit<mail.Email, "date"> & { date: string }>("email.json");
    const email: mail.Email = { ...file, date: new Date(file.date) };

    // The workflow asks a factory for its mailbox, so the mailbox is a fake and the factory a mock.
    const inbox = c.fake<mail.Mailbox>({
      inbox: "school@agentmail.to",
      listNew: async () => [{ id: email.id, from: email.from, subject: email.subject }],
      read: async () => email,
      reply: async () => {},                 // recorded: the summary the parent would get
      markDone: async () => {},
    });                                      // any other member of Mailbox: refused, the trial errors
    c.mock(mail, { agentmailMailbox: async () => inbox });

    const week = c.fake<notes.Notes>({ recent: async () => c.text("notes.md"), add: async () => {} });
    c.mock(notes, { notesIn: () => week });

    const input: { today: string } = c.input;
    c.mock(clock, { today: () => new Date(input.today) });

    return {
      observe: (result) => {
        const item = result.items[0];
        const reply = inbox.reply.mock.calls[0]?.[1];
        const noted = week.add.mock.calls[0]?.[1];
        return {
          relevant: item?.relevant ?? null,  // null: the workflow returned no item, a fail
          short: item?.short ?? null,
          children: noted ? [...noted.children].sort().join(", ") : null,
          reply: reply?.text ?? null,        // null: no summary sent; the judge reads it too
          error: item?.error ?? "",          // non-empty: the workflow failed on this case
        };
      },
    };
  },
});
```

The full file, with the Edsby fake for a post the email links to, is the mail project's
`evals/school-mail/env.ts`.

`defineEnv` takes two things:

- **`workflow(c)`**: the workflow as it ships, imported lazily so the mocks exist before it loads.
  It may import from a copy `setup` made in `c.scratch`, for a workflow that finds its project
  from where its code is (web-to-cli's build does); a module to mock is then imported from the
  same copy, inside `setup`, typed from your checkout so `c.mock` still checks it:
  ``const mail: typeof import("../../core/mail") = await import(`${c.scratch}/core/mail.ts`)``.
  Mocking your checkout's file instead misses: the copy is another module, and the workflow
  calls its real function. So after the import, a mocked module under `c.root` whose file at the
  same path is also loaded from `c.scratch` errors the trial as the dataset's ("mocked
  core/mail.ts in your checkout; the workflow loads the copy").
- **`setup(c)`**: builds the world, a test's arrange step, and returns what the run needs:
  - **`observe(result, { stages })`**, required: called once the body returned or reached `until`, it returns the
    **facts** the key's `expect` checks, read from the workflow's result, the stages' values, and
    what the mocks recorded. It never asserts: to check that no summary went out, return
    `reply: inbox.reply.mock.calls[0]?.[1]?.text ?? null` and put `reply: null` in the key. The key is the
    assertion, so a fact that fails is reported beside the others, and editing a key never means
    editing code. A body that failed fails the trial as the workflow's; one broken by `setup`
    errors it as the dataset's, and `observe` is not called; a refused call errors it as the
    dataset's whether or not the body went on;
  - `argv`, when the workflow takes arguments;
  - `stages` and `until`, to give a stage its value or stop after one (below): `stages` maps a
    stage's name to a function returning its value, called when the stage is entered.

Settings that are data live in `dataset.json` (see "Settings files"): among them the body's
`timeout` and `setupTimeout`, `keep` (the files saved from the scratch folder for the judge),
and `realHosts`.

`c` is the case:

| Call | What it does |
| --- | --- |
| `c.json(name)`, `c.text(name)` | read the case's files, the dataset's shared ones and its own; synchronous |
| `c.input`, `c.dir` | `input.json`; the built case folder: the dataset's shared `files/` and the case's own merged at its root, the case's winning, plus `input.json` |
| `c.scratch`, `c.root` | the trial's empty working folder; the code folder |
| `c.mock(module, fakes)` | replaces a module's functions with `bun:test` mocks, strictly |
| `c.fake<T>(fakes, { name })` | a strict typed object, for a client a factory returns (`connect()`) |
| `c.http(routes)` | answers the workflow's `fetch` calls from routes; strict for a host a route names, and any other host refused unless the engine's own or in `realHosts` |
| `c.cleanup(fn)` | teardown, run after `observe` even when the run fails |
| `c.params` | the trial's parameters, from `--param` and `--vary` (Q13); `{}` without them |

`bun:test`'s `spyOn`, `mock` and `mock.module` work as they do in a test. Two things from tests
don't belong here: `expect` (see `observe`), and `setSystemTime`, which outside `bun test` freezes
`Date.now` for the whole process, the engine's deadlines and timings included. The case's day
reaches the workflow through a function of the workflow's own, `clock.today()` here, which the
case mocks. Each trial is its own `awf run` process, so nothing a mock or the lab's `fetch` changed outlives it,
and there is nothing to restore.

#### Where a workflow touches the world

| The call is made by | It runs in | Faked with |
| --- | --- | --- |
| the workflow's own code | the trial's process | `c.mock`, `c.http` |
| a tool the workflow gives its agents (`tools`) | the trial's process: the control plane calls the handler there | the same: a handler that calls `mail.markDone` gets the mock |
| a command the workflow's own code starts (`Bun.spawn`, `$`: `gh`, `git push`) | a child process | nothing directly: wrap the command in a module of the workflow's own and `c.mock` that |
| an agent's own commands: `curl`, `gh`, the project's CLI | the agent's process, in a sandbox (a trial requires one) | not in this story; its reach is checked against `agentReach`: see "What agents call themselves" |

The model is never faked: it is what a case measures. A workflow's wiring is tested with scripted
agents in its unit tests (`agentswf/testing`), at no cost; a case is the live step above that.

So the advice for a workflow that wants its cases cheap to write: **give agents a service as
tools, not as a command.** A tool's handler runs in the trial's process, where every mock reaches
it.

#### `c.mock`: faking a module

```ts
const inbox = c.mock(mail, { listNew: async () => [email], markDone: async () => {} });

inbox.markDone.mock.calls                    // [["m1"]], as any bun:test or Jest mock
inbox.listNew.mockResolvedValueOnce([])      // the usual mock methods, for a second call
```

`c.mock` takes the imported module, not a path: unlike `vi.mock`, `jest.mock` and `mock.module`,
it isn't hoisted and doesn't replace the module, it works like `spyOn` on every function export,
and the trial's process ending undoes it. `c.mock(mail, fakes)` is
`spyOn(mail, name).mockImplementation(fake)` for each fake, plus three things a case needs and
`bun:test` doesn't do:

- **Typed by the module.** `import * as mail` gives `c.mock` the functions and their types, so a
  fake of the wrong shape (sync where the function is async, a wrong parameter), or an export the
  module doesn't have, is a type error before any trial. (`spyOn` on a misspelled export silently
  does nothing; `c.mock` refuses one at run time too.)
- **Strict.** Every plain function export not listed is mocked too, and throws "no fake for
  mail.delete in this case" when called. The lab records the call on its own side, so the trial
  errors with that reason, as the dataset's, even when the workflow catches the throw and carries
  on: the case is missing a fake, so add one (and a fact, when the call must not happen, as
  `reply` above). A call the workflow reaches through the patched module never reaches the real
  service.
  Classes stay real unless faked by name (`instanceof MailError` keeps working), and a pure helper
  stays real when named: `c.mock(mail, fakes, { real: ["parseHeaders"] })`.
- **Reported when unused.** A fake the case gave that was never called is listed first on the
  case's report line, even when it passed ("mail.listNew was mocked but never called"), one sign
  of the one thing it cannot reach (below), where the real function runs. Refusing stand-ins
  aren't listed, nor is a mock whose calls `observe` read (`reply` above, meant never to be
  called).
- **Objects too.** An exported object with function members (`export const client = { reply }`)
  is part of the strict surface: its methods refuse unless faked with `c.mock(mail.client, …)` or
  named in `real`.
- **Not for builtins.** `c.mock` refuses `node:*` modules and `bun`: the engine shares the
  process and calls them too. Mock the workflow's own module that wraps them.

The type check covers a fake written in the call; a set of fakes built elsewhere, like
`fakeMail` below, is checked for shape but not for a misspelled extra key, which the runtime
refuses when `c.mock` or `c.fake` is called.

It returns the mocks, by name: plain `bun:test` mocks with `.mock.calls`, `mockResolvedValueOnce`
and the rest, so `observe` checks what the workflow *did*, not only what it returned.

A set of fakes can live beside the module and serve the workflow's own tests too:

```ts
// school-mail/mail.fake.ts
import type * as mail from "./mail";
export const fakeMail = (emails: mail.Email[]): mail.Mailbox => ({
  inbox: "test@agentmail.to",
  listNew: async () => emails.map(({ id, from, subject }) => ({ id, from, subject })),
  read: async (id) => emails.find((e) => e.id === id)!,
  reply: async () => {},
  markDone: async () => {},
});

// in env.ts, or in school-mail/workflow.test.ts with spyOn
const inbox = c.fake<mail.Mailbox>(fakeMail([email]));
c.mock(mail, { agentmailMailbox: async () => inbox });
```

A client a factory returns is not an export to mock. `c.fake<T>(fakes)` makes a strict typed
stand-in for it, refusing and reporting like `c.mock`:

```ts
const db = c.fake<store.Client>({ query: async () => rows });
c.mock(store, { connect: async () => db });
```

A default-exported function is `{ default: fn }`; a default-exported object is
`c.mock(mod.default, fakes)`. A class's methods are `c.mock(MailClient.prototype, fakes)`, which
leaves its constructor real; when the constructor connects, mock the factory instead.

How it works, and the one rule that follows. Bun patches a module's export in place (`spyOn` on
the module's namespace), and every module that imported it sees the mock: default exports,
`const` and `let` exports, re-exports through an index file, class methods, npm packages, and one
function of the module calling another. A copy of a function taken when a module loads keeps
whatever it took then. The workflow loads after `setup`, so its copies take the mocks. A module
`env.ts` itself imports loads before `setup`, and its copies stay real. So the rule is: **`env.ts`
reaches the workflow only through `workflow: () => import(…)`**, and imports its types with
`import type`; it imports a service module only to mock it. A module loaded before `setup`,
directly or through what `env.ts` imports (a `notes.ts` that took `clock.today` at load), keeps
any copy it took, and nothing reports it when other callers use the mock. Where that can happen,
`mock.module(path, factory)` in `setup` replaces the module before it loads, as in a test. A mock
reported unused is one sign of a copy, not a proof there is none. A module that does something
when it loads (a client that connects, a setting it reads and throws without) is never imported
statically by `env.ts`: `setup` calls `mock.module` for it and then `await import`s it, or leaves
it alone.

#### `c.http`: faking a service on the network

Routes keyed by method and URL, answered with the web's own `Response`:

```ts
c.http({
  "GET https://school.example/posts/:id": (req, { params }) =>
    Response.json(c.json(`posts/${params.id}.json`)),
  "POST https://school.example/forms": () => new Response(null, { status: 201 }),
});
c.http.requests                              // every request seen, method, URL and body
```

The URL is a `URLPattern` (built into Bun), so `:id` and `*` match as in a router; routed hosts
compare by hostname, so a route's port and scheme don't widen or split it. The lab replaces `globalThis.fetch` on every trial, with or without
`c.http`, before anything else in the trial's process loads (a preload, see "Running a trial"),
so a client that keeps a reference to `fetch` when it is imported keeps the lab's. It sees every
request the workflow's process sends with `fetch`:

- **A host a route names** is strict, as a module `c.mock` names is: a request no route matches
  is refused and recorded on the lab's side, so the trial errors as the dataset's (a missing
  route) even when the workflow catches it.
- **Any other host** is refused the same way ("reached api.example.com: add a route, or list it
  in realHosts"), unless it is the engine's own (`wf.decisions` calls its provider with `fetch` in
  the same process, a real model call on every trial, not an agent) or `dataset.json`'s `realHosts` lists it; those go to the real `fetch`. A real
  call nobody faked never passes quietly.
- **Every route names a literal host** (`https://school.example/…`): a relative path, or a
  hostname holding any of `* : { } ( ) ? + \`, is refused at `c.http`.
- **A `fetch` over a unix socket** (Bun's `unix` option, as web-to-cli's check that its browser is up) names no
  host: it goes to the real `fetch` and is recorded in `c.http.requests`.

The lab assumes a workflow reaches its services with `fetch`, as Bun code does. A client built on
Node's `http` (axios in its Node mode, an older SDK), or one that calls `Bun.fetch`, which goes
past a replaced `globalThis.fetch`, is not seen by `c.http`, nor refused: mock
the module that wraps it with `c.mock`, or install a tool of your own, such as msw, in the
project and start it in `setup`. `env.ts` is your code and may import any of the project's
dependencies. Use `c.http` for a client you didn't write, an SDK or a plain `fetch`, where there is
no module of your own to mock. Where there is one, `c.mock` is shorter.

#### What agents call themselves

An agent's own commands run in its process, and in a sandbox that process starts from nothing:
srt and docker build its environment from scratch and allow only named domains, so neither a
proxy setting, a fake command first on `PATH`, nor a preload reaches it, and the host's
`127.0.0.1` is out of reach. Faking those calls is out of this story (Q9). What this story does
instead is make sure an agent's reach is known:

- **Every agent of a trial runs in a sandbox**, and the sandboxes reach no more than
  `dataset.json`'s `agentReach` lists: its `network` domains (each agent's model domains, which
  its harness adds, are always allowed), `webSearch` and `sockets`. The lab checks it after each trial from
  the run's own records, the `agent-opened` and `sandbox-opened` lines and the run record's
  `sandboxes`, which name each agent's
  sandbox and each sandbox's `spec`. An agent with no sandbox, or a sandbox wider than the list,
  errors the trial as `reach` (the dataset's), naming the agent and the domain: either the
  workflow widened its reach or the list is behind, and either way the trial's result may come
  from a real service. It is a check after the fact, not a wall: the engine opened the sandbox
  as the workflow asked. A ceiling the engine enforces before an agent starts is a later story.
- A workflow whose agents reach a service through `tools` doesn't have the gap (above): give an
  agent a tool rather than a domain, and the case fakes it.
- A case for a workflow whose agents call a service directly keeps that service off its list
  (`"agentReach": { "network": [] }` for the mail triage), so the agent's call fails instead of
  reaching it, and the case tests the workflow without it.

How faking them would fit later: the world `env.ts` sets up gains agents' side, and nothing else in
a case changes. The same `c.http` routes would answer an agent's `curl` as they answer the
workflow's `fetch`, with the same refusals and the same blame. Two routes in:

- **The engine's**: a socket into the sandbox, as the `wfa` door has, with the proxy setting
  pointing at it, and the lab serving the routes from the trial's process. Plain HTTP works with
  what was tried; HTTPS needs the agent's tools to trust a certificate the lab makes, set per
  tool (`curl`, `gh`, Node and Bun each read a different setting).
- **Outside tools, today**: a service's own test account (a test inbox, a sandbox tenant) listed
  in `agentReach`, or, with docker, a mock server (WireMock, Prism from an OpenAPI file) beside
  the agent's container. They work without awf's help, but are shared across trials and
  cases, not built per case, so a case can't say what they answer; fine for a smoke test, weak
  for a key.

What was proven for later, unsandboxed: a fake HTTP service reached through `HTTPS_PROXY` (Bun,
curl, git, gh and Claude Code honor it; Node needs `NODE_USE_ENV_PROXY=1`), and a module fake in a
child Bun process through `BUN_OPTIONS="--preload=…"`, answering over a unix socket from the
trial's process, with calls recorded in order across processes.

#### One stage of a multi-stage workflow

A workflow's stages are its `wf.stage(name, options, work)` calls, and the lab hands the workflow
its `wf`. So a case can say, per stage, what happens:

```ts
// evals/specs/env.ts: the build's spec stage alone, from a past run's intake and explore
import { $ } from "bun";
import { defineEnv } from "@agentswf/lab/cases";
import { prepareCli, recordOp } from "../builds/prepare";

export default defineEnv({
  // The copy, not your checkout; typed from your checkout, since a template import is `any`.
  workflow: (c) =>
    import(`${c.scratch}/core/workflows/build.ts`) as Promise<typeof import("../../core/workflows/build")>,

  async setup(c) {
    const { intake, explore } = c.json("stages.json");    // copied from a past run's run.jsonl
    // The builds env.ts's setup, factored into a helper: configure the CLI into c.scratch (it
    // must be empty) and file the request.
    const { request } = await prepareCli(c);
    // A given intake runs none of its work, so record the op it would have put in the ledger.
    await recordOp(c, request, intake);
    // What explore wrote, committed where the build branches its worktree from (main):
    // the build works in a worktree of its own, never in uncommitted files.
    await $`cp -R ${c.dir}/site/. ${c.scratch}/site/`;
    await $`git add -A && git -c user.name=lab -c user.email=lab@localhost commit -qm explored`.cwd(c.scratch);

    return {
      argv: [request.id],                                        // the build takes a request id
      stages: { intake: () => intake, explore: () => explore },  // given: their work is not run
      until: "spec",                                             // stop once spec has returned
      observe: (_result, { stages }) => ({ specced: stages.spec !== undefined }),
    };
  },
});
```

- **Given.** A stage named in `stages` runs with work that returns the given value instead of its
  own. None of the stage's own work runs, its side effects included, so `setup` recreates what
  later code reads (a given web-to-cli `intake` records no `op` in the request's ledger; `setup`
  writes it). It is still the engine's stage: its `result` schema checks the value and the run records it,
  so a value of the wrong shape errors the trial as the dataset's. Any stage can be given, not only
  the first ones. Stages not named run live, against the mocks.
- **`until`.** Once that stage returns, the workflow stops there: the lab's `wf` ends the
  workflow's body, the run completes, and `observe` gets the stages' values (`result` is `null`).
  No engine change, and no new ending. A stage is entered at most once per attempt, so "once it
  returns" is never ambiguous.
- **Names are checked, and an early end is graded.** A name in `stages`, or `until`, that appears
  nowhere in the workflow's source (a misspelling) errors the trial as the dataset's
  (`stage-missing`) after the workflow is imported and before its body runs, a check of the
  dataset's own. A real name the run never entered is the workflow's
  doing: a live `intake` that decided there was nothing to build ends the run early. Then
  `observe` runs on the real result with the stages it reached, the key grades it, and the report
  notes "never reached spec".
- **A value names things.** A review stage's value names a branch; `setup` rebuilds it, as any
  setup would. A value that names nothing real fails the stage live, as it would on a continue.
- **From a past run.** A stage's value is in the run's `run.jsonl`; copied into the case, it makes
  one stage of a real run into a case.
- **What stays live.** Code between stages runs. A live stage's work runs whole; inside it, the
  mocks are how to fake a part.

#### Running cases in it

For each case, and each trial of it:

```text
1. the lab builds the case folder (shared files + the case's files + input.json, never the key)
   and an empty scratch folder, both outside your repository
2. it starts the code folder's own `awf`, in the code folder, as
   `bun --no-env-file --preload {fetch} {awf bin} run --json --quiet --cwd {scratch} --run-root {store} --timeout {backstop}
   evals/{dataset}/env.ts` (the backstop under "Timeouts"), told where the case folder is
3. inside that one process: setup → the workflow is imported and run → observe → `c.cleanup`'s
   teardown; as they happen, the phase, the refused calls, the mocks never called and at the end
   the facts and stages' values go to the trial file, which the lab reads whatever the ending
4. the lab checks from the run's `agent-opened` and `sandbox-opened` lines and the run record's
   `sandboxes` that every agent was
   sandboxed within `agentReach`, looks for the key's marker (scratch folder, result, saved
   files, agents' logs), saves `keep`'s files, grades the facts and the result against the key, deletes both folders.
   The marker is looked for here and before the process starts, never between `setup` and the
   workflow: a key `setup` copied in is found here, and the trial is leaked
```

- **One process.** `setup`, the workflow and `observe` share it, so a mock is a plain function
  and `observe` reads what it recorded directly. Only the run's result and the trial file leave.
- **Fresh every trial.** `setup` runs again for each trial, so nothing carries over and there is
  no reset to forget.
- **Trusted code, unsandboxed**, under `"sandbox": "workflow"`. `env.ts` is your code, as the
  workflow is. Only the agents the workflow starts are sandboxed, by the workflow's own
  sandboxes. Under `"lab"` (Q10), `env.ts`, the workflow and its agents all run in the lab's box.
- **Try one case by hand**: `awf-lab run --cases trip-form` runs it once and prints the result,
  the facts, any mock never called, and the grade.

When the world is a folder rather than functions, `setup` prepares it with plain code: web-to-cli's
build, under "A second example", copies the CLI into the scratch folder and files the request, and
its `observe` runs the command the agents built.

#### Other ways to fake, and why this one

| | Fakes as arguments | Module and in-process fakes (this) | Network fakes for agents | Record and replay | Real services, throwaway | agent-env |
| --- | --- | --- | --- | --- | --- | --- |
| Workflow changes | every service becomes a parameter | none; call services through their import | none | none | config only | services rewritten as MCP envs |
| Reaches agents | no | through `tools` | yes, unsandboxed only today | through the same proxy | yes | MCP tools only |
| New agent behaviour | fine | fine | fine | an unrecorded request misses | fine | fine |
| Per trial | free | free | free | free | slow, leftover state | needs reset hooks |

Fakes as arguments was an earlier draft of this story: it can't reach anything an agent does, and
it bends every workflow around being tested. Record and replay assumes the same code sends the
same requests, which agents don't; a recording is still good raw material for a fake's data, and
`capture` turns a past run into a case. Real services fit what is cheap to start (a git repository,
a database in a container) and go in `setup` like any other setup.

**Taken from agent-env, and left there.** agent-env (`agentenv-framework`) gives each service two
faces: tools the agent sees, and a control side the harness uses to reset, seed and read it. Here
that is a fake and what it recorded. Its run loop gives each run a fresh world and tears down what
the run made even after a crash, as `setup` and `c.cleanup` do. Left out: tasks as JSON step lists,
checks loaded as files at run time, stores and versioned entities, a gateway and database in front
of every fake, and a shared context with rollback. Two ideas wait for workflows that need them:
scripted world events on the clock ("on day 2, a reply arrives"), and a simulated person who
answers the workflow's questions.

#### What was tried

On Bun 1.4.0, outside `bun test`, 2026-11-15:

- `spyOn` on a module's namespace reaches a workflow that imported the function, even after it
  loaded, and records calls; covers default, `const`/`let`, re-exports, prototypes, npm ESM, and
  calls within the module. Fails for copies taken at load. CJS needs both the named export and
  `default` patched. `spyOn` doesn't check the export exists, so `c.mock` does.
- `mock.module` and `Bun.plugin` (`onLoad` returning `exports`) also work outside tests. A
  `mock.module` survives `mock.restore()`, one reason each trial gets a process of its own.
- `setSystemTime` sets `Date` and `Date.now()` outside tests, for the whole process: inside
  `awf run` it froze the engine's clock (a run that started on 2026-11-15 finished on 2020-01-07,
  in 0 ms). So a case fakes the day through the workflow's own clock function.
- A hand-written `defineEnv` ran a three-stage workflow's body with a wrapped `wf`
  (`Object.create(wf, { stage })`, since `wf` has a getter): its `prepare`, stage schemas, `wf.cwd`
  and a mocked module all worked; `until` left only the stages up to it recorded and the run
  `completed`; a given value of the wrong shape failed the run in that stage.
- Replacing `globalThis.fetch` in a plain Bun process answered every `fetch`, an imported
  module's included; Node's `https.get` went past it, and patching `https.get` on the module
  missed a caller that imported `get` by name (2026-11-15). `URLPattern` matched `:id` paths.
  `expect(mock).toHaveBeenCalledWith(…)` works outside tests and throws a plain
  error.
- A typed `c.mock(ns, fakes)` prototype refused a wrong field type, a wrong parameter, and an unknown
  export at type-check time.
- Across processes: a Bun child and grandchild answered by the trial's fake over a unix socket;
  `BUN_OPTIONS` must use `--preload=path`; values cross as JSON (a `Date` becomes a string).
- Sandboxes: srt and docker build agents' environment from scratch, `network` takes domains only,
  srt reaches host unix sockets only through `sockets`, docker none; Herdr panes start from an
  allowlist. No per-run MCP option exists.
- `awf run --from-stage b --values v.json` on a fresh run gave stage `a` the value
  (`provided: true`) and ran `b`.

### Angle 1, walkthrough: the mail triage

**1. Write a case.** The input is the email, as the workflow would read it:

```json
// evals/mail/cases/trip-form/files/email.json
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

and the day it arrives, as a small fact:

```json
// evals/mail/cases/trip-form/input.json
{ "today": "2026-10-27" }
```

The key says what a good result looks like:

```markdown
<!-- evals/mail/cases/trip-form/key.md -->
---
kind: awf.case-key/0
marker: lantern-copper-walrus-tangerine
expect:
  relevant: true
  short: false
  children: Daniel
must:
  - the summary gives the deadline for the form and the money, Tuesday November 3
  - the summary says to pack a lunch for Friday November 6
must-not:
  - the summary presents the grade 5 spring trip as something to act on
---

Two dates in one email, and a paragraph for another grade.
```

- `expect` lists facts `observe` returns and the values they must have. Code checks them: free
  and exact.
- `must` and `must-not` are the **criteria**, sentences an agent judges. A `must` should be true
  of a good result; a `must-not` should never be. Three agents vote on each one; the majority
  decides. A criterion is known by its text: edit it and it is a new one, judged again; the report
  numbers them in order (`must 2`, `must-not 1`). Two the same in one key are refused.
- `marker` is a few random words that `awf-lab case new` writes: a tripwire. If they ever show up
  where the workflow's agents work, the key leaked (see "How the key stays hidden").
- The text below the frontmatter is your note on why the case exists.
- Why two formats: `email.json` is the workflow's own data, in whatever shape the environment reads
  (JSON here, since the mail API returns JSON; a case's files can be anything). `key.md` is written
  and read by people, a few fields and a note, so it is Markdown with YAML frontmatter.
- Two optional lines: `known-failing: true` for a problem you have written down but not fixed,
  and `pass: 2/3` when this case may pass less often than every time.

`awf-lab case new mail/trip-form` makes the folder and the key's marker. The first time, it also
writes `awf-lab.json`, the dataset's `dataset.json` (agents reaching nothing outside:
`"agentReach": { "network": [] }`) and a stub `env.ts` whose `workflow` is left for you to fill in; `run` refuses the stub, naming `env.ts`, until you do.

**2. Write the environment.** The mail dataset's `env.ts` is the one under "The environment"
above: a strict fake mailbox holding the case's email, the week's notes from the case's
`notes.md`, `clock.today()` returning the case's day, and `observe` returning `relevant`,
`short`, `children`, `reply` and `error`. One file serves every case of the dataset; a case differs only in its files and input.

The workflow needs no change for it: it calls its mail module as it does in production, and the
fake answers. No `--dry-run` either: `markDone` and `reply` are fakes that record, and a key for
an email that needs nothing says `reply: null`. What the environment doesn't mock (the model, a module it
doesn't name) stays real.

**3. Run it.**

```sh
awf-lab run --trials 3          # every case, three times each, on the code in your checkout
```

Agents don't answer the same way twice, so a case can run several times. Without `--trials` it
runs once; with `--failed`, each case runs as many trials as the run that gave it its verdict. With one dataset you don't name it. `--cases trip-form,fundraiser` runs
only those cases; `--failed` runs only the cases that last came out failed, flaky or unclear.
Before starting, `run` prints how many trials it will run and, from earlier runs, about what they
will cost and take, and asks.

Each trial: the lab builds a case folder outside your repository (the shared and the case's
files, never the key), makes an empty scratch folder for the workflow to work in, runs `env.ts`
with `awf run`, the scratch folder as the run's working folder, checks the agents' reach, looks for the marker, grades the facts and the result against the key, and
deletes both folders.

```text
mail · 12 cases · 3 trials each · run 14
code: this checkout, branch shorter-prompt, commit a1b2c3d, with uncommitted changes

failed, must pass
  grade-3-only        0/3   must-not 1 violated. Judge: "lists the grade 3 trip as an action"   history ✓✓✗
flaky
  trip-form           2/3   must 2 unmet once (judges split 2–1)                           history ✓✓✓
known failing, now passing
  no-school-friday    3/3   remove known-failing from its key?

passed 9 · failed 1 · flaky 1 · unclear 0 · known failing 1 (1 now passing)
trials 36 · errored 0 · criteria split 2–1: 3 of 90
time per trial, median 8s · est. cost per trial, median $0.004 · all trials $0.15 · grading $0.80
judge claude-sonnet-5-5, the same family as the workflow's model

exit 1: a case that must pass failed
```

**4. Read the report.**

- A case **passed** when all its trials passed (or as many as its `pass` bar asks); **failed**
  when most of them failed; **flaky** when it passed some and failed some; **unclear** when too
  many trials could not be graded to say. A workflow that crashes or times out on a case fails
  it; anything not the workflow's doing (setup, a refused call, an agent's reach, a grader, the
  provider) makes it unclear.
- `history` shows the case's last verdicts in earlier runs, so a case that was already flaky is
  told apart from one your change broke.
- The exit code: 0 when everything that must pass passed; 1 when a case that must pass failed;
  otherwise 5 when a trial errored by the dataset or grading, or leaked, and 3 when some
  were flaky or unclear (or the run is partial, or nothing was graded). 2 and 4 are refusals and lab failures; the
  full list is under "A case's verdict, and the exit code". A known-failing case never changes it by
  failing, but a trial of it that errored by the dataset or grading, or leaked, still gives 5.
- Cost is an estimate from list prices, not a bill; grading is shown apart, since on a cheap
  workflow judging can cost more than the trials.

`awf-lab report` shows the last run again; `awf-lab report --case trip-form` prints one case in
full, with each trial's result, each criterion's votes and reasons, and the command that opens
the agents' logs.

**5. Fix, and run again.** Fix the workflow, run the failing case with
`--cases grade-3-only --trials 3` until it passes every time (with the code unchanged, `--fresh` for
new samples), then run everything once more to see nothing else broke.

**6. Edit a key without running again.** When you only change a key, `awf-lab score` grades the
last run's trials again against the keys in your checkout, paying the judge but not the workflow.
The report says when a key changed since its run was graded.

**7. Turn a past run into a case.** `awf-lab capture {run id} --needs-work "{note}"` rebuilds a
case from what the run left: the email's id, so the dataset's `capture.ts` fetches the email again.
You then write the key. With `--good`, it also drafts `expect` from the run's facts, for you
to check: a run you call good is not proof. A captured key stays a draft, and is not graded, until
you remove `draft: true`.

### Angle 2: compare with code in another folder

```sh
git worktree add ../worktrees/app-main main     # once; then bun install and bun link there
awf-lab run --against ../worktrees/app-main --trials 3
```

The same run then has a column for each folder. Both sides run the same case folders, graded by
the same graders, trial by trial in turn, so a live site that changes during the run falls on both,
unless a side is reused from an earlier run (Q11): for a dataset that touches a live site, such as
the builds, `--fresh` runs both sides now.

- **From your checkout**, one copy for both sides: the cases, the keys, the shared files,
  `dataset.json`, the graders and `capture.ts`. What counts as a pass comes from one place,
  except the facts, which each folder's `env.ts` returns: a column whose `env.ts` differs says so.
- **From each folder**: the workflow and everything it imports, the dataset's `env.ts` (at the
  same path under `evals/`), and its own installed `awf`. A change of prompt, model, tool, stage or
  mock is just a difference between the folders.
- The other folder needs `env.ts`. The first time, copy it there, or commit it to `main` first;
  uncommitted is fine, and the column says so.
- The lab makes no checkout and installs nothing; it stops before the first trial when a folder
  lacks what it needs, and says what.

```text
mail · 12 cases · 3 trials each · run 15
                      this checkout: shorter-prompt (a1b2c3d, uncommitted)   app-main: main (9f8e7d6)
passed                10                                                     10
failed                1                                                      0
flaky                 1                                                      2
trials errored        0 of 36                                                1 of 36
time per trial        8s                                                     9s
est. cost per trial   $0.004                                                 $0.004
grading               $1.60, both sides

came out differently, largest difference first
  grade-3-only        failed 0/3                                             passed 3/3
  late-pickup         passed 3/3                                             flaky 2/3
more passes here on 2 cases, fewer on 3, the same on 7

The lab does not say which is better unless the dataset exports `compare` (Q14). A case that
passes 2 times in 3 can show 3/3 once and 1/3 the next. Read the cases.

exit 1: a case that must pass failed in this checkout
```

A case is listed when its verdicts differ or its passes differ by 2 or more. Each column's own
failed and flaky cases are listed as in a single run, with "also fails in app-main" where that is
so: the answer to "did my change break this, or was it broken already?" The exit code is your
checkout's alone. Comparing models is the same: the other model in a worktree's code, run with
`--against`, or, when `env.ts` reads the model as a parameter, `--vary model=a,b` in one folder
(Q13).

### A second example: web-to-cli's build

Here a case is one sentence ("a command that lists the front page"), and each trial needs a fresh
copy of the CLI, configured for the site, with the request filed. That is a folder, not a module to
mock, so `setup` prepares it with the project's own commands, and `observe` checks what was built
by running it:

```ts
// evals/builds/env.ts
import { $ } from "bun";
import { defineEnv } from "@agentswf/lab/cases";

export default defineEnv({
  // The copy, not your checkout; typed from your checkout, since a template import is `any`.
  workflow: (c) =>
    import(`${c.scratch}/core/workflows/build.ts`) as Promise<typeof import("../../core/workflows/build")>,

  async setup(c) {
    await $`bun run configure hn --url ${c.input.site} --public --yes --prefix WEBCLI_ --into ${c.scratch}`.cwd(c.root);
    // configure copies the checkout (not .git or node_modules), installs, and commits the copy,
    // evals/ and its keys included: drop both and start a fresh history.
    await $`rm -rf ${c.scratch}/evals ${c.scratch}/.git`;
    // workflows.json also names the models per role: keep the folder's, and insist on the sandbox.
    const config = Bun.file(`${c.scratch}/workflows.json`);
    const workflows = (await config.exists()) ? await config.json() : {};
    if (workflows.sandbox === false) throw new Error("this dataset runs only with the build's sandbox");
    // An object there is the sandbox's extra reach: keep it; absent means none in the build.
    await Bun.write(config, JSON.stringify({ ...workflows, sandbox: workflows.sandbox ?? true }));
    await $`git init -q -b main && git add -A && git -c user.name=lab -c user.email=lab@localhost commit -qm base`.cwd(c.scratch);
    const state = { WEBCLI_HOME: `${c.scratch}/.state`, WEBCLI_NO_WORKER: "1" };
    Object.assign(process.env, state);                    // the trial's process alone: the build's code reads it
    const cli = new $.Shell().cwd(c.scratch).env({ ...process.env });
    await cli`bin/hn context:add me --url ${c.input.site}`;
    await cli`bin/hn context:login me`;
    await cli`bin/hn request ${c.input.request}`.nothrow(); // filing exits non-zero by design
    const { data: [request] } = await cli`bin/hn requests --json`.json();

    // The CLI in c.scratch is the agents' work after the run: bounded, and a failure is a fact.
    // It runs on your machine unsandboxed, with only the scratch folder's state.
    const hn = (...args: string[]) => {
      const run = Bun.spawnSync(["bin/hn", ...args, "--json"], {
        cwd: c.scratch, env: { PATH: process.env.PATH, ...state }, timeout: 60_000,
      });
      try { return JSON.parse(run.stdout.toString()); } catch { return null; }
    };

    return {
      argv: [request.id],
      observe: (result) => {
        const done = hn("requests")?.data?.[0];
        if (!done?.op) return { state: result.state, runs: false, stories: false };
        const out = hn(done.op);
        return { state: result.state, runs: out?.ok === true, stories: Array.isArray(out?.data) && out.data.length > 0 };
      },
    };
  },
});
```

```json
// evals/builds/dataset.json
{ "kind": "awf.case-dataset/0", "sandbox": "workflow", "agentReach": { "network": [], "sockets": true }, "timeout": "90m", "setupTimeout": "15m", "keep": ["site/ops/**", "site/knowledge/**"] }
```

`keep` names the files saved from the scratch folder before it is deleted, so the judge can read
the code the agents wrote. `workflow` imports the build from the copy in the scratch folder: the
build takes its project root from where its code is (`site/domain.ts`), so importing it from your
checkout would build, branch and land in your checkout. The build's sandboxed agents don't inherit `process.env`; the build's
own code hands them their `WEBCLI_HOME` (`cliEnv` in `core/workflows/deps.ts`, a sub-folder of
the build's own home), which comes from that variable or `{root}/.state`, both the scratch
folder's state here. The site itself stays real: the build's
agents reach it through the browser socket their sandbox opens, not a domain, so `agentReach`
lists no domain and allows sockets (task 5's plan checks this): the browser behind the socket
reaches whatever site the case names, which is the known outreach here. That is out of a mock's reach (see "What agents call
themselves"), and a public read-only site is a fair thing for a case to touch. The build runs with the model its code names; trying another
model is another folder.

```markdown
<!-- evals/builds/cases/front-page/key.md -->
---
kind: awf.case-key/0
marker: harbor-violet-pepper-anvil
expect:
  state: "done"
  runs: true
  stories: true
must:
  - the op's code reads a title, points and a comment count for each story
must-not:
  - the op submits, votes or signs in
---
```

`expect` covers what running the built command shows (`runs` and `stories` come from `observe`).
The judge decides the criteria by reading the saved code, not by running it, and the report marks
them "read, not run". At half an hour and dollars a trial, this dataset runs one trial per case,
and `--failed` runs again only what did not pass; against another folder it runs with `--fresh`,
since the site may have changed since a reused trial. The report adds the time each stage took, read
from the workflow's run record.

### Writing good cases

- **Mix in "no" cases** (not relevant, declined), or a workflow that always says yes passes.
- **Run a new case once and read why** each criterion got its verdict before trusting the key.
- **A case that never passes** is usually a wrong key, or a site that changed. Before calling it a
  workflow problem, check that a good answer would pass it.
- **Judge with another family's model** when comparing models: a judge tends to favour its own
  family's output. The report says when a column's model shares the judge's family.
- **Mark it known failing, don't delete it**, when you can't fix it yet; the report tells you when
  it starts passing.

### How the key stays hidden, and how far

The case folder and the scratch folder are made outside your repository, and `key.md` and `key/`
are never copied into either. That is enough for a workflow whose agents work in those folders.

It is not enough for one whose agents work inside your repository: a sandbox lets an agent read
the git history of the repository it works in, and a committed key is in that history. The mail
triage is like that today, so its readers' folder moves out of the repository, which is right
anyway, since they read mail from strangers.

So every key carries a marker, and the lab looks for it before and after the workflow runs: in
both folders, git history included, then in the result, the saved files and the agents' logs. A
trial where it turns up is marked leaked and not counted. The marker is a tripwire, not a wall: it
catches a key that was copied, not one that was read and put in other words.

### Before you start

- git, and the lab linked from a checkout of this repository (`bun link` `@agentswf/lab`, which
  also gives `awf-lab`), in every folder you run. It is not published, and its checkout must read
  the run records of the `agentswf` each folder has installed; `run` checks this first.
- A workflow that calls its services through modules it imports or through `fetch`, as most do,
  and reads the date through a function of its own (a `clock.ts`), so a case can set its day.
- A workflow whose network calls use `fetch` where a case fakes them by host; a client built on
  Node's `http` is mocked by its module, or faked with a tool you install yourself.
- Under `"sandbox": "workflow"`, a workflow that opens a sandbox for every agent it starts; an
  agent outside one errors the trial as `reach`. Under `"lab"`, the lab's box is every agent's
  sandbox, so `srt` or Docker, as the setting names, is installed.
- `typescript` installed in every folder you run, for the check of `env.ts` before the first
  trial; a folder without `tsc` stops `run` with exit 2.
- Your model's login (such as `CLAUDE_CODE_OAUTH_TOKEN`) in the environment, and the judge's
  harness login when it is another provider's. The lab does not read the files your own launcher
  reads.
- A `judgeAgent` (harness and model) in `awf-lab.json` or `dataset.json` when keys have criteria.
- Nothing here is stable yet: kept runs and `env.ts` may need redoing after a lab update.

Safety and privacy:

- A module `c.mock` names refuses anything not faked, and so does every host the workflow's code
  reaches with `fetch` that no route serves and `realHosts` doesn't list (the trial errors, so you add the
  fake). Anything else stays real: a module you didn't mock, the hosts in `realHosts`, and whatever
  an agent reaches by its own commands within `agentReach`.
- `env.ts` and the dataset's `graders.ts` and `capture.ts` are your own trusted code. They run on
  your machine with your whole environment, outside any sandbox; under `"lab"`, `env.ts` runs in
  the box, with only the logins it carries in and no home folder, while `graders.ts`,
  `capture.ts` and `compare` stay outside, in the helper process. An `observe` that runs what agents
  built runs code agents wrote: give it only the environment it needs, as the example does.
- A trial of web-to-cli's build acts on a live site. A `must-not` is graded after the act; it
  prevents nothing.
- Results, with a copy of each trial's input and result, are kept outside the repository, under
  `~/.awf/lab/`, unless `awf-lab.json`'s `records` puts the run, trial and score records in it to be
  committed (Q12). They can hold private text such as real email, and score reasons can quote a
  key: a dataset of real mail leaves `records` unset or lives in a private repository. Delete a
  run's folder to be rid of it. A cases folder with real mail belongs in a private repository.
- A dataset with `"sandbox": "workflow"` trusts the workflow's own sandboxes to keep agents out of
  your home folder, where results are kept, out of `evals/`, where the keys are, and out of the
  records folder when it is set. Under `"lab"` all of these are outside the box. Both workflows
  here are checked for it. What they reach outside is checked on every trial: every agent
  sandboxed, no domain, web search or socket beyond `agentReach`.

## Scope

In scope:

- Cases written by hand: `input.json`, `files/`, `key.md` with `expect`, `must`, `must-not`,
  `known-failing` and `pass`, and files a dataset's cases share. `case new`.
- `defineEnv` and its `c` (`json`, `text`, `input`, `dir`, `scratch`, `root`, `mock`, `fake`,
  `http` with `http.requests`, the lab's `fetch` on every trial, `cleanup`, `params`),
  `setup`'s `observe`, `argv`, `stages` and `until`; `defineGrader` and `gradeCase`; `better`
  and `defineComparison` for a dataset's `compare`; all from `@agentswf/lab/cases`. `dataset.json`.
- Trials of the whole workflow, or of part of it from given stages, repeated, each in a fresh
  process with a case folder without the key.
- The reach check after each trial against `dataset.json`'s `agentReach`.
- Grading: `expect` by code, `criteria` by a judge, both behind one grader interface a dataset can
  add its own to, as code or as a workflow. The interface is built against the review scorer,
  which becomes a grader (tasks 8 and 11).
- A verdict per case, its history, known-failing cases, and the exit code.
- `run` (with `--dataset`, `--cases`, `--failed`, `--trials`, `--against`, `--param`, `--vary`,
  `--fresh`, `--budget`, `--dry-run`, `--json`, `--yes`),
  `report` (with `--md` and `--json`), `runs`, `score` (task 8, with `--grader`, `--dry-run`,
  `--budget`, `--yes`, `--json`) and `loop` (task 12, with `--json`).
- `capture`: a past run turned into a case, marked good or needing work.
- Both workflows working end to end, with their datasets in their own repositories.
- Reviews moved onto this design (tasks 7 to 13, which replace the `second-case-kind` todo):
  - grader workflows and `score`, built against the review scorer;
  - parameters `env.ts` reads, compared as columns (Q13); trials reused when unchanged (Q11);
    one store per project (Q12); a comparison's verdict in code, with presets (Q14);
  - the `"lab"` sandbox setting;
  - a review fixture as a case, and the review scorer as a grader;
  - the autoresearch datasets converted;
  - the loop, for any dataset, with holdouts;
  - the review kind's runner, store and commands retired; `collect` and `draft-key` moved into
    the autoresearch repository as its scripts, writing cases; and the records made `/1`.

Out of scope:

- Any change to `engine` or `contract`: given stages and `until` are the lab's own `wf`, not
  engine options. The reviews' move needs none (Q10): the lab wraps the `awf run` process.
- Converting the review kind's stored runs. They stay where they are, readable with an older lab
  checkout. Fixtures and keys are converted; runs are not (decided 2026-11-16).
- Statistics beyond counts, except Q14's `compare` presets.
- The lab making a checkout or installing dependencies for `--against`. A loop's try is the
  lab's own copy of the incumbent: your checkout at the start, then the last kept try (task 12).
- Faking an agent's answer inside a stage: a recorded answer goes stale as soon as an earlier step
  changes. A whole stage can be given (`stages`).
- A stage run live once and its value reused by the case's other trials: cheaper, but every trial
  then shares one sample of that stage. If it comes, it is a named option, never the default.
- Faking what an agent's own commands reach inside a sandbox (Q9), and mocks shared with child
  processes, which the same route would carry. Their reach is checked here (`agentReach`).
- A ceiling the engine enforces on what a workflow's own sandboxes may allow, before an agent
  starts. An agent editing workflows in the loop (task 12) could loosen its own sandbox; this
  story checks reach after each trial (`agentReach`), which catches it but doesn't prevent it.
  The loop's tries run under `"lab"` (Q10), where the workflow's own sandboxes are set aside and
  the box holds every agent to `agentReach`, so the ceiling isn't needed first.
- Keys kept outside the repository.
- A shadow: another folder's workflow run beside the real one on each real input, with
  differences becoming cases. It builds on `capture`; it is the story after.
- Workflows with events.

## Context and evidence

- Practice (2025–2026; Anthropic's "Demystifying evals for AI agents" and its statistics paper,
  OpenAI's evaluation best practices, promptfoo, Braintrust, LangSmith, Inspect, SWE-bench, Hamel
  Husain's evals FAQ): two modes are told apart. A **regression suite** holds cases that should
  pass nearly always, gates on a fixed bar from one run (promptfoo exits non-zero on a failure),
  counts errors apart from failures (SWE-bench), and re-runs only failures (promptfoo
  `--filter-failing`, Inspect `eval-retry`). A **capability or comparison experiment** holds cases
  expected to fail at first, needs several trials, and reads per-case differences. Running both
  sides in one session gives paired data, a free reduction in variance; a stored baseline drifts
  with time and infrastructure. All recommend grading the outcome, not the path, a fresh
  environment per trial, cheap graders before costly ones, and reading transcripts.
- Fact: at 95% per trial, 12 cases at three trials each pass a bar of "every trial" together only
  about 16% of the time (0.95^36). Hence a separate **flaky** verdict, which does not fail the run,
  and a case's history beside it.
- Fact: three voters on one model and prompt are correlated, so requiring all three to agree turns
  sampling noise into undecided trials: at 3% per criterion, a run of 108 judgments has an
  unsettled one about 96% of the time. Hence a majority, with splits shown.
- Fact: of the lab's 13,000 lines, about 700 (`src/compare`) know nothing of reviews; tasks 1 to 6
  do not use them; Q14's `compare` presets do, from task 9. The rest, the command line included, is under `src/review`.
- Fact, from reading `packages/lab/src/review` against this design: a review trial's setup fits
  `env.ts`'s `setup`; its grading (a label per finding, recall and precision, two voters and a tiebreak)
  and its multi-file key are what M2 checks the grader interface against.
- Fact: neither workflow's argv is its input (one reads an inbox, the other a ledger by id), so
  both need code between a case and a run. [[evaluation]] called this `defineEnvironment`; here it
  is `env.ts`.
- Fact: `awf run --sandbox`, which the lab puts every review trial in 
  ([[010-eval-isolation|story 010]]), refuses a workflow that opens a sandbox of its own (`help/run.txt`; [[permissions]], The
  model). The mail triage opens one per reader, with no paths and no network. web-to-cli's build
  opens one when its `workflows.json` says so, and reaches its browser only through a socket that
  sandbox opens. With `"workflow"`, the lab no longer puts every agent in a sandbox of its own, as
  story 010 promised.
- Fact: a sandbox lets an agent read the `.git` of the repository its working folder is in
  (`packages/sandbox/src/resolve.ts`, `srt/profile.ts`). The mail readers work inside the project.
- Fact: a sandbox may not be granted a path inside `~/.awf` (`packages/sandbox/src/resolve.ts`),
  so agents cannot reach the store, and the case, scratch and grade folders cannot live there.
- Fact: the review lab imports a variant file into its own process to read its settings
  (`packages/lab/src/review/lab/load.ts`); `awf run` loads it again. The new kind reads its
  settings from `dataset.json` instead, and loads `env.ts` only inside the trial's `awf run`.
- Fact (tried on Bun 1.4.0, listed under "What was tried"): `bun:test`'s `spyOn`, `mock`,
  `mock.module` and `setSystemTime`, and a replaced `globalThis.fetch`, all work in a plain Bun
  process.
- Fact: a sandboxed agent's environment is built from scratch (srt `srt/index.ts`, docker
  `docker/index.ts`), `network` takes domains only (`resolve.ts` `isDomain`), and no agent option
  adds env or an MCP server. An agent's `tools` are served by the control plane, so their handlers
  run in the workflow's process.
- Fact: `wf.stage(name, options?, work)` is the only way into a stage (`contract`'s
  `workflow.ts`); a stage's `result` schema checks what its work returns.
- Fact: the lab's runner runs its own checkout's engine source (`runner.ts`, `AWF` is
  `engine/src/operator-cli.ts`), with no `cwd`, the lab's environment less the calling session's
  variables, and no way to add to it for one run. It already passes `--run-root`.
- Fact: an installed `awf` hands a run over to the engine of the project in its working folder,
  found from `process.cwd()`, not from `--cwd` (`agentswf/src/awf.ts`, `hand-over.ts`). The engine
  refuses a workflow file of another project's engine (`workflow-loader.ts`), and `awf logs`
  refuses a run of another version (`run-state.ts` `checkRunEngine`) and finds a run outside known
  projects only through `--run-root`.
- Fact: `awf run` refuses a workflow whose `file` is not the file it loaded (`workflow-loader.ts`),
  and a spread workflow keeps its `file`.
- Fact: the lab's command line exits 2 on a usage error and 1 on any thrown error (`cli.ts`), and
  the review kind exits 3 on a budget stop (`execute.ts`). Its `--cases {n}` means n cases of a
  seeded order.
- Fact: a workflow's run record has each stage's time.
- Fact: the mail result has `relevant`, `short`, `why` and `preview` per email; an email that
  fails inside the workflow leaves an `error` there while the run completes.
- Constraint: the lab runs workflows only through `awf run` (boundary 5), so it cannot import the
  engine's lock or its engine lookup.
- Constraint: [[0003-autoresearch-tools-here-project-data-there|ADR 0003]] keeps evaluation data
  in a repository of its own. This story keeps cases in the project's repository, so the ADR is
  amended first.
- Constraint: `@agentswf/lab` is private and linked, with no promise its exports stay
  (`packages/lab/AGENTS.md`). A project gets `@agentswf/lab/cases` the way it gets `awf-lab`, by
  `bun link`, as in "Before you start".
- Assumption: an agent judging prose criteria agrees with the person who wrote them often enough
  to be useful. Task 1 tests this before anything is built.
- Assumption: the mail workflow calls its mail and notes modules through their imports. Checked
  in task 2's plan.

## Code map

### `packages/lab`

- Paths: `src/review/lab/execute.ts` (`planRun`), `runner.ts`, `store.ts`, `load.ts`,
  `workspace.ts`, `cli.ts`; `src/review/format/variant.ts`, `records.ts`, `workspace.ts` (the
  schema and `RENAMED_CONFIG_KEYS`), `validate.ts`; `src/review/judge/`.
- Everything a trial does lives under `review/`. The new kind gets a folder of its own; `review/`
  keeps working as it is until task 13 retires it. What both share moves to a neutral folder, so the
  new kind never imports `review/`: `runner.ts` (once its one review type moves out),
  `awf-lab.json`'s schema and the loader of its common fields, and `validate.ts`'s `checkSchema`
  and `describeProblems`.
- The runner's request gains an environment to add and the folder's `awf` bin, started as
  `bun --no-env-file --preload {fetch} {awf bin}`, with its working folder. Its contained mode, which mounts the lab's checkout, stays the review kind's until task 13 deletes it; the new kind uses `"lab"` (task 10)
  instead.
- The command line moves to a neutral entry that hands a dataset to the new kind or to `review/`;
  each kind keeps its own flags and help (`--cases` differs). `package.json`'s `bin` follows it
  and gains `./cases` and `./cases/fetch` exports.

### `packages/engine`, `packages/contract`

- Checked, no change. The lab reads a run through `awf run --json` and `awf logs --json`, and the
  run folder through its layout, as `execute.ts` does today, parsing lines with `contract`'s
  `readRun`.

### `scripts/check-boundaries.ts`

- Among the lab's folders, the new folder imports only the shared folder and contract.
  `src/compare`, which knows no domain, moves into the shared folder with task 9, for Q14's
  `compare`.
- The lab still imports no `@agentswf/sandbox`: the `"lab"` box is made by the provider's
  command-line tool (`srt`, `docker`), as the review lab's `docker run` is (task 10). `review/`
  may import the shared folder. The shared folder imports neither. Only the command-line entry
  imports both.
- The new kind's helper, which imports `graders.ts` and `capture.ts` by computed path, joins
  `allowsComputedWorkflowImport` in `scripts/boundary-paths.ts`.
- `defineEnv` returns a workflow made with `agentswf/workflow`'s `defineWorkflow`, the surface the
  engine serves to every workflow file it loads, so its `kind` and `meta` come from there and not
  from a copy of `contract`. `cases` imports `agentswf/workflow` as an example workflow does; the
  engine's loader plugin serves that name to every importer in the run, the linked `cases`
  included, so it is the trial folder's engine and never the lab checkout's copy (M4 confirms it
  under `bun link`).
- `@agentswf/lab/cases` runs inside a trial's `awf run`, in the project's process: it imports
  `bun:test` (outside a test file) and `agentswf/workflow`, and no package a project must
  install: `c.http` is the lab's own `fetch`. The checker already allows both (`bun:test` is skipped, any non-`@agentswf/`
  package is allowed); AGENTS.md's boundary 5 is reworded to say "contract only" means `@agentswf`
  packages, with `cases` as the entry that runs in a project. `cases` reads files (`c.json`), so it
  joins the I/O files exempt from the `pure` rule.
- The words `mail`, `review` and `finding` are refused in the new folder's identifiers, strings,
  file names and record names (not comments).
- The new and shared folders get `review/`'s `pure` rule, naming their I/O files (task 2's plan
  lists them). `@agentswf/lab/cases` is stateless: no runtime imports from `contract`, so two
  copies of it never disagree.

### The two workflows, in their own repositories

- The mail triage: its readers' working folder moves out of the repository; today's date through
  a function of its own; a new `evals/` folder. No change to how it reaches mail: the environment
  mocks its modules.
- web-to-cli: no change to `core/`; a new `evals/` folder. Its build runs from the copy `setup`
  makes, since it finds its root from its own code's folder.

## Proposed design

### Where your code runs

- **Inside the trial's `awf run`**: `env.ts`, the workflow it imports, and its `setup`, `observe`
  and teardown, in one process per trial, started by that folder's own `awf`. A grader that is a
  workflow runs in its own `awf run`. `c` works only in a trial's run; `gradeCase()` only in a
  grader workflow's.
- **In a helper process, your checkout's only**: a Bun process the lab starts with your checkout
  as its working folder, exchanging JSON with the lab, that runs `graders.ts` (its graders and `compare`) and `capture.ts`.
- The lab's own process loads no dataset code, and two folders' code never shares a process.

### The code surface, from `@agentswf/lab/cases`

- **`defineEnv({ workflow, setup })`**, the default export of `env.ts`. Its types name
  nothing from the lab's own `agentswf` or `contract`: `workflow` is typed structurally (a
  module whose default export has a `run`), and `observe`'s `result` is inferred from that
  `run`'s return. A project's `agentswf` is another copy than the linked lab's, and the brands in
  `contract`'s types (`unique symbol`) never match across copies, so naming them would make
  every `env.ts` fail its type check. It takes no type argument: TypeScript infers none of a
  call's type arguments once one is given, so `defineEnv<Input>` would leave `result` `unknown`
  (found writing the mail evals). `c.input` is `any`, typed where it is read
  (`const input: { today: string } = c.input`); `c.json<T>(name)` returns `T` (`any` by default). It makes the workflow `awf
  run` starts: it leaves `file` unset (it can't see `env.ts`'s path, and the loader allows none),
  and its name is `case-env-{dataset}`. Its body: build `c`, run
  `setup(c)`, import `workflow(c)` and take its default export, refuse one with `events`, refuse it too when the module it names was already loaded before `setup` ran (Bun lists loaded modules in `require.cache`): `env.ts` or a module it imports took the workflow statically, and every mock of a function the workflow calls as it loads (a factory building its mailbox) missed it, the dataset's error, run its `prepare` on the argv (a
  refusal errors the trial as the dataset's), run its body with the lab's `wf`, call `observe`, run
  teardown. Its result is `{ workflow: { name, version }, result, facts, stages, given, unused,
  refused }`, read by the lab through `awf run --json --quiet`; `result` is `null` under `until`.
  The workflow's own `present` and `report` are not called.
- **`setup(c)`**, sync or async, returns `{ observe, argv?, stages?, until? }`. A throw errors the
  trial as the dataset's. `setup` may set `process.env`, which the trial's process alone sees; the workflow reads
  it, and a sandboxed agent gets only what the workflow hands its sandbox.
- **`observe(result, { stages })`**, sync or async, returns (or resolves to) the facts: a flat
  object of strings, numbers, booleans and `null`; a fact whose value is `undefined` (a typo, a
  missing field) counts as missing, the dataset's (`facts-missing`); only an explicit `null` says
  the workflow returned nothing there. It runs only after the workflow's body returned (or reached `until`). `result` is the
  workflow's result, typed from its import as `Result`; under `until` it is `null`, which the
  author types by annotating `Result | null` (see Implementation notes); `stages` holds every stage's
  value by name, given or live, `Partial` under `until`. A throw errors the trial as the dataset's.
- **`c`**: `json(name)`, `text(name)`, synchronous (the case folder, the case's own files over the
  dataset's shared ones), `input` (`{}` without `input.json`), `dir`, `scratch`, `root`, `mock`,
  `fake`, `http`, `cleanup(fn)`, `params` (Q13). `cleanup` is the one teardown. The lab sets `AWF_LAB_CASE` for the run; `defineEnv` refuses to run without it.
- **`c.mock(module, fakes, { real? })`**: for each function export of `module` (a namespace, an
  object or a class's prototype) that is not a class, and never `constructor`, and for each
  function member of an exported plain object, `spyOn` with the
  fake, or, unless named in `real`, with a function that records the call as refused and throws
  "no fake for {module}.{name} in this case: fake it, or name it in `real` if it is a pure helper". A class is replaced only when faked by name. A
  `node:*` module or `bun` is refused: the engine shares the process. Returns
  the spies by name. A key the module doesn't export, or
  that isn't a function, is refused at once; the type is `Partial` over the module's functions,
  so it is a type error first. A CommonJS module is patched on its named export and on
  `default`.
- **`c.fake<T>(fakes)`**: a Proxy typed as `T` (a type alone lists no members at run time): a
  function member given is a spy, and any other member given is its value as is
  (`inbox: "school@agentmail.to"` on a `Mailbox`); any other member, when called, refuses as above, while reading `then`,
  `toJSON` or a symbol gives `undefined`, so the fake can be awaited and logged. It joins `unused`
  and `refused`, labelled by `{ name }` when given (`Db.close`), else `fake`, `fake2`….
- **`c.http(routes)`**: routes keyed `"{METHOD} {URLPattern}"`, each a function from the
  `Request` and the pattern's `params` to a `Response`. The lab's `fetch`, in place of
  `globalThis.fetch` on every trial from a preload module the lab gives the trial's process (it
  keeps its routes on a `globalThis` symbol, so the preload's copy and `cases`' share them), records every request and refuses, recording as refused, a
  request to a hostname any route names that no route matches, and a request to any other hostname
  unless it is the engine's own or in `realHosts`, which go to the real `fetch`, as does a
  `fetch` with `unix`. The engine's own are the hosts of the decision provider it
  ships (`openrouter.ai`, from `OPENROUTER_DECISIONS` in `engine/src/decisions/openrouter.ts`),
  kept in a list in the lab beside the model-family table; a list that falls behind refuses a
  decision, which errors the trial as the dataset's and names the host. The engine's decision
  provider takes `globalThis.fetch` once, when the runtime is installed, after the preload, so
  its calls go through the lab's `fetch`; that is why the list is needed.
  `c.http.requests` lists every request, whether given a URL and `init` or a `Request`. A route whose pattern has no literal host, or a key that
  doesn't parse, throws in `setup`.
- **The lab's `wf`**: the engine's, with `stage` wrapped (`Object.create(wf, { stage })`, keeping
  the engine's getters). For a stage `stages` names, it calls the engine's `stage` with work that
  returns the given value. After the `until` stage returns, it sets a flag and throws a signal of
  the lab's own.
  - **Before the flag**, every error is the workflow's own and is rethrown, and a `wf.stop` is
    the stopped outcome; except a given value its schema refused and a refused call, which the
    lab's `wf` and mocks record in the trial file as the dataset's.
  - **Once the flag is set**, the case has what it came for, so any ending of the body counts as
    reaching `until`: the signal caught by `defineEnv`, swallowed by the workflow (which gets it
    again at its next stage), or wrapped in another error by a helper of the workflow's. Then
    `observe` runs and the run completes. The one exception is a `wf.stop`, which is never
    swallowed (the engine fails an attempt whose stop was caught): `defineEnv` runs `observe`,
    writes the facts to the trial file, and lets the stop through; the lab grades the trial from
    the file, as reaching `until`.
  - **Names** in `stages`, or `until`, are looked for as string literals in the workflow's
    source files (the folder of the module `workflow(c)` imported, and what it imports from the
    same project) right after the import: one found nowhere errors the trial as the dataset's
    (`stage-missing`). A name that exists but the body never entered is no error: a body that
    returned early has `observe` run on its result with `Partial` stages and is graded by the
    key, noted "never reached {stage}"; one that threw or stopped first is the workflow's fail.
- **Unused mocks**: every fake the case gave, and every route, never called is listed in
  `unused`, and in the report beside the case, except a mock whose `.mock` `observe` read (the
  spies `c.mock` returns track that read). Never graded.
- **The trial file.** `defineEnv` appends to a file the lab names in `AWF_LAB_TRIAL`, outside the
  case and scratch folders. Under `"workflow"` it is under `~/.awf/lab/` whatever `store` says,
  since a sandbox may not be granted a path there; under `"lab"` it is in the per-trial folder
  mounted into the box and moved into the store after (task 10). It holds each change of phase, each refused call (function or host), the unused mocks and
  routes, and at the end the facts and the stages' values. The lab reads it whatever the run's ending, since `awf run
  --json` carries a result only for a run that completed.
- **The phase.** `setup`, the workflow's body, `observe`, or teardown; `after`, for what the lab
  checks once the run has ended (`reach`), the lab's own and never in the trial file. A run that dies before
  the trial file's first line (a module `env.ts` imports statically throws as it loads) is the
  dataset's, with the run's stderr as the reason: even when the throwing file is the workflow's,
  the fix is in `env.ts`, importing it lazily. Importing the workflow and
  its `prepare` belong to the body, so a change that breaks the import is the workflow's; a
  `prepare` refusal of the argv is the dataset's, and so is a module `workflow(c)` names that
  doesn't exist (a wrong path, which `tsc` can't see in a template string). An error or a timeout is
  the workflow's only inside the body; in `setup`, `observe` or teardown it is the dataset's. An
  `observe` that runs code agents wrote (the built command) bounds it with a timeout and reports
  its failure or hang as a fact, never as a throw or a wait for the trial's deadline.
- **Refused calls**: every call to a function or host the case doesn't fake, with its phase.
  Any refused call errors the trial as the dataset's ("no fake for mail.delete in this case"), with the first
  one as its reason, whether or not the workflow caught the throw. A call that must not happen is
  a recording fake and a fact, never a refusal.
- **Timeouts**: `dataset.json`'s `timeout` is the body's alone, timed by `defineEnv` from when the
  body starts; `setupTimeout` (`"10m"` by default) bounds `setup` and, again, `observe` with
  teardown. The lab passes `timeout` plus twice `setupTimeout` plus a minute as `awf run
  --timeout`, a backstop the engine
  records as `timed-out`. The engine abandons a timed-out body rather than stopping it, so
  `defineEnv` arms its own timer per phase and a SIGTERM handler: at a phase's limit it writes
  "timed out in {phase}" to the trial file, skips every later phase but teardown, writes no
  facts, and runs `c.cleanup`'s teardown. On its own timer the run is still going, so teardown
  is bounded by the backstop; on the engine's backstop or a SIGTERM, only by the engine's exit
  grace (2 s). The lab reads nothing after
  that line, and deletes the trial's folders itself whatever teardown managed. An engine
  `timed-out` with no such line is blamed by the last phase the trial file recorded.
- **`defineGrader({ grade, readsFacts?, version? })`**: a dataset's own code grader, a named export of
  `graders.ts`. `readsFacts: true` gives it the facts and the stages' values; without it, only the
  case, the result and the saved files. A grader workflow takes the same flag in `dataset.json`.
- **`gradeCase()`**: what a grader workflow reads its input from.
- **`capture`**: the default export of `capture.ts` (task 6).
- **`compare`**: a named export of `graders.ts`, made with `better.paired`, `better.mean` or
  `defineComparison` (see "Comparing: `compare`"; Q14, task 9).

### Settings files

- **`dataset.json`**: `kind: awf.case-dataset/0`; `sandbox` and `agentReach`, required; `timeout`, a trial's limit
  for the workflow's body (`"30m"` by default), and `setupTimeout` for `setup` and `observe`
  (`"10m"`), see "Timeouts";
  `realHosts`, the hosts the workflow's own code may reach for real (the engine's own are
  always allowed); `pass`, the bar for every case (`"all"` by default, or a fraction such as
  `"2/3"`); `keep`, the
  paths saved from the scratch folder; `graders`, the dataset's own, an entry marked `"onDemand": true` run only by
  `score --grader`; `judgeAgent`, when not the
  workspace's; `holdout`, a list of case names a loop's `--final` alone runs (task 11).
- **`sandbox`** accepts only `"workflow"` until task 10: trust the sandboxes the workflow opens
  itself. It is required, with no default to grow used to, so task 10 can add the lab's box
  without breaking a dataset file: `{ "lab": "srt" }` or `{ "lab": "docker", "image": … }`
  (Q10; `image` required, holding bun, git and the harnesses); `"lab"` in prose means either. Task 10 also adds `"network": "any"` to `agentReach`. The report says which setting a run used.
- **`agentReach`**: `{ "network": [domains], "webSearch": false, "sockets": false }` (`webSearch`
  and `sockets` optional, `false` by default; a cursor agent counts as web search, since its
  harness keeps its web tools), what the workflow's agents may
  reach outside, beyond their model domains; required, so a dataset says it even when it is
  nothing (`{ "network": [] }`). Checked after every trial (see "What agents call themselves").
  `sockets` is outreach too: a host process behind a socket, such as web-to-cli's browser, can
  reach anything, so a sandbox with sockets needs `"sockets": true`, and the report names them.
  Paths stay the workflow's, checked in each workflow's task (2 and 5, and 9 for the records folder) to keep agents out of the
  home folder, the store, `evals/` and the records folder.
- **`key.md`** frontmatter: `kind: awf.case-key/0`, `marker`, and optionally `expect`, `must`, `must-not` (lists of sentences),
  `known-failing: true`, `pass` (this case's bar), `draft: true` and `captured` (task 6). It is read
  strictly with the `yaml` package (YAML 1.2 core schema, a new dependency), and an unknown field
  (`expects:`) is refused: only `true` and
  `false` are booleans, and an `expect` value that is a string must be quoted, so `no` is refused
  rather than read as a string or false.
- **`awf-lab.json`** serves both kinds until task 13: `kind: awf.lab-workspace/0`, optional until
  a new-kind dataset is used; `datasets`, the review kind's folder (a new-kind dataset is a folder of `evals/` itself); `judgeAgent: { harness, model }` (not
  `judge`, which the review loader refuses as the old name of `scorer`); `store`, optional, in
  place of the default store; `records`, optional, a folder inside `evals/` for records to commit
  (Q12); `hide`, optional, paths kept out of the lab's box, a loop's copy and the code digest,
  for keys or results kept outside `evals/`; `reuseDays` (Q11). The review fields become
  optional, checked only when a review dataset is used.
- **One set of commands.** A new-kind dataset is a folder of `evals/` holding a `dataset.json`
  with `kind: awf.case-dataset/0`; a review dataset is found as today, through `awf-lab.json`'s
  `datasets`. `run`, `score` and `report` hand it to the code for its kind. With one dataset you
  never name it; with more, commands take `--dataset {name}`. `case new` takes `{dataset}/{case}`,
  or `{case}` with one dataset.

### Running a trial

- **Each folder's own `awf` runs its trials**, found by walking up from the folder to
  `node_modules/agentswf/package.json` and its `bin`, and started with the folder as its working
  folder, since an installed `awf` hands the run to the engine of the folder it starts in; the
  run's working folder is the scratch folder, through `--cwd`. Every
  later read of a trial's run (`awf logs`, the marker search, stage times) uses the same `awf`
  with `--run-root` in the store. The trial record names that `awf` and its version.
- **Before the first trial**, `run` checks each folder: the dataset's `env.ts` at the same path,
  type-checked by that folder's `tsc --noEmit` with a temporary tsconfig written in the folder's
  root beside its own (which it extends, so `types` resolve there), including only `env.ts`, and
  removed afterwards; only errors in `env.ts` and the files it imports from its own dataset
  folder stop `run`, never one in the workflow's code, which Bun would run anyway; `tsc` resolving there;
  `@agentswf/lab/cases` and `@agentswf/lab/cases/fetch` resolving there; its `awf`, started once on a do-nothing workflow in a temporary folder inside it, printing
  the record version the lab reads (checked before any record is filtered by version); the
  `judgeAgent` when keys have criteria. Any miss stops `run` with exit 2, naming it.
- **The preload**: the lab starts the folder's `awf` bin as `bun --no-env-file --preload {fetch} {awf bin} run …`,
  as `awf` starts itself (its shebang skips the folder's `.env`, which can hold a login that changes
  how every agent signs in), where `{fetch}` is `@agentswf/lab/cases/fetch` resolved from the
  folder, so the lab's `fetch` is in place before the engine, `env.ts` or anything they import
  loads. No hand-over happens, since the bin is the one the engine finds from the folder, which is
  also the working folder (`engine/src/hand-over.ts`), so the workflow runs in the preloaded
  process (tried, 2026-11-15). A hand-over or a `wake` relaunch would start a new Bun without the
  preload, so the lab starts the folder's own bin directly, never through a launcher that hands
  the run over. Not `BUN_OPTIONS`: it would reach every Bun child the
  workflow or `setup` starts, and refuse their real calls.
- **Reach**: after the run, whatever its ending, the lab reads the run's `agent-opened` and
  `sandbox-opened` lines and the run record's `sandboxes` with the column's `awf`. The trial errors
  as `reach`, the dataset's, for the following. Under `"lab"` the box is every agent's sandbox, and
  its network is `agentReach` plus the model domains, `realHosts` and the engine's hosts, since
  the workflow's code runs in it too. `"network": "any"` allows every domain. Under `"lab"` the box's spec
  replaces the sandbox items below: its web search and sockets are checked against `agentReach`;
  an agent with no `agent-opened` line and the cursor rule still apply; the report says agents
  can reach `realHosts`.
  - an agent with no `sandbox` on its `agent-opened` line, or an agent named in the run's sessions
    or turns with no `agent-opened` line at all (its reach unknown);
  - a sandbox's `spec.network` domain not in `agentReach.network` and not among the model domains
    of the agents it admitted (an absent `network` is `[]`; `*.x` in `agentReach` covers `a.x`
    and a spec's `*.a.x`, not `x`);
  - web search that `agentReach` doesn't allow: `spec.webSearch` (absent is `false`), or an
    admitted agent whose harness keeps its web tools whatever the sandbox says (cursor today,
    from `agent-opened`'s `harness`);
  - a non-empty `spec.sockets` unless `agentReach.sockets` is `true`; the report lists the socket
    paths.
  The lab never passes `--session`, so no calling agent joins a trial. It covers the agents the
  engine opens: a harness CLI the workflow's own code or a tool starts itself is not seen, and
  is out of scope.
- **The trial's environment**, under `"workflow"`: the lab's own, less the calling session's
  variables, with the
  folder's `node_modules/.bin` first on `PATH`, `AWF_LAB_CASE`, `AWF_LAB_TRIAL` and
  `AWF_LAB_PARAMS` (the parameters as JSON, kept out of the case's input digest); `setup` adds
  to it in its process. The criteria judge, on the lab's own `awf`, gets the lab checkout's
  `node_modules/.bin` instead. Under `"lab"`, the box's own, with only the harness logins task 10
  carries in, plus `AWF_LAB_CASE`, `AWF_LAB_TRIAL` and `AWF_LAB_PARAMS`.
- **Folders** are made under the system's temporary folder, in a parent folder per trial that
  holds the case folder and the empty scratch folder, and are deleted when the trial ends. The
  parent holds an owner file with its run's id and process id; at its start, `run` removes only folders
  whose process is gone.
- **Order**: trial 1 of every case and column, then trial 2, and so on; a loop's try runs case by
  case instead, in a seeded order, until `compare` sets `stop` (task 12).
- **The plan**: before the first trial, `run` prints the trials it will run and, when the store has
  earlier trials of the same cases, their median time and cost times the count, and how many
  trials it reuses, at no cost (Q11). It
  asks before starting when at a terminal, unless `--yes`.
- **One `run` or `score` at a time on a machine**, under a lockfile of the lab's own that always
  lives in `~/.awf/lab/`, whatever `store` says, freed when its process is gone. This keeps a grade
  folder (which holds a key) from any live agent: it is made only after its trial's workflow has
  ended. Running trials in parallel would first need grade folders the running agents cannot
  reach.

### `--against {folder}`

- Repeatable; each folder is a column, beside your checkout's. Each folder's `env.ts` decides
  its facts, so the run record keeps each column's `env.ts` digest, and a column whose `env.ts`
  differs from your checkout's is marked "env.ts differs" in its header. The folder supplies
  only its code: its cases, keys, graders and `dataset.json` are never read.
- A column's header gives its folder, branch (or "detached"), commit and whether it had
  uncommitted changes. The run record keeps the same per folder.
- `score`, `report` and `capture` work on such a run as on any other.

### Grading

**A grader** is given the case (folder, input and key, `key/` included), the trial's parameters
(Q13), the workflow's whole result, the facts and the stages' values when it `readsFacts`, the saved files (`keep`), and,
during the trial only, the scratch folder. It returns:

- `verdict`, optional: `passed`, `failed` or `undecided` (it could not tell);
- `numbers`, optional, by name: a count out of a total (`recall: { count: 7, of: 10 }`), summed
  per column (`of: 0` adds nothing), or `{ value }`, shown as a median;
- `reasons`: a list of `{ about, text }`, `about` naming the field, criterion or finding;
- `parts`, optional: one per thing judged (a criterion, a finding), each with its verdict or a
  `label` (a finding is `hit`, `wrong`, `noise`…), `data`, `why`, `settled` (`agreed`,
  `majority`, `tiebreak`, `unsettled`, `given`) and its raw `votes` (`by`, `role`, `verdict` or
  `label`, `why`);
- `notApplies`, alone: the grader does not apply to this case, and why.

The lab stores parts and votes without knowing what they mean. M2 settled this shape against the
review scorer (Implementation notes); it is in `records.ts`.

**Two forms:**

- **Code**: a `defineGrader` export of `graders.ts`, named in `dataset.json`:
  `"graders": ["recall"]`, or `{ "grader": "recall", "onDemand": true }` for one only
  `score --grader` runs.
- **A workflow**: `"graders": [{ "workflow": "graders/judge.ts", "readsFacts": true }]`, a path
  inside the dataset's `graders/` folder; any other path is refused. Its name, stored on its
  entries, is its path under `graders/` without `.ts` (`judge`), unique among the dataset's
  graders, never `expect` or `criteria`, and refused when a `graders.ts` export has it. The lab starts it with your checkout's `awf run`, under its own sandboxes,
  with `AWF_LAB_GRADE` naming a **grade folder** that `gradeCase()` reads. The grade folder is made
  outside the repository, beside the trial's other folders, and deleted after. It holds the case
  with its key (without `marker`), `result.json`, `facts.json` (the facts and the stages' values,
  only when the grader `readsFacts`), `kept/`, and `grade.json` (`kind: awf.case-grade/0`), which
  names the scratch folder during the trial and none under `score`, and the trial's parameters;
  and `previous.json`, its parts and the key digest they were graded on, from the grader's
  newest entry when that entry did not error and has the same `{major}.{minor}` (and, for the
  judge, the same `judgeAgent`), so it judges only what changed; otherwise none. Its run is recorded in the store; its cost is grading's
  cost. The criteria judge is the one grader workflow that runs on the lab's own `awf`, since it
  ships with the lab.

**Built in.** `expect` and the criteria judge are graders like any other, stored under the names
`expect` and `criteria`, which a dataset grader may not take. A dataset uses them by having
`expect`, or `must` or `must-not`, in its keys.

**Order, cheap first**: `expect`, then the dataset's code graders, then grader workflows and the
judge. When a grader has failed the trial, the costly ones are skipped and their criteria show
"not judged"; `score` judges them if a key edit later lets the trial pass the cheap ones.

**A trial's verdict across graders**: only the graders in `dataset.json` and the built-in ones
decide it; a grader marked `"onDemand": true` in `dataset.json` is shown with its entries and in the
agreement row, never in the verdict. Failed when any grader failed it; passed when at least one
gave a verdict and every one that did passed it; otherwise undecided. When no grader gives a
verdict (only numbers), the trial is graded by numbers only.

**When graders run**: during the trial, after its `awf run` ends, while the scratch folder still
holds what the workflow left. Not on an errored trial, or one failed because the workflow erred. Not on a case no grader applies to
(no `expect`, no `must` or `must-not`, no dataset grader), or whose key says `draft: true`.

### `expect`

- Checked by code against the facts `observe` returned, by flat name. Every named fact must equal
  the key's value exactly. Values are strings, numbers, booleans and `null`; a fact of any other
  type (an object, an array, a `Date`) errors the trial as the dataset's (`fact-type`), whether or
  not the key names it. A fact that is `null`
  where the key wants a value, or a value where the key says `null`, fails the trial as the
  workflow's; two values of different types, neither `null` (`true` against `"true"`), error it
  as the dataset's (`fact-type`).
- `error` is reserved, and so are names starting with `_`. A non-empty `error` fails the trial as
  the workflow's error, checked on every trial right after `observe`, before any grader and
  whatever the key holds.
- A fact `expect` names that `observe` doesn't return, or any fact whose value is `undefined`,
  errors the trial as the dataset's error (`facts-missing`). A wiring mistake never reads as the workflow's fail.

### The criteria judge

- A grader workflow that ships with the lab, one run per trial, one part per criterion.
- Its voters are given the trial's case folder, the workflow's whole result, the facts and the
  stages' values (it `readsFacts`: what a workflow did is often only there, such as the summary
  email a mock recorded), the saved files, and each criterion's text; never the marker, `expect`, `key/` or the agents' logs, though the
  judge's workflow reads the key from the grade folder to build their prompts. The result
  and saved files, written by agents and possibly holding a stranger's email, are data to it,
  never instructions.
- Three voters per criterion, each given that criterion alone, each giving a verdict and a reason:
  `met` or `unmet` for a `must`, `violated` or `not violated` for a `must-not`. The majority
  decides, and a 2–1 split is marked on the criterion and counted in the report. When a voter
  gives no answer, the other two decide if they agree; otherwise the criterion is `unsettled` and
  the judge's verdict is `undecided` unless another criterion failed. Every vote is stored.
- Each voter says whether its verdict rests on the saved files; a criterion any voter judged from
  them is marked "read, not run".
- Its harness and model are `judgeAgent`, from `awf-lab.json` or, per dataset, `dataset.json`.
- A `judgeAgent` or prompt other than the one task 1 checked against the person (recorded in
  Implementation notes) makes the report mark the judge "not checked against a person".
- **Model family**: a model's provider, read from its id by a small table in the lab; an unknown
  id is "family unknown". A column is marked when any of its models shares the judge's family.

### Trial outcomes

When several apply, the first in this order counts:

| Outcome | When |
| --- | --- |
| **leaked** | the key's marker, or a copy of a `key/` file, turned up |
| **errored** | not the workflow's doing: the **dataset's** (`setup`, `observe` or teardown threw or timed out, a call was refused (a function or host the case has no fake for), `reach` (an agent with no sandbox, or a sandbox reaching past `agentReach`), the workflow's `prepare` refused the argv, a fact of another type than the key's value or of no flat type at all (`fact-type`), a given stage value its schema refused, `stage-missing`, `facts-missing`), **grading's** (a grader threw or its run failed), or the **provider's** (the run stopped on a rate limit, an overload or a lost login, where the run record tells: M3) |
| **failed** | a grader failed it, or **the workflow erred**: its body failed or timed out, or `observe` returned an `error`. The report says "failed: the workflow erred" |
| **stopped** | counted as failed (the workflow erred): its body called `wf.stop` before any `until` was reached, with the stop's reason. A provider's stop is errored, above, never stopped. `defineEnv` never swallows a stop |
| **undecided** | a grader could not tell |
| **passed** | every grader with a verdict passed it |
| **graded by numbers** | the graders give numbers only, no verdict: shown with its numbers, counted as graded |
| **not graded** | no grader applies (none fits the key, or each answered `notApplies`), or the key is a draft |

A trial errored by the provider is tried once more at the end of its round (in a loop's try,
right after that case's trials, before the next case). A broken grader is
never read as a verdict: a known fail with a grader that errored shows as errored until `score`
succeeds. A run that finishes with the wrong answer, like the build's "deferred", is a fail.

### A case's verdict, and the exit code

With T trials asked, a bar b (the key's `pass`, else the dataset's, else all), need = ceil(b × T),
and p passed and f failed trials:

- **passed** when p ≥ need;
- **failed** when f > T / 2: most trials failed;
- **flaky** when p ≥ 1 and f ≥ 1 otherwise;
- **unclear** otherwise: too many trials errored, undecided or leaked. The line says why.
- A case whose trials are all not graded, or all graded by numbers, has no verdict and is
  listed apart; only the second counts as graded for the exit code.

So at three trials and the default bar: 3/3 passed, 2/3 with one fail flaky, 1/3 or 0/3 with the rest failed, failed,
2/3 with one undecided unclear. At one trial, pass or fail. A `pass: 2/3` bar at one or two trials
rounds up to every trial, and the report says so.

**History**: each listed case shows its verdicts in earlier runs of the same column (in the store,
or the records folder when set),
newest last, up to five. A column is its sorted parameters and its folder: the checkout running
`awf-lab`, whichever worktree of the project it is, or another folder by its path. Task 9's plan
may key it by the reuse key instead.

**Known failing**: a case whose key says `known-failing: true` is listed under "known failing".
When it passes at three trials or more, it is listed as "now passing", with the suggestion to
remove the flag; a pass at fewer trials says to confirm with `--trials 3`.

**`--failed`**: the cases whose newest verdict in your checkout's column, in the store or the
records folder when set, is
failed, flaky or unclear. `--trials` defaults, per case, to the trials of the run that gave that case's verdict.

**The reference column** is your checkout with `--param`'s values and the first value of each
`--vary`. In a loop, it is the incumbent: your checkout at the start, then the copy of the last
kept try. `--failed`, the exit code and Q14's verdicts are read against it; in a loop, Q14's
verdicts and `--final`'s exit code.

**The exit code**, for `run`, `report` and `score` of the new kind, from your checkout's
reference column alone:

- **0**: every case that must pass passed;
- **1**: a case that must pass failed;
- **5**: none failed, but a trial errored by the dataset or by grading, or leaked: the
  environment, a grader or the key's hiding is broken, which a CI that tolerates 3 must not pass;
- **3**: none failed, errored so or leaked, but one was flaky or unclear, the run is partial, or
  no case was graded at all (neither a verdict nor numbers);
- **2**: refused before any trial: a usage error, a folder or dataset missing what it needs, or
  the plan was declined;
- **4**: the lab itself broke during the run.

Known-failing cases and cases with no verdict never change it by their verdict (an errored or
leaked trial of one still gives 5), except that a run in which no
case was graded at all, by a verdict or by numbers, exits 3. A dataset graded by numbers only
counts as graded. Review datasets keep their codes
until task 13.

### Report rows

- One line per case that did not pass (failed, flaky, unclear, then known failing and now
  passing), with its passes out of its trials, what kept the rest from passing, the first failing
  check or criterion with its reason, and its history. A case that passed with a mock never
  called, or a stage never reached, also gets a line, under "passed, with notes", the note first.
- One summary line of case verdicts; one of trials (errored, by whom; undecided; leaked; criteria
  split 2–1); one of time and cost per trial (medians, errored trials left out) with grading's
  total apart. Cost is the accounting's estimate; "partly unpriced" when some usage had no price.
- "read, not run" whenever a criterion was judged from saved files; a dataset grader's numbers,
  pooled per column; the median time per stage under `--case` and for a dataset with one trial
  per case.
- Marks: a key or grader changed since the run was graded (with the `score` command); a case
  edited since the run (run it again); a column whose model shares the judge's family; a judge not
  checked against a person; the sandbox setting; with two graders on the same trials, how often
  they agree: their verdicts, and their parts' labels matched by `about`.
- With more than one column: the columns side by side; the cases that came out differently
  (verdicts differ, or passes differ by 2 or more), largest difference first; the count of cases
  with more passes on each side; "also fails in {column}" on a column's failing lines. With a
  `compare` export (Q14), each column's verdict against the reference column, with its reason;
  without one, "The lab does not say which is better. Read the cases.", or at one trial each "One trial each: these
  are examples, not rates."

### Comparing: `compare`

A dataset says what "better" means by exporting `compare` from its `graders.ts` (Q14); without
it, a report has columns and no verdict.

- **The forms**: `better.paired({ primary, guards?, tiebreak? })`, the review loop's sequential
  paired rule from `src/compare`, which can stop as soon as it can tell; `better.mean(fn)`, the
  higher average of one number per trial, as DSPy's optimizers use; or a `defineComparison` of
  the dataset's own. All pure, from `@agentswf/lab/cases`, run in the helper process.
- **Its input**, per trial: `passed` (1 or 0, missing when there is no verdict), the graders'
  `numbers`, `cost` and `time`. A trial with no numbers, because the workflow failed or a costly
  grader was skipped, scores what each metric's `onFailure` says (default `"missing"`), so a
  review's recall can count 0.
- **Its output**: each column's verdict against the reference column, its reason and metrics,
  and `stop`, as JSON with `--json`.
- **`stop` ends only a loop's try** (task 12). A plain `run` runs every trial it planned.

### What is kept

**The store** (Q12): `~/.awf/lab/{name}-{id}/`, one per project, named from its repository's first
commit and its main checkout's folder, so every worktree and loop copy shares it; never inside the
repository. With `records` set, run, trial and score records go to that folder in `evals/`, to be
committed, and are read from there; the workflows' run records stay in the store. A run's id is
then unique across machines, and `report {id}` opens a committed one.

**Reuse** (Q11): a stored trial is reused, within `reuseDays` (14 by default), when what shaped it
is unchanged: the code (a digest of the files git would hold, less the records folder, `hide`, and
each dataset's cases, keys and grading code), the parameters, the case's input, `env.ts`, the trial
settings in `dataset.json`, and the `awf` and lab versions. Never a trial errored by anything but
grading, nor a leaked one. A code folder outside git is refused (exit 2). A key or grader change grades a reused trial again, by `score`'s rules,
and runs nothing. History and verdicts count each trial once; asking for more trials runs only the
difference; `--fresh` runs all new ones. The plan and report say how many trials were reused.

- Without `records`, a run's id is a number, the next one in the store, taken under the lock. `report` shows the last
  run; `report {n}` another; `awf-lab runs` lists them, newest first. With `records`, `runs` lists
  the runs in the records folder, committed ones included, and a bare `report` shows the newest.
- The workflows' run records are kept there too, through `--run-root`.

**A run record** (`kind: awf.case-run/0`): its id (and, for a run made here, its local number), the dataset, the folders (for
each: path, branch or "detached", starting commit, whether there were uncommitted changes), the
cases and trials asked for, the columns (folders times parameter combinations), the trials
reused from earlier runs, start and finish times. No finish means partial.

**A trial record** (`kind: awf.case-trial/0`):

- which: run, dataset, case, folder, and the `awf` it ran on with its version;
- the input: a copy of the case's own files and `input.json` (never the key), and the digest of
  the dataset's shared files, kept once by digest rather than per trial;
- the conditions: the sandbox setting, `agentReach`, the models used, when it ran;
- the parameters and the reuse key;
- what happened: the workflow run's id and outcome, its time and cost (the accounting's
  `estimate`, with its `known` and `priced` counts), each stage's time, the whole result, the
  facts, the stages' values (which were given), the unused mocks, the refused
  calls each with its phase, the saved files, whether the marker was found, the outcome, and
  the agents' sandboxes and the reach check's result, and `errored: { by, phase, reason }`
  (phase `after` for `reach`) or the workflow's error when there was one.

**A score record** (`kind: awf.case-score/0`): the trial, when it was made, and one entry per
grader. A trial keeps every score it is given; the report reads each grader's newest entry, and an
errored one shows the trial as errored by grading until a later `score` succeeds.
Each entry has the grader's name and its version (a workflow grader's, with its run's id), a digest of the part of the key it reads (`expect`'s values for `expect`, each
criterion by its text for the judge, the whole key with `key/` for a dataset's own), its verdict,
numbers, reasons, harness and model, cost, its parts with their votes, and `errored` when it errored.

### Grading again: `score`

`awf-lab score [{n} | {id}]` grades the last run (or the run named) again. It never runs `env.ts`: not `setup`,
the workflow, or `observe`.

- **What it grades again**, on a trial graders run on (see "When graders run"): a grader whose key
  digest or `{major}.{minor}` changed, the judge when `judgeAgent` changed, one whose newest
  entry errored, or one with no entry (a draft made final, criteria or a grader added, criteria
  "not judged" once the cheap graders pass). An `onDemand` grader is graded only by
  `score --grader`. The judge judges only changed criteria unless its model or minor changed.
- **What it grades from**: the trial's stored case folder, the current key, the stored result, the
  stored facts and stages' values, and the saved files. There is no scratch folder: a grader that
  needs one rebuilds it from the stored case, as the review grader restores the checkout.
  A trial whose case input changed since it ran is not graded again; the report says to run that
  case again.
- **The versions** (decided 2026-11-16, replacing code digests): every grader declares a semver
  version, as the review kind's variants and scorers do. A code grader's is `defineGrader`'s
  `version`, a grader workflow's its `meta.version`, `1.0.0` when left out; `expect`'s and the
  criteria judge's are semver versions the lab declares (`expect` 1.0.0), the judge's minor going up when its voters or prompt
  change (a `judgeAgent` change is detected apart, see `score`). A minor bump says the grader judges differently, so `score` grades again; a patch says
  it judges the same. Whether it does is the author's call; nothing checks it, as a digest of
  `graders.ts` couldn't either, missing the files it imports.

### The marker search

- **Before the trial's process starts**: the case folder, files and, in any git repository inside
  it, every commit (`git grep` over `git rev-list --all`), where a committed key is stored
  compressed. Found: the trial ends as leaked, without running. What `setup` puts in the scratch
  folder is searched after the run, with the rest.
- **After it runs, before grading**: the scratch folder again, the result, the saved files, and
  everything the column's `awf logs` has for the workflow's run. Found: leaked.
- **`key/` files** carry no marker, so the search looks for a file whose digest matches one of
  them (an empty `key/` file is refused when keys are read, since it matches every empty file), and, in a git repository, for each one's blob id among `git rev-list --all --objects`.
- **The marker** is a few plain words, a shape `awf logs` does not take for a credential and hide.

### What may change, and what may not

- **`/0` means "may change without a way to read old files"** for what the lab writes: run, trial,
  score and `grade.json` stay `/0` until task 13, where they become `/1`. Records committed in a
  `records` folder follow the same rule: records of another version are refused by name, the
  report says so, and history and reuse start over from the new ones (beta, no converter).
- **Costly to change**: the names that pair kept results (a case's folder name, a dataset's
  folder name, a grader's name, a criterion's text), the case and dataset layout and its reserved
  names (`cases/`, `files/`, `input.json`, `key.md`, `key/`, `env.ts`, `graders.ts`, `graders/`,
  `capture.ts`), the exit codes, and the
  formats people write by hand and commit (`key.md`, `dataset.json`, `awf-lab.json`). These start
  at `/0`; their next incompatible change makes them `/1`, with a converter in the lab.
  `dataset.json`'s `graders` is exempt until task 13.
- **Unstable, no converter**: the code shapes people write against (`defineEnv`, `setup`'s
  return, `c`, a grader's result, `compare` and its presets).

### Decisions

Settled by the owner:

- **The judge reads the facts** (2026-11-15): what a workflow did is often only in a mock's
  record, not in its result (the mail triage's summary goes out as an email), so `observe` hands
  it to the judge as a fact.
- **Criteria are two lists of sentences** (2026-11-15): `must:` and `must-not:` in a key's
  frontmatter, no ids. A criterion is known by its text, so an edited one is judged again.
  Found writing the mail evals, where `id`, `kind` and `text` per criterion was most of the key.
- **Run and score first; compare second.** A case says whether it must pass; a run gives a
  verdict and an exit code from its own trials. Comparing is the same run on more folders, or
  parameter combinations (2026-11-14; Q13).
- **The unit of change is a folder of code** (2026-11-14). A setting such as the model is code
  too, and comparing one is comparing folders (2026-11-15). Amended 2026-11-16: a setting the
  workflow reads as a parameter is compared in one folder (`--vary`, Q13), since the review
  research compares one workflow across dozens of such settings, and a folder each would be a
  worktree each. A change to code is still a folder.
- **Reviews and the loop move over on this branch** (2026-11-16), replacing "reviews move over
  in the next story" (2026-11-14): building them beside the design shows what it gets wrong while
  it can change. The purpose is a framework where agents iterate on workflows and find better
  ones quickly; the design may change for it, and the change is recorded here.
- **One outer box, `"lab"`** (Q10), **trials reused when unchanged** (Q11), **one store per project
  with committable records** (Q12), **settings as plain parameters** (Q13), **"better" in code with
  presets** (Q14), all 2026-11-16; the answers are under Open questions.
- **The review kind's stored runs are not converted** (2026-11-16): fixtures and keys are; runs
  stay readable with an older lab checkout.
- **A case's world is set up in code, as a unit test's is** (2026-11-15): one `env.ts` per
  dataset, with `bun:test`'s mocks as agents and people already write them; the
  workflow runs as it ships, with no fakes passed in as arguments.
- **A stage is given or stopped after through the lab's `wf`** (Q8, 2026-11-15): `stages` and
  `until`, no engine change, no new ending, no `--to-stage`.
- **Agents' own commands are not faked in this story; their reach is checked** (Q9,
  2026-11-15): every agent of a trial runs in a sandbox reaching no more than `agentReach`, checked
  from the run's records. Faking them, through an engine route into the sandbox, is a later story.
- **HTTP is faked through the lab's own `fetch`, with no msw** (2026-11-15): routes keyed by method
  and `URLPattern`, answered with `Response`; the lab depends on nothing a project must install. A
  workflow is assumed to reach its services with `fetch`; one that uses another client mocks it
  by module, or installs and starts its own tool (msw, say) in `setup`.
- **Grading is pluggable**: graders are code or a workflow, and the two built in are graders like
  any other (2026-11-10, confirmed 2026-11-14). Their exact shape is settled by trying it (M2).
- **A past run becomes a case from its traces**: the dataset's own code rebuilds it; the engine
  does not change (2026-11-14).

Settled in the design:

- **Both sides run in one run.** Paired: same cases, graders and machine. Amended by Q11: a
  side whose code, parameters and case are unchanged reuses its stored trials within a window.
- **Keys live beside their cases**, and the marker says when one leaked. ADR 0003 is amended for
  this kind of case before task 2's code.
- **Grade the result, not the path.** Which stages ran and how long they took are shown, never
  graded.
- **The workflow's own errors fail the case; everything else's make it unclear.** A prompt change
  that makes the workflow crash is a regression, a rate limit is not.
- **A mixed result is flaky, not failed**, with history beside it, so the gate stays meaningful at
  several trials.
- **The judge decides by majority**, with splits counted, since its three voters are correlated.
- **Mocks are strict, and a refusal is the case's to fix**: a mocked module's functions not
  given, requests to a routed host that no route matches, and requests to any other host not
  the engine's own or in `realHosts`, throw, and the trial errors as
  the dataset's, so a forgotten fake never reads as a regression. A call that must not happen is
  a recording fake and a fact the key checks (`reply: null`), so it fails as the workflow's.
- **One process per trial**, so a mock is a plain function `observe` reads, and nothing needs
  restoring.
- **Facts, not assertions**: `observe` returns values and the key judges them, so every failing
  fact is reported and a key edit is graded again by `score` without code.

What must hold:

- The lab never copies `key.md` or `key/` into a case or scratch folder, and no trial record holds
  them. (A grader workflow's run record, in the store, does.)
- A trial that errors is shown and says whose error it was; only the workflow's own errors fail
  it.
- A trial where the marker turns up is marked leaked and not counted.
- A known-failing case never changes the exit code by its verdict; an errored or leaked trial of
  one still gives 5.
- A captured case is never graded against the run it came from; only the lab's own trials are.
- Nothing under `review/` is imported by the new kind, and nothing in the new kind names a
  workflow. Review code lives in the autoresearch repository after the move, as that dataset's own code
  (task 7); the new kind stays free of it.

How "done properly" is checked:

1. `scripts/check-boundaries.ts`: the new folder never imports `review/`, and the shared folder
   imports neither.
2. The same script: no domain word (`mail`, `review`, `finding`) in the new folder's identifiers,
   strings, file names or record names.
3. Every record the new kind writes, and every `key.md`, `dataset.json` and new-kind
   `awf-lab.json` it reads, has a schema with a versioned `kind`, checked before writing and on
   reading.
4. A test: a marker in a scratch-folder file, or only in a commit of a git repository there, or a
   copy of a `key/` file, is caught.
5. A test: each case verdict and each exit code.

Alternatives rejected:

- **Comparing against a kept run of `main`** (the previous draft): it needed `main` run first, a
  picker for which kept run to use, refusal on different trial counts, and rules for cases and
  keys edited between the two runs; and the baseline drifted with time and the site. Running both
  sides costs the baseline again, which `--failed`, `--cases` and one trial per case keep down.
  Q11 keeps both sides in one run, but reuses an unchanged side's trials, with no picker.
- **A variant as the way to compare a change to code**: it cannot hold a change to a prompt, a
  tool or a stage without the workflow exposing every part someone might change.
- **Fakes passed to the workflow as arguments**, through a **variant** (a file per setting that
  wrapped the workflow, the earlier draft): it reaches nothing an agent does, bends every workflow
  around being tested, and a setting such as the model is code anyway (a parameter `env.ts`
  reads, Q13).
- **Network fakes for agents' own commands** (a proxy, `PATH` shims, a preload in child
  processes): proven unsandboxed, but a sandbox starts agents' processes from nothing; it needs an
  engine route into the sandbox (Q9). This story checks agents' reach instead.
- **Record and replay** (VCR, Polly): an agent doesn't send the same requests twice. A recording
  is still raw material for a case's files.
- **agent-env's environments**: a gateway, a database and MCP servers in front of every fake, and
  tasks as JSON step lists.
- **`--from-stage` with `--values`** for a stage case: works today, but gives only the stages
  before the start point, and the run goes on to the end. **`--to-stage`** in the engine: a new
  `paused` ending, a record-format change, for what the lab's `wf` does alone.
- **`observe` asserting with `expect`**: stops at the first failure, and a key edit would mean a
  code edit.
- **Every trial must pass, or the case fails**: at several trials, an unchanged flaky case fails
  most runs.
- **All three voters must agree**: correlated voters split by chance, and most runs would be
  unclear.
- **Statistical thresholds for "came out differently"**: a few cases at a few trials settle
  nothing; the list is for reading.
- **The lab making the other checkout**: its dependencies, its link to the lab, and cleanup, for
  what `git worktree add` already does.
- **Loading every folder's dataset code into the lab's own process**: two folders' modules, and
  two copies of the lab's, in one process.
- Reusing a trial on one digest of "the code": if it includes the cases, editing a note runs
  everything again; if not, editing `env.ts` runs nothing again. Q11 keys a trial on separate
  parts instead: the code folder's digest over what git would hold, less the records folder,
  `awf-lab.json`, the paths `hide` names and the dataset folders' cases, `graders.ts`,
  `capture.ts`, `dataset.json` and grader workflow files; the case's input digest; `env.ts`'s digest; so a key edit runs no trial again.
- A larger setup surface (`defineEnvironment` with `prepare`, `network` and `capture`; file
  helpers; placeholders in `argv`): about 25 names, many of them configuration, where `env.ts`
  is code with a dozen.
- A grader kind that runs a command: `observe` does it with your own code.
- One markdown file per case: holds no attachment, and hiding the key becomes parsing.
- One table per dataset, as most eval tools have: poor for a long email and for a case made from a
  run.
- Faking outside services in the engine: `env.ts`'s mocks do it in the trial's process.
- Making the lab's review code general first: thousands of working lines reworked before the new
  kind has shown value, and a shared part guessed from one example.
- Turning a workflow's own sandbox off for every trial by default: the mail triage's is stricter
  than the lab's, web-to-cli's browser is reached only through its own, and a trial should run
  what ships. Under `"lab"` (Q10), a setting a dataset chooses, the box replaces them.
- The whole trial in a container by default: the workflow's own sandbox would have to run
  inside it. Under `"lab"` (Q10), a setting a dataset chooses, the whole trial runs in one box
  and the workflow's own sandboxes are set aside.

## Tasks at a glance

0. [x] The mail triage's evals written against this design, in `mini-workflows` on its `evals`
   branch, and reviewed by the person: `env.ts`, seven cases, and what writing them changed here

- [ ] 1. By hand: ten mail cases, and whether a judge agrees with the person
- [x] 2. The mail triage runs on cases, graded by `expect`, with a verdict and an exit code
- [ ] 3. Criteria are judged (after task 8): built; the check against task 1 waits on task 1
- [x] 4. The same cases on code in another folder
- [ ] 5. web-to-cli's build runs on cases: the lab's part built (time by stage); its dataset waits on the person
- [ ] 6. A past run becomes a case: built; its live check on both workflows waits on task 5

Reviews and the loop (added 2026-11-16):

- [x] 7. What reviews and the loop need, set against the design
- [x] 8. Grader workflows and `score`, built against the review scorer
- [ ] 9. Parameters, compared as columns, and trials reused
- [ ] 10. The `"lab"` sandbox
- [ ] 11. A review dataset on cases, graded by the review scorer
- [ ] 12. The loop, for any dataset
- [ ] 13. The review kind retired, and the records made `/1`

Order: 7, 8, 3, 4, 5, 6, 9, 10, 11, 12, 13; task 1 is the person's, at any time. Task 7 comes
before tasks 3 to 6 are started, since what it finds can change their design too. Task 3's
criteria judge is one more grader workflow on task 8's path.

## Open questions

None open now. The owner's answers: Q8 and Q9 under Decisions, Q10 to Q14 below, from task 7;
task 7's smaller tensions are settled in its Work list. Smaller ones,
settled in the design:

- Q1. The default bar: every trial passes; a mixed result is flaky, not failed.
- Q2. The judge: three voters, majority; splits counted.
- Q3. Exit codes: 0 clean, 1 a must-pass case failed, 2 refused or declined, 3 flaky, unclear, partial or
  nothing graded, 4
  the lab broke, 5 a trial errored by the dataset or grading, or leaked.
- Q4. Where runs are kept: numbered runs, unique ids with `records`; one `run` or `score` per machine at a time. One store
  per project since Q12.
- Q5. One set of commands for both kinds, until task 13 leaves one kind: yes; `dataset.json`'s `kind` marks the new one.
- Q6. The judge's model: once for the workspace; a dataset may override it.
- Q7. A setup that runs the project's own commands: accepted; a case does not carry a prepared
  checkout.

Task 7's, asked one at a time and answered by the owner:

- Q10. Where the loop runs code an agent wrote, which could read the keys beside it in the
  checkout (2026-11-16): under `"lab"`, which is one outer sandbox around the whole trial
  (`awf run`, the workflow's code and its agents), from any provider (srt or Docker, a setting),
  with the keys outside it. Inside it the workflow's own sandboxes are set aside, since srt does
  not nest on macOS and awf refuses srt inside Docker on Linux; `agentReach` still checks every
  trial. The loop runs every try under it. Task 10 checks whether `awf run` works inside srt; if
  not, Docker is the first provider. No engine change: the lab wraps the `awf run` process, as the
  review lab's `docker run` does.
- Q11. Reusing trials already run (2026-11-16): by default. A stored trial is reused when what
  shaped it is unchanged (the code, a folder's digest and the parameters; the case's
  input digest; `env.ts`'s digest; the `awf` version) and it is within a window, 14 days by
  default. The report marks reused trials with their date; `--fresh` runs new ones. This replaces
  "every run costs its full price" and "a kept run is not a baseline": a loop pays for its
  incumbent once, and `--against` runs the other side only when it changed.
- Q12. Where results are kept (2026-11-16): one store per project, not per checkout, found by
  the project's identity (such as its repository's first commit), so worktrees and loop copies
  share trials. Trial and score records may live in a records folder in the repository (`records` in
  `awf-lab.json`), to be
  committed, as autoresearch does; the workflows' run records and logs stay in `~/.awf/lab`. Since
  score reasons can quote a key, under `"workflow"` the records folder is kept out of the agents'
  reach as `evals/` is; under `"lab"` it is outside the box. This replaces Q4's "one store per
  checkout"; the store itself stays outside the repository, since the workflows' run records,
  a grader's among them, can hold keys.
- Q13. How settings are compared (2026-11-16): as plain parameters, with no named concept.
  `--param k=v` sets them for a run; `--vary k=a,b`, repeatable, runs every combination as a
  column labelled by its values; `env.ts`'s code reads `c.params` (in `setup`, `observe` and the
  graders) and turns them into argv or picks the workflow module it imports. Trials are keyed by
  a digest of the folder plus the sorted parameters, made by the lab; no versions. autoresearch's
  variant files become parameter values in its review `env.ts`, and its `read` functions code
  there. One `timeout` per dataset covers every combination. This replaces the "arms" of the
  2026-11-16 amendment to "the unit of change is a folder of code", and task 9.
- Q14. What "better" means (2026-11-16): code, as graders are, with presets, as DSPy's metrics
  are (a function per prediction, higher is better, with built-ins such as exact match). A
  dataset's `graders.ts` may export `compare`: a preset, `better.paired({ primary, guards,
  tiebreak })`, which is `src/compare`'s sequential paired rule that stops as soon as it can tell
  and the review loop uses today, or `better.mean(fn, { onFailure? })`, the higher average of one number per
  trial; or its own `defineComparison`. Each trial gives it `passed` (1 or 0 from its verdict),
  the graders' `numbers`, `cost` and `time`; it runs in a process of its own, as code graders do.
  Without a `compare` export, a report shows columns and no verdict, as before; with one, every
  `--vary` or `--against` column gets a verdict against your checkout's, and the loop keeps or
  drops a try by it. The exit code still comes from your checkout's own cases.

## To measure

- M1. Whether web-to-cli's build minds that its run's id is the lab's, not the request's (its notes
  say the run carries the request's id). Checked in task 5's plan.
- M2. Whether the grader interface carries the review scorer. In task 2's plan, before the score
  record is built, write the review grader against it as a sketch that does not ship (per-finding
  labels, recall and precision, `key/evidence/`), once as code and once with its judge as a grader
  workflow. It checks that `parts` and `votes` carry per-finding labels and a two-voters-and-a-
  tiebreak rule, writes a review trial against the trial and run records, and settles whether a
  grader needs to say "does not apply". What does not fit changes the interface before it is built.
- M3. Whether a workflow's run record tells a provider's stop (rate limit, overload, lost login)
  from the workflow's own failure. In task 2's plan, from both workflows' records. Until it does,
  every failed run is the workflow's.
- M4. Whether `defineEnv` runs another workflow's body with the lab's `wf` as a hand-written one
  did on a no-agent workflow (`prepare` on the argv, stages recorded and schema-checked, `until`,
  a given value refused by its schema): now with agents and their sandboxes opened through the
  wrapped `wf`, and on web-to-cli's build, whose stages go through a helper of its own; and
  whether `defineEnv` can run its teardown when the engine cancels or times out the run, and
  whether a workflow imported from a copy in the scratch folder (web-to-cli's build) loads there
  with its dependencies, the copy's own `node_modules/agentswf` included. In task
  2's plan, before `defineEnv` is built.
- M5. Whether the folder's own bin, started in the code folder with `--cwd` the scratch folder,
  runs the trial without a hand-over at another `agentswf` version than the lab's, and records it
  under `--run-root`. A run with the repo's own engine was recorded there, and the lab's
  `--preload` was tried on the real bin: the workflow's `fetch` and the decision provider's both
  went through it. In task 2's plan.
- M6. How long the marker search takes on a restored review checkout, which carries its
  project's whole history, and whether it must be limited to commits not in the dataset's shared history bundle. In task
  11's plan.

## Task execution rule

Process one task at a time, with two exceptions: task 2 may start before task 1's decision is
recorded, since task 1 is the person's work and no code; and the order after task 2 is the one under
Tasks at a glance: 7, 8, 3, 4, 5, 6, 9, 10, 11, 12, 13. Every task repeats the checklist shown
under its details. Do not begin the next task because the current implementation merely compiles:
its design must be recorded, its diff reviewed by subagents, findings resolved, and focused
verification complete.

After all tasks are complete, run story-level verification and request human review of the complete
deliverable.

## Task details

### 1. By hand: ten mail cases, and whether a judge agrees with the person

Outcome: a yes or no on whether prose criteria are worth building, before any code. One day.

Execution:

- [ ] Plan: pick the emails; write the bars below into Implementation notes before looking at any
  result.
- [ ] Implement: no code in this repository. Runs use the workflow's own `--dry-run --again`,
  which reads the real inbox, so a case is an email already there or forwarded to it. A judge
  prompt run by hand, given exactly what the built judge will be: the case folder, the whole
  result and one criterion per call, voted three times.
- [ ] Review: one subagent checks the counting.
- [ ] Resolve: record the numbers and the decision here. Keep each email as a case folder, with
  every judged output as a `result.json`, the person's verdicts and the hand-run judge's, as
  fixtures for task 3's live check. They hold real mail, so they live in the mail project's
  private repository, never here.
- [ ] Verify: the `Done when` items.

Work:

- About ten emails, about thirty criteria, some the workflow got wrong. At least three where the
  right answer is "not relevant" or "short".
- Each email run three times: about 90 verdicts on real outputs, nearer thirty independent ones.
- Outputs that should fail, from real misses or good summaries broken by hand, so a judge that
  always says `met` is caught: at least fifteen with an unmet `must`, and fifteen with a violated
  `must-not`. About 120 verdicts in all.
- Before any result is seen, a third of the emails, with at least five broken outputs of each
  kind, is set aside. The prompt is written and tried on the other two thirds. Before the held-out
  third is judged, both the prompt and the criteria's text are frozen.
- The person gives every verdict before seeing the judge's. Then the judge does, as it will be
  built: three voters, the majority deciding.

**The bars**, over all verdicts in the tuned two thirds. That part is small (about 20 independent
real criteria and about 10 broken outputs of each kind), so Implementation notes give the
real-miss numbers first, each bar as a count beside the percentage, say that it is in-sample, and
say when a bar was missed or met by one verdict.

- On real misses alone, the judge finds at least 80% of `unmet`s and violated `must-not`s, over at
  least five. With fewer than five, Implementation notes say this was not measured.
- The judge misses at most 10% of the `must-not`s the person called violated.
- The judge finds at least 80% of what the person called `unmet`.
- The judge and the person agree on at least 85% of verdicts.
- Of the verdicts the person called `met` or `not violated`, the judge calls at most 5% `unmet` or
  `violated`, so good results are not failed.
- The share of 2–1 splits is recorded; above 10%, the prompt is reworked before the held-out third.

**The held-out third** (about 40 verdicts) checks that the prompt was not fitted to its examples.
Run once, by hand, at the end of task 1: at most one violated `must-not` missed, at most one
`unmet` missed, at most one good result failed, and agreement within 10 points of the tuned part.
Task 3 then checks only that the built judge gives the hand-run judge's verdicts on that part.

**If the judge misses a bar**, criteria leave this story: keys hold `expect` alone and the key
reader refuses `must` and `must-not`; task 3, which is the
judge alone once task 8 has `score` and grader workflows, is dropped, and so are task 5's "read, not run" and the person's check of the
judge.

Done when:

- The numbers and the decision are in Implementation notes.

### 2. The mail triage runs on cases, graded by `expect`, with a verdict and an exit code

Outcome: `awf-lab run` and `report` work for the mail dataset, set up by its `env.ts`; each case
gets a verdict and `run` exits by it. It does not wait for task 1.

Execution:

- [x] Plan: first, amend ADR 0003 and rewrite `second-case-kind` (folded into tasks 7 to 13 since) as "move reviews onto the case
  kind". Do M2, so the score record and its grader entries are shaped once, M3, M4 and M5. Check
  the mail workflow's assumption (its services through imported modules, its day through a clock
  function, every agent in a sandbox, and what its sandboxes reach, for its `agentReach`). Then inspect
  the lab's run, store and load code; settle the new kind's folder, which shared files move, the
  helper process, the records and the commands.
- [x] Implement: only this task's change, with tests.
- [x] Review: architecture and scope; correctness and proof.
- [x] Resolve: disposition every finding.
- [x] Verify: the `Done when` items.

Work:

- Docs and schemas the move changes: `packages/lab/AGENTS.md`, the root `AGENTS.md` (boundary 5
  and the `packages/lab` row), and `packages/lab/schema/`, regenerated with
  `bun packages/lab/src/write-schemas.ts`.
- The structural moves in the Code map: the neutral command-line entry with each kind's flags;
  `bin` and the `./cases` and `./cases/fetch` exports; the shared folder; the runner's
  environment, the preloaded `awf` bin and working folder; the boundary rules.
- `@agentswf/lab/cases`: `defineEnv`, `c` with `mock`, `fake`, `http` and `cleanup`, the phase
  and the trial file (`AWF_LAB_TRIAL`), `observe` and the
  facts, unused mocks, the lab's `wf` (given stages and `until`, though only task 5's dataset uses
  them live); `dataset.json` with `sandbox`, `agentReach`, `pass`, `timeout`, `setupTimeout`, `keep` and `realHosts`; the case and key formats with `known-failing` and `pass`, and their
  checker; `case new`, which the first time also writes `awf-lab.json`, `dataset.json` and a stub
  `env.ts` for the person to fill in.
- The helper process for your checkout; the checks before the first trial; the plan and `--yes`.
- The case folder and the scratch folder, outside the repository; the marker and its search.
- The lock, the owner files, the store, numbered runs, `awf-lab runs`, partial runs.
- The trial and score records; the `expect` grader; trial outcomes, whose errors they are, and
  the provider retry as M3 allows.
- The case verdict, history, known-failing cases, `--failed`, the exit codes.
- `run` (`--dataset`, `--cases`, `--failed`, `--trials`; one trial unless told) and `report`, for a
  run and for one case (`--case`).
- The key reader reads and checks `must` and `must-not`, but they are not graded until task 3.
- In the mail project: the readers' working folder moves out of the repository; today's date
  through a `clock.ts` if it isn't already a function of its own; the `evals/` folder with
  `env.ts`.

Done when:

- M2's sketch and M3's to M5's answers are in Implementation notes, with what they
  changed.
- A test runs a small dataset end to end on scripted agents and gets the expected report.
- Tests of each case verdict and exit code: all passed (0); a must-pass case failed (1); 2 of 3
  passed with one failed, flaky (3); one undecided through a grader hook internal to the lab's tests (tasks 3 and 8 build the real
  interface), unclear (3); a workflow error on every trial,
  failed (1); a setup error on every trial (5); a stopped run, failed (1); a known-failing case failed (0), and one with a trial errored by the dataset (5), and passing at three
  trials (0, now passing); a `pass: 2/3` case with one failed trial passes; a missing `env.ts`
  refused (2).
- A test: `--failed` runs the cases whose newest verdict was failed, flaky or unclear, across
  runs, with that run's trial count.
- A test: `defineEnv` runs a workflow that has its own `file`; one with `events` is refused.
- A type test: an `env.ts` in a project whose installed `agentswf` is another copy than the
  lab's type-checks against its own workflow.
- A test on scripted agents: a strict mock refuses an export not given, and the trial errors as
  the dataset's, even when the workflow catches the throw; a `fetch` to a routed host that no
  route matches does the same, as does one to a host no route names, while one to a host in
  `realHosts` or the engine's own passes; a `c.fake` member not given is
  refused the same way; a mock or fake member never called is listed as unused; `observe` reads a
  mock's `.mock.calls`.
- A type test: `c.mock` with an export the module doesn't have, or a fake of the wrong shape, does
  not compile.
- A test on scripted agents: a two-stage workflow with the first stage given runs only the second;
  a given value its schema refuses errors the trial as the dataset's; `until` on the first stage
  completes the run with `observe` given that stage's value; a workflow that swallows the signal
  gets it again at its next stage and the run completes at `until`; a `wf.stop` after `until` is
  graded from the trial file; a misspelled stage name errors as `stage-missing` before the body
  runs; a body that returns early before `until` is graded on its result, noted "never reached".
- A test: a tool handler the workflow gives its agents calls a mocked module and gets the fake.
- A test: an error or a timeout in `setup` errors the trial as the dataset's, and in the body fails
  it as the workflow's; the trial file gives the lab the phase and the refused calls on a run that
  failed or timed out; a workflow that throws before `until` fails as the workflow's; a timed-out trial still runs `c.cleanup`; a strict-mocked module's class
  still works with `instanceof`; `c.mock` of a `node:*` module is refused; a `c.fake` returned from
  `async () => db` can be awaited; a type error in `env.ts` stops `run` with exit 2 before any
  trial; a grader that throws on every trial exits 5; the lab breaking mid-run exits 4; a fact
  `null` where the key wants a value fails, an `undefined` one errors as `facts-missing`, and one of another type
  errors as `fact-type`, as does an object, array or `Date` fact; facts written after a timeout are ignored; a key with an unknown
  field is refused; a run where no case is graded exits 3.
- A test: the lab starts the folder's own `awf` in that folder, and reads its runs back with
  `--run-root`.
- The review lab's tests pass with only their import paths changed, and `awf-lab` still runs a
  review dataset.
- A test: the lab copies neither `key.md` nor `key/` into either folder, a case folder holding the
  marker ends as leaked without running, and a scratch folder holding it after the run is leaked.
- A test: `case new` in a project with no `evals/` writes `awf-lab.json`, `dataset.json`, the stub
  `env.ts` and the case folder; `run` refuses the stub with exit 2, naming `env.ts`, and runs the
  case once the test fills in `workflow`.
- A test: `env.ts` run without the lab (no `AWF_LAB_CASE`) is refused with a message that says
  how to run it.
- A test: a dataset whose `sandbox` is anything but `"workflow"` is refused, and a `"workflow"`
  dataset runs a workflow that opens its own sandbox.
- A test: an agent opened with no sandbox, a sandbox whose `network` lists a domain `agentReach`
  doesn't, one with `webSearch` or sockets not allowed, and an agent in the run's turns with no
  `agent-opened` line, and a cursor agent where `webSearch` is false, each error the trial as
  `reach` (exit 5); a model domain the harness adds passes, and `*.x` covers `a.x`, not `x`. A dataset without `agentReach` is refused (2).
- The mail readers' sandboxes are checked to keep agents out of the home folder, the store and the
  project's `evals/`.
- Live: the mail dataset, three trials each, with the model's login
  (`CLAUDE_CODE_OAUTH_TOKEN`) in the operator's environment. Then a case added for a known miss
  fails the run (exit 1); after the workflow is fixed, `--failed` passes it and a full run exits 0
  or 3, with any flaky case read.

### 3. Criteria are judged

Outcome: `criteria` count in each case's verdict, judged by the lab's criteria judge, a grader
workflow on task 8's path. Comes after task 8 (2026-11-16: grader workflows and `score` moved
there, built against the review scorer first); its first part, a dataset's code graders, is done.

Execution:

- [x] Plan: the judge's prompt, from task 1's tuned part. The review judge's voting
  (`review/judge/voting.ts`) is built around finding labels, so the three voters are written
  fresh in the new folder, reusing only the shared runner and what task 8 settled for parts and
  votes. The judge reads its input through the grade folder and `gradeCase()` and puts what the
  voters need into their prompts. It runs on the lab's own `awf`, under a sandbox that reaches
  only its model, with its records in the store and its cost on the score entry. The reach check
  is for trials only: a grader's run is the lab's own, not graded.
- [x] Implement: only this task's change, with tests.
- [x] Review: architecture and scope; correctness and proof.
- [x] Resolve: disposition every finding.
- [ ] Verify: the `Done when` items.

Work:

- The criteria judge, its voters, majority and splits, and what it is given; the judge's
  version, its minor going up when its voters or prompt change (a `judgeAgent` change is
  detected apart, see `score`).
- For the live check, a script calls the judge directly on each of task 1's fixtures.

Done when:

- Editing a criterion and running `score` changes the report without a new trial, and judges only
  that criterion.
- A test: after `judgeAgent`'s harness or model changes, or the judge's minor version goes up,
  `score` judges every criterion of the trial again; a patch bump judges none; the new entry
  records the harness and model it used.
- A test: a trial `expect` failed skips the judge, shows its criteria "not judged", and `score`
  judges them after the key's `expect` is changed to pass; while `expect` still fails, `score`
  and a reused trial leave them "not judged".
- A test: no voter's prompt holds the marker, `expect`, `key/` or the agents' logs.
- A test: a 2–1 split decides by majority and is counted; a voter with no answer and the other two
  split leaves the criterion unsettled.
- The model-family table and the column mark.
- A test: a `judgeAgent` or judge prompt other than the one recorded from task 1 marks the judge
  "not checked against a person".
- Live: the mail dataset, three trials each, with criteria judged.
- Live: on task 1's held-out part, the built judge gives the hand-run judge's verdicts, except
  where voters split; any other difference is a bug, fixed before the task is done.

### 4. The same cases on code in another folder

Outcome: `awf-lab run --against {folder}` runs both folders in one run and reports them side by
side.

Execution:

- [x] Plan: the folder checks, as task 2 built them for one folder; the run record's folders.
- [x] Implement: only this task's change, with tests.
- [x] Review: architecture and scope; correctness and proof.
- [x] Resolve: disposition every finding.
- [x] Verify: the `Done when` items.

Work:

- `--against`, repeatable; trials in turn across folders; a column per folder; "also fails in";
  the exit code from your checkout alone.

Done when:

- A test on scripted agents: two folders whose workflows answer differently give two columns and
  list the case that came out differently; the other folder's cases, keys and graders are never
  read.
- A test: a folder without the dataset's `env.ts`, or without `@agentswf/lab/cases` or `@agentswf/lab/cases/fetch`, or an `awf` whose records the lab cannot read stops
  `run` before the first trial with exit 2, saying what is missing.
- A test: each folder's trials run on that folder's `awf`, started in that folder, at a different
  `agentswf` version from your checkout's.
- A test: a failing case in the other folder alone leaves the exit code 0.
- Live: the mail dataset in your checkout with a changed prompt, against a worktree of `main`.

### 5. web-to-cli's build runs on cases

Outcome: the builds dataset runs from real trials, one per case. It is the second real use of the
formats; reviews, the third, come before they become `/1`.

Execution:

- [ ] Plan: the build's `env.ts`; how `keep` reaches the judge; which of the build's stages a
  stage case gives; which hosts the build's own code reaches in its process (its `realHosts`),
  and which domains its sandbox opens (its `agentReach`); M1.
- [ ] Implement: only this task's change, with tests.
- [ ] Review: architecture and scope; correctness and proof.
- [ ] Resolve: disposition every finding.
- [ ] Verify: the `Done when` items.

Work:

- A `setup` that prepares a folder and an `observe` that runs what was built; `keep`; time by
  stage in the report; "read, not run" beside criteria judged from saved files.
- A second builds dataset of stage cases: an earlier stage given from a past run's value, `until`
  the stage under test.

Done when:

- A test: a criterion any voter judged from saved files is marked "read, not run".
- A test on scripted agents: `setup`'s `argv` and `process.env` reach the workflow, `observe`'s
  facts are graded by `expect`, and `keep`'s files are saved.
- A test: a `setup` that copies a key into the scratch folder makes the trial leaked.
- Live: two cases, one trial each, against a worktree with another builder model; about two hours
  and twenty dollars. One stage case, one trial. The person
  checks the judge's verdicts on these trials, since task 1 tested it on mail only, and the
  agreement is recorded in Implementation notes.
- The build's sandbox is checked to keep agents out of the home folder, the store, the
  project's `evals/` and the records folder.

### 6. A past run becomes a case

Outcome: `awf-lab capture {run id} --good` or `--needs-work "{note}"` makes a case from a past run
of the workflow, a trial's or a real one.

Execution:

- [x] Plan: confirm the shape below against both workflows' run records.
- [x] Implement: only this task's change, with tests.
- [x] Review: architecture and scope; correctness and proof.
- [x] Resolve: disposition every finding.
- [ ] Verify: the `Done when` items.

Work:

- Flags: `--dataset {name}` as for `run`.
- The run id is looked up first in the lab's store or records folder (a trial's run), then in the project's
  `.awf/runs` (a real one). A trial's run already has its case: `capture` copies the source case's
  own `files/` and `input.json`, skips `capture.ts`, and with `--good` drafts `expect` from the
  trial's stored facts.
- For a real run, `capture({ run, root })` from `capture.ts` is given the run's record (argv,
  result, and its logs folder) and the checkout. It returns one or more
  `{ name, input, files, facts? }`, one per case: `files` maps a path inside the case's `files/` to
  its contents; `input` becomes `input.json`; `facts` is what `observe` would have returned, read
  off that case's share of the result by the dataset's own code (`observe` needs a trial's mocks,
  so it can't run on a real run). A mail run that
  read five emails gives five cases, each fetched again by its email's id. A name already taken
  gets a number.
- `key.md` is written with `captured: { run, mark: good | needs-work, note }`, `draft: true` and a
  marker. With `--good`, `expect` is drafted from `facts`, leaving out `error`; facts `capture`
  can't tell are left for the person. A run that needed work is never the
  answer, so its key is the person's to write.

Done when:

- A run of each workflow becomes a case with one command, and that case runs.
- A test: a trial's run is captured from its source case without `capture.ts`; a name already
  taken gets a number; a captured key stays a draft, and no grader runs on it.

### 7. What reviews and the loop need, set against the design

Outcome: every feature of the review lab carried over, dropped or redesigned, with its reason,
and the design changed before any code. Done 2026-11-16.

- [x] Plan, implement, review, resolve, verify. The owner answered Q10 to Q14; the smaller
  choices and every feature's disposition are the table in Implementation notes ("Task 7: the
  review lab's features"), and the design sections say what they settled.

### 8. Grader workflows and `score`, built against the review scorer

Outcome: a grader can be a workflow, its parts and votes are stored, and `score` grades a kept
run again, with any grader, without running a trial. Comes before task 3, whose criteria judge
then runs on this path.

Execution:

- [x] Plan: the grade folder, `gradeCase()` and `previous.json` as the design gives them; the
  review scorer's match labelling ported as the first grader workflow, into autoresearch's
  `evals/air-1/graders/`; M2's shape for parts and votes.
- [x] Implement: only this task's change, with tests.
- [x] Review: architecture and scope; correctness and proof.
- [x] Resolve: disposition every finding.
- [x] Verify: the `Done when` items.

Work:

- Grader workflows in `graders/`, their run in the store and their cost on the score entry.
- `parts` and `numbers` stored and pooled into report rows.
- `score`: grading again by the rules in "Grading again", `onDemand` graders through `--grader`,
  the agreement row, its plan with `--yes`, `--dry-run`, `--budget`, and `--json` on `score` and
  `report`.

Done when:

- A test on scripted agents: a grader workflow is given its folder and `previous.json`, and its
  parts, numbers and cost reach the score entry.
- A test: `score` never runs `env.ts`; it grades again on a changed key digest or minor version,
  never a workflow-failed or draft trial; an `onDemand` grader runs only with `--grader` and
  never decides a verdict.
- A test: pooled numbers leave out workflow-failed trials and count them.
- A test: a grader that throws leaves the trial errored by grading, and `score` grades it again.
- A test on scripted agents: the ported match labelling, given the review scorer's votes, gives
  its labels and settlement.

### 9. Parameters, compared as columns, and trials reused

Outcome: `--param` and `--vary` run the cases under parameters `env.ts` reads (Q13); an
unchanged side reuses its stored trials (Q11), from one store per project with committable
records (Q12); a dataset's `compare` gives each column a verdict (Q14). Comes after task 4.

Execution:

- [ ] Plan: the reuse key and the files its digests cover, as "What is kept" gives them, named
  file by file; how parameters key history and the run record's columns; what becomes of task
  2's per-checkout stores; how autoresearch's variants map onto parameters.
- [ ] Implement: only this task's change, with tests.
- [ ] Review: architecture and scope; correctness and proof.
- [ ] Resolve: disposition every finding.
- [ ] Verify: the `Done when` items.

Work:

- `--param`, `--vary`, `c.params`, `AWF_LAB_PARAMS`, a column per combination.
- Reuse, `--fresh`, `reuseDays`; the store per project; `records`; shared files kept once.
- `run --budget`, `--dry-run`, `--json`; `report --md`.
- `src/compare` moved into the shared folder; `compare` with `better.paired`, `better.mean` and
  `defineComparison`, run in the helper process.

Done when:

- A test on scripted agents: `--vary` gives a column per combination, each trial recording its
  parameters and key; `--failed` and the exit code follow the reference column.
- A test: an unchanged run reuses every trial, a change to what shapes a trial runs new ones, and
  a key edit only grades again.
- A test: two worktrees share a store, and a fresh clone reuses trials from committed records.
- A test: `compare` gives a column's verdict as JSON; `run` still runs every planned trial.
- Live: refund-desk's `decide` over two models with `--vary`, then again, reusing every trial.

### 10. The `"lab"` sandbox

Outcome: `"sandbox": { "lab": "srt" | "docker" }` runs the whole trial in one box, with the
keys, the store and the home folder outside it, and the workflow's own sandboxes set aside
(Q10). Comes after task 9.

Execution:

- [ ] Plan: whether `awf run` works inside srt, else Docker first; the box holds the case and
  scratch folders and the code folder as the files the digest lists plus `node_modules` (no
  ignored file), without `.git`, any `key.md` or `key/`, the records folder or `hide`'s paths; a
  loop's try copy is mounted alone, writable, from the store (an awf sandbox can't be granted a
  path in `~/.awf`, so the proposer runs in the box too); the logins it carries in; where the model domains
  come from; whether `--jobs` becomes safe. If setting the workflow's sandboxes aside needs an
  engine change, stop and ask the person.
- [ ] Implement: only this task's change, with tests.
- [ ] Review: architecture and scope; correctness and proof.
- [ ] Resolve: disposition every finding.
- [ ] Verify: the `Done when` items.

Work:

- The box, made by the provider's own command-line tool (boundary 5); `hide`;
  `agentReach.network: "any"`; the reach check under `"lab"`.

Done when:

- A test: code and agents in the box cannot read a key (in a file or git history), an ignored
  file, the records folder, a path `hide` names, the store (other than a try's copy mounted from
  it) or the home folder.
- A test: the box reaches only `agentReach`, the model domains, `realHosts` and the engine's
  hosts; a workflow that opens its own sandbox runs with it set aside.
- Live: refund-desk's `decide` under `"lab"`.

### 11. A review dataset on cases, graded by the review scorer

Outcome: autoresearch's datasets run as cases: fixtures converted, the checkout restored by
`env.ts` from bundles in the dataset, findings graded by the review scorer with recall and
precision as numbers and a part per finding. Comes after tasks 8, 9 and 10.

Execution:

- [ ] Plan: the converter, which writes the history once as a shared bundle cut at the common
  ancestor of every case's base (holdouts included), each case's thin bundle carrying the rest;
  the review `env.ts`; the grader and its modules in `graders/`; air-1's `compare`; M6.
- [ ] Implement: only this task's change, with tests.
- [ ] Review: architecture and scope; correctness and proof.
- [ ] Resolve: disposition every finding.
- [ ] Verify: the `Done when` items.

Work:

- The converter and verifier, in autoresearch; the review `env.ts` under `"lab"`; the grader
  and the sanity workflows as task 7's table settles; holdouts in `dataset.json`; `hide` set.

Done when:

- Every autoresearch dataset converts and verifies, holdout included.
- A test: no case folder holds a commit beyond its base or head, and a grep of tracked files
  outside `evals/` for each key's text finds nothing `hide` doesn't cover.
- A test: `run`, `score` and `report` leave holdout cases out.
- Live: a few tuning cases, two trials each, on both labs with the same scorer; recall and
  precision agree within the review lab's own spread between trials.

### 12. The loop, for any dataset

Outcome: `awf-lab loop` on any dataset under `"lab"` with a `compare`: a proposer changes a
copy of the incumbent, the try runs against it case by case, is kept only when better, and the
final incumbent is checked once on the holdout. Comes after tasks 4 and 8 to 11.

Execution:

- [ ] Plan: story 013's loop on the new kind: the try's copy of the incumbent, kept in the store
  (the files the digest lists plus `node_modules`; no ignored file, `.git`, cases, records or
  hidden paths), the proposer in the box writing only that copy, the scope check (nothing
  under `evals/` changes), the domain-free bundle, the spend cap, the stall stop, resume.
- [ ] Implement: only this task's change, with tests.
- [ ] Review: architecture and scope; correctness and proof.
- [ ] Resolve: disposition every finding.
- [ ] Verify: the `Done when` items.

Work:

- `loop {name}` with `--program`, `--proposer`, `--rounds`, `--trials`, `--budget` (required),
  `--allowance`, `--yes`, `--json`; `--final`; the incumbent kept in the store and handed back as
  a patch.
- A refund-desk dataset with room to improve: more cases, a numeric grader, a holdout.

Done when:

- A test on scripted agents: a loop keeps a better try, drops a worse one, compares each try
  against the last kept one, stops at the cap with exit 3, and never shows the proposer a
  holdout case.
- A test: a try that changes anything under `evals/` is refused, and generated code reaches no
  key.
- A test: a loop stopped mid-try resumes.
- Live: a short loop on refund-desk, then one round on `air-1` under the cap the person sets.

### 13. The review kind retired, and the records made `/1`

Outcome: one kind of case. `review/` is deleted, `collect` and `draft-key` become autoresearch's
scripts writing cases, and the lab's records become `/1`. Comes after tasks 5, 6, 11 and 12.

Execution:

- [ ] Plan: what is deleted and what is copied into autoresearch first; which autoresearch
  scripts and todos change; what the docs and the site say.
- [ ] Implement: only this task's change, with tests.
- [ ] Review: architecture and scope; correctness and proof.
- [ ] Resolve: disposition every finding.
- [ ] Verify: the `Done when` items.

Work:

- Delete `review/`; one set of exit codes; retired commands and flags refused with what replaced
  them (task 7's table).
- `check-boundaries.ts` and boundary 5 for one kind.
- Records and `grade.json` at `/1`; `awf-lab.json` at `/1`, its converter refusing review fields.

Done when:

- A test: each retired command, flag and `awf-lab.json` review field is refused with its
  replacement.
- `check-boundaries.ts` passes with the one-kind rules.
- autoresearch runs on the new kind alone, its scripts included.

Tasks are checkpoints, not a file-by-file edit script. The implementation agent may adjust the
implementation without changing their outcomes, order, or the story's scope.

## Verification

Automated:

- [ ] A dataset runs end to end on scripted agents: trials, scores, verdicts, report, exit code.
- [ ] Two folders run side by side on scripted agents, each on its own `awf` (task 4).
- [ ] The lab copies `key.md` and `key/` into neither folder, and a leaked marker is caught.
- [ ] Until task 13, the review lab's existing tests pass, with only their import paths changed.
- [ ] `score` grades again on a changed key or version, and with an added grader (task 8).
- [ ] Parameters give columns, an unchanged run reuses its trials, and `compare` gives a
  verdict (task 9).
- [ ] Code and agents under `"lab"` cannot read a key (task 10).
- [ ] Every autoresearch dataset converts and verifies (task 11).
- [ ] A loop on scripted agents keeps a better try and never shows a holdout (task 12).
- [ ] Nothing reads or writes review-kind run records, and the lab's records are `/1` (task 13).
- [ ] `bun test`
- [ ] `bunx tsc --noEmit`
- [ ] `bun run scripts/check-boundaries.ts`

Manual or live evaluation:

- [ ] The mail dataset, three trials each: minutes, a few dollars with the judge.
- [ ] A case added for a known miss fails the run; after the fix, it passes (task 2).
- [ ] The builds dataset against a worktree with another builder model, and one stage case: about
  two hours and twenty dollars.
- [ ] The built judge gives the hand-run judge's verdicts on task 1's held-out part (task 3).
- [ ] The mail dataset with a changed prompt against a worktree of `main` (task 4).
- [ ] A real run of each workflow captured as a case, and that case run (task 6).
- [ ] `air-1` on both labs, with the same scorer, agreeing within noise (task 11).
- [ ] A loop on refund-desk, and one round on `air-1` (task 12).

## Review record

### Refinement

[[workflow-cases]] draft 1 had three reviewers (feasibility, an adversarial pass, prior art). This
story then went through about thirty rounds of review against the code, eval method, consistency
and a first-time reader. On 2026-11-14 the owner refocused it: running and scoring first, with a
verdict per case and an exit code; comparing became the same run on another folder, replacing the
comparison of kept runs, its store identity and its staleness rules. A best-practice pass over
current eval tools and writing supports the split. Three reviewers then read the refocused draft
(eval method, a first-time reader with a consistency check, feasibility against the code); their
findings brought the flaky verdict and history, the judge's majority, the workflow's errors
failing a case, the exit codes, `--failed` across runs, the plan before a run, cheap graders
first, and each folder's `awf` started in that folder. On 2026-11-15 the owner moved a case's world
into code, as a unit test's setup: after a study of agent-env and of how test tools fake services
(msw, Jest and Vitest mocks, record and replay, containers), and experiments on Bun with three
subagents (module mocks and their limits, mocks across processes, sandboxes, proxies and stage
seeding), `env.ts` replaced the variant, `setup.ts`, `read` and `check`, columns became folders
only, and given stages and `until` came in without an engine change.
Then ten rounds of two reviewers each (consistency, and design checked against the awf and
web-to-cli code with experiments on Bun) settled the blame rules (a refusal is the dataset's, a
forbidden call is a recording fake and a fact, blame by phase, the trial file), the clock
through the workflow's own function (`setSystemTime` freezes the engine), strict hosts with
`realHosts`, timeouts per phase, stopped and early-ended runs, exit 5, the type check, and
web-to-cli's build run from its copy. The tenth round still found one must-fix (a mock of the
checkout's module missing a workflow loaded from the copy), fixed. Later that day the owner dropped msw: the lab answers and
refuses `fetch` with its own replacement, so a project installs nothing for it, and a workflow
that uses another client fakes it by module or with a tool it installs. The owner settled Q9:
agents' own commands are not faked here; their reach is checked against `agentReach`. Three
more rounds of the same two reviewers followed: the eleventh and twelfth found must-fixes (the
lab's `fetch` installed by a preload, before anything captures it; `--no-env-file`, so a trial
never reads the folder's `.env`; sockets as reach; a stale rule on known-failing cases), all
fixed; the thirteenth found none.

Moving reviews and the loop onto this design, tasks 7 to 13, was added on 2026-11-16 and reviewed
by subagents: one for consistency, one for completeness against the review lab and the
autoresearch repository, then a round checking both. Their findings shaped task 7's inventory and
tensions, the task order and the Done when items.

## Readiness

- [ ] Outcome and boundaries are concrete.
- [ ] Relevant implementation, callers, and tests are mapped.
- [ ] Evidence and research support the proposed design.
- [ ] Expensive interface, record-format, and stage-gate decisions are settled.
- [ ] Tasks are ordered, coherent, and independently verifiable.
- [ ] Open questions are resolved or explicitly moved out of scope.

## Implementation notes

### Task 0 (2026-11-15)

The mail triage's evals are on `mini-workflows`' `evals` branch: `evals/school-mail/env.ts`, seven
cases (`trip-form`, `grade-3-only`, `fundraiser`, `picture-day`, `edsby-post`, `trip-moved`,
`newsletter`). Writing them changed this design: `c.fake` passes plain values through; `defineEnv`
takes no type argument (one given blocks the inference of `observe`'s result); a workflow module
already loaded before `setup` is refused; the refusal names `real`; criteria are two lists of
sentences; the judge reads the facts. The workflow gained `clock.ts`, and its readers' folder
moved to the temp folder.

### Task 2: plan (2026-11-15)

- ADR 0003 is amended (cases for a workflow live beside it), and `second-case-kind` (folded into tasks 7 to 13 since) is rewritten
  as "move reviews onto the case kind".
- Folders: `src/shared/` (`validate.ts` now; the runner's process seam and `awf-lab.json`'s common
  fields as they move), `src/cases/format/` (pure: `settings.ts` for `dataset.json` and `key.md`,
  `key.ts` the strict reader, `trial-file.ts`, `records.ts`), `src/cases/env/` (what runs in the
  trial's process: `@agentswf/lab/cases` and the `fetch` preload), `src/cases/lab/` (the lab's side;
  `expect.ts` and `verdict.ts` pure). `review/format/validate.ts` re-exports the shared checks, so
  no review file changes for the move.
- The store: `{store}/runs/{n}/run.json`; a trial at `runs/{n}/trials/{case}/{column}-{trial}/`
  with `trial.json`, `input/` (the built case folder), `kept/`, and `scores.jsonl` (every score,
  newest last); the workflows' runs under `{store}/awf-runs` through `--run-root`.
- Which kind a command is for: `case` and `runs` are the new kind's; otherwise `--dataset` names a
  folder of `evals/` holding a new-kind `dataset.json`, or, without it, the new kind when
  `awf-lab.json` has no review `datasets` and the review kind as today when it has.
- The helper process for `graders.ts` and `capture.ts` comes with task 3, its first user: task 2
  has no dataset code outside the trial's process to run.
- `expect` strings are quoted (the design's rule); the mail keys already are.

M2 (a review grader sketched as code and as a workflow, against a real trial; the sketch, which
does not ship, is in the session's scratch folder): the interface carries the review scorer with
these changes, taken into `records.ts`:

- A part has a `label` and `data` beside its verdict (a finding is `hit`, `wrong`, `noise`…), a
  `why`, and `settled` (`agreed`, `majority`, `tiebreak`, `unsettled`, `given`), which also
  carries the judge's 2–1 mark; votes have a shape (`by`, `role`, `verdict` or `label`, `why`).
- A number is `{ count, of }`, summed per column (`of: 0` is none in this case, adding nothing),
  or `{ value }`, shown as a median.
- A grader may answer "does not apply" with a reason (`notApplies`), neither a verdict nor
  numbers; an empty answer stays grading's error.
- A score entry keeps `models` (a grading can use several), `ms`, and its errors' `problems`.
- For task 8: a grader workflow gets an empty working folder of its own (`--cwd`), and may be
  given its previous parts and key digest, so a key edit judges only what changed.
- For the reviews' move (tasks 7 to 13), not now: grading a run the workflow failed (the review counts its recall
  as 0), and a key digest limited to the files a grader reads. Graders identified by a version
  instead of a code digest came early, with the code graders (2026-11-16).

M3: nothing in a run's records tells a provider's stop from the workflow's own failure. The ending
is an outcome and free text; a turn's `retryable` and `login` never reach the attempt record, and no
harness detects a rate limit or an overload. Text matching is unsafe: web-to-cli's own stops say
"sign in again" and "page budget … spent". So every failed run is the workflow's, as the design's
fallback says, with one exception the runner already makes: a run refused at its first agent for a
missing subscription login, with no agent opened, is the engine's fixed text, and errors the
trial as the provider's (code `login`), tried once more. A `cause` on the attempt record would make
the rest readable; that is an engine story of its own.

M4 (a wrapper workflow running another's body, tried on the repo's engine; the probes are in the
session's scratch folder):

- `prepare`, stages through `Object.create(wf, { stage })`, a given value, a given value its
  schema refuses, and `until` all work; so do `wf.sandboxes.open`, `wf.agents.open` and a live
  codex turn in an srt sandbox through the wrapper, with `sandbox-opened` and `agent-opened` lines
  the reach check reads. The engine's context methods are bound, so `this` is never a problem.
- A given value its schema refuses fails the stage with a plain `Error`; `defineEnv` knows it is
  the dataset's because it gave that stage. A stage with no result is `undefined`, which a run's
  value refuses, so `stages` leaves it out.
- A given value replaces the whole work a workflow's helper passes to `wf.stage`, its side effects
  too (web-to-cli's ledger update): a case that gives a stage gives up what that stage's helper
  does around it.
- **Changed:** the engine's `--timeout` sends no signal: it abandons the body and exits after its
  2 s grace, so only a synchronous `exit` handler runs. `defineEnv` therefore times every phase
  itself, the body's limit included, and also stops short of `wf.deadline` by a margin, so its
  teardown runs before the backstop; a SIGTERM handler covers a cancel (about 2 s), and an `exit`
  handler writes "timed out" to the trial file as the last resort.
- web-to-cli's build imported from a copy loads with the copy's own dependencies, and its stages
  reach the wrapped `stage` through its helper; `agentswf/workflow` and `typebox` are the running
  engine's whatever copy imports them, a linked lab's included.
- **Changed:** so the lab works only on an engine whose author surface it was written for. The
  check before the first trial reads the folder's `agentswf` version and refuses one below 0.1.1
  (exit 2): beta.2 has no `defineWorkflow` and no `--quiet`, and keeps other record files. The mail
  project moved to 0.1.1 (the person, 2026-11-15).
- Sandbox homes are kept in `~/.awf/sandboxes/{workflow}/{run}`, outside `--run-root`, as for any
  run; the lab leaves them to the engine.

M5: from inside the folder, `bun --no-env-file --preload {fetch} node_modules/agentswf/src/awf.ts
run … --cwd {scratch} --run-root {store} --json` runs in one process (no hand-over), the preload's
`fetch` answers the workflow's, and `awf logs --run-root` with the same bin reads the run back. The
repo's 0.1.1 bin started in a beta.2 folder hands over, and the preload is lost, as the design
expects. `--quiet` still prints the ending block to stderr for a run that fails; the lab reads
stdout only.

### Task 2: correctness review, fixes (2026-11-15)

- **The lab's own errors**: a trial the lab can't read whole is errored `by: "lab"` and never
  graded: a run record of another version, a trial file line that fits no shape, `awf logs` that
  can't be read whole, a run with no folder under `--run-root`. Any such trial makes the exit 4,
  ahead of every verdict, as the lab breaking mid-run does.
- **A cancel** (SIGTERM or SIGINT) writes `cancelled` in the trial file, runs teardown and ends the
  trial, so nothing reads as timed out; blame makes a cancelled run the lab's, from that line or
  from the engine's `cancelled` outcome alone, since no one's code decided its ending. An exit
  before the trial ended and short of the run's deadline (`process.exit`, a crash) writes `exited`,
  and blame reads the run's own ending.
- **Blame**: the first dataset error wins over the first workflow error, whatever their order.
- **The version**: `MIN_AGENTSWF` is a constant, 0.1.1. Before the first trial the folder's `awf`
  runs a do-nothing workflow in a temporary folder inside it, and a record version other than
  contract's `OUTPUT_RECORD_VERSION` stops `run` (exit 2), naming both.
- **The marker search** reads `awf logs --json` once without `--after`, with a `--limit` past any
  run, the documented newest-N form, failing closed when the page says older events were left
  out; it also reads every file of the run's folder under `--run-root`. A string of an agent's
  native text past `awf logs`' 50 000 characters is cut there and not searched past it.
- **The code folder** is the nearest folder at or above `evals/`'s parent holding
  `node_modules/agentswf`; the repository's top is only for git state and the store check.
- **Symlinks**: a case's or the dataset's `files/` and `key/` holding one is refused (exit 2); the
  marker search follows them, each folder once; `keep` copies a link's file, and never a path
  outside the scratch folder (`..` in `keep` is refused when the dataset is read).
- `dataset.json`'s `graders` is refused until task 3. `c.fake<T>(fakes, { name })`.
- A tool handler calling a mocked module needs a live agent, as a tool runs only when an agent
  calls it and `awf run` has no scripted harness: `tests/lab-cases.eval.ts`, one claude haiku
  agent in srt calling a `lookup` tool whose module's real export throws. Live 2026-11-16: the
  handler got the fake, called once, passed in 5.6 s, ~$0.002.
- The type test that a project with its own copy of `agentswf` type-checks needs the project's
  workflow test (`agentswf/testing`) beside its `env.ts`, read after it: TypeScript 5.9 takes two
  packages of one name and version for one, and mixes their types only then.

### Task 2: departures from the design, and checks (2026-11-16)

- **`observe`'s `result` is typed `Result`**, never `Result | null`: for an async `setup`,
  TypeScript can't pick a union member by whether `until` is returned, and `result` came out
  `any`. Under `until`, the author annotates `observe(result: Result | null)`. A wrong read there
  throws in `observe`, the dataset's error.
- **`Facts` admits `undefined` in its type**, so facts from different branches compile; at run
  time an `undefined` fact is still `facts-missing`.
- **`defineEnv` requires `agentswf/workflow` at run time instead of importing it**: found live,
  linking the lab into the mail project made the project's own `tsc` fail. TypeScript took the
  lab's `agentswf` and the project's, of one name and version, for one package and mixed their
  types. A test builds a project with its own copy and type-checks it.
- **`awf-lab.json` is also found in `{folder}/evals/`** at each level up, so `awf-lab run` works
  from the project's root; the review kind's lookup is unchanged, and the entry routes such a file
  to the case kind.
- **A trial record holds no outcome**: it is computed from the record and each grader's newest
  score entry, so it never goes stale after `score`.
- **Trial files live in `~/.awf/lab/trials/` while a trial runs**, named by the lab's process, and
  move into the trial's folder after; a dead lab's are swept at the next start.
- **History and `--failed`** recompute earlier verdicts with the keys' current `pass` bars.
- **`setupMs` is not recorded**: the trial file's lines carry no times.

Checks:

- The mail readers' sandboxes (srt, `write: []`, `network: []`): the srt profile denies reading
  the home folder (which holds the store and the project's `evals/`), the temp folders and the run
  root, and allows back only the reader's own folder under the system temp; so a reader sees
  neither the store, `evals/`, nor the lab's case and scratch folders
  (`packages/sandbox/src/srt/profile.ts`).
- Live, the mail dataset, three trials each (run 2, and run 3 after the review fixes): 21 trials,
  median 9 s and an estimated $0.003 a trial, $0.06 in all; 5 cases passed, `trip-form` and
  `trip-moved` failed 0/3, each on `short: true` where the key wants `false`; exit 1. Nothing
  errored, leaked or was refused, and every reader's reach passed.
- The known miss, live: the person judged the workflow right on both trip emails (short enough to
  read as is), so their keys now expect `short: true` and `reply: null`, and their criteria judge
  the week's note, a new `note` fact (the reader's summary and actions, kept whether or not a
  summary goes out). `--failed` then ran those two cases at three trials each and passed them
  (exit 0, run 4), and a full run passed every case (7 of 7, 21 trials, exit 0, run 5).
- Task 2 reviews: architecture and scope (2 must-fix, 7 should-fix), correctness and proof (2
  must-fix, 7 should-fix); every finding fixed with a test that fails before it, except a tool
  handler's mock (above). Recorded in the previous section.

### Task 3, first part: a dataset's own code graders (2026-11-16)

Built ahead of the rest of task 3 at the person's request: the `refund-desk` example needed a
grader of its own, and this part doesn't wait on task 1's judging.

- `defineGrader({ grade, readsFacts?, version? })` from `@agentswf/lab/cases`; `dataset.json`'s `graders`
  names exports of the dataset's `graders.ts`. A grader workflow (`{ "workflow": … }`) is still
  refused, and so are `expect` and `criteria` as names, a name that is no export name, a name
  given twice, and `graders` without a `graders.ts`.
- Each grader runs in a Bun process of its own started in the code folder (your checkout; task 4
  keeps it there for an `--against` column, and task 12 for a loop's copy)
  (`cases/env/grade-helper.ts`), exchanging JSON files with the lab, so dataset code never loads
  into the lab's process. Its output goes to a file, not a pipe, so a process it left running
  can't hold the lab after the kill. A throw, an answer the entry schema refuses, an answer with
  no verdict, numbers or `notApplies` (or `notApplies` beside either), a missing export, or a
  grader slower than `setupTimeout` errors the trial by grading. Its environment is the trial's:
  the lab's, without the calling session's variables.
- It is given the case (name, built folder, input, key without its marker, and its `key/` folder
  when it has one), the result, the scratch folder and the folder the `keep` paths were saved to;
  with `readsFacts`, the facts and the stages' values. It returns `verdict`, `numbers`, `reasons`
  and `notApplies`.
- A grader is identified by a version, not a code digest, as the review kind's variants and
  scorers are (`shared/version.ts`, moved there from `review/lab/version.ts`): `defineGrader`'s
  `version`, semver, `1.0.0` when left out, stored on every entry; `expect` is `1.0.0`. Grades
  belong to its `{major}.{minor}`, so `score` will grade again on a minor bump and keep grades
  across a patch. A digest of `graders.ts` would have missed edits to what it imports, and the
  person decided a declared version is the rule. The entry's `code` field is gone; scores stored
  before it no longer read (beta, no migration).
- Code graders run after `expect`, every trial, even when `expect` failed: they are cheap. Pooled
  numbers in the report, `score`, grader workflows and the criteria judge are still task 3's.
  (2026-11-16: `score`, grader workflows and pooled numbers moved to task 8, which comes before
  task 3.)
- Reviewed by two subagents, architecture and correctness, and the example's grader as a reader.
  No must-fix. Fixed: a grader's grandchild held the stderr pipe past the kill (verified hang of
  20 s on a 3 s limit); empty or contradictory answers were stored; `key/` and `kept` weren't
  given; the calling session's variables reached the grader; untested claims. The example's first
  motivation was wrong: a $54 payout already fails `expect`, so the grader now checks a rule that
  holds on every case. The digest became a declared version, above.
- Proof: `code-graders.test.ts` (input, `readsFacts`, `notApplies`, each error, a lingering
  child, the digest); in `cli.test.ts`, a grader failing a trial `expect` passed, graders run
  after `expect` failed and under `setupTimeout`, and the refusals. Live, the example's
  `refunds` dataset with `replyStatesRefund`, three trials each: 9 passed, the grader's reasons on
  every trial and "nothing was refunded" on the declines (run 7).

## Human review

- [ ] Every task is complete and story-level verification passes.
- [ ] Set the story status to `awaiting-human-review` and present the outcome, architecture
  decisions, task-level subagent findings and dispositions, exact verification results, deviations,
  and remaining risks.
- [ ] Record the human's explicit approval or requested changes here.
- [ ] If changes are requested, return to the affected task and repeat its review and verification.
- [ ] Only after explicit approval, mark the story `done` and update `Stories at a glance`.

### Task 7: the review lab's features, carried, dropped or redesigned (2026-11-16)

Q10 to Q14 are the owner's; the rest follow from them and the design, settled here.

| Review lab | Here | Task |
| --- | --- | --- |
| Variants: a workflow module, argv, version, timeout, `read` | Redesigned: parameters `env.ts` reads (Q13); `read` is the review `env.ts`'s or grader's code; one `timeout` per dataset; no versions, a digest | 9, 11 |
| Scorers: a judge workflow with argv and a version | Redesigned: a grader workflow with its `meta.version`; a scorer's argv becomes the grader's own code | 8, 11 |
| `--rest-from`, `--settled` | Dropped as flags: a grader workflow is given its previous parts (`previous.json`) | 8 |
| The lab's label check (`checkScorerResult`) | Moved into the review grader | 11 |
| Two scorers' agreement in `report` (how alike they label) | Carried: `score` with an added grader or `--grader`, and a report row of agreement by verdict and by part label | 8 |
| Sanity workflows: no-op, cited comments | Carried as review workflows picked by a parameter | 11 |
| The oracle, which reads the key | Redesigned: an autoresearch script that runs the review grader's labelling on the key's own issues, as its judge tests do (`scorers/judge-testing.ts`), outside the lab | 11 |
| Fixtures: `fixture.json`, `snapshot.bundle`, `request.md` | Converted into cases; the checkout restored by the review `env.ts` from the dataset's shared history bundle, cut at the common ancestor of every case's base, and the case's thin bundle | 11 |
| Sealing and verifying a set | Moved into the autoresearch repository with the converter, which verifies each converted set | 11 |
| `collect`, `draft-key` | Moved into the autoresearch repository as scripts writing cases | 13 |
| Keys: `key.json`, revisions, `fixes.bundle`, `evidence/` | Carried in the case's `key/`; the review grader reads them | 11 |
| The contained run (Docker) | Redesigned: `"sandbox": { "lab": … }` (Q10) | 10 |
| The open network a reviewer keeps | Carried: `agentReach.network: "any"` | 10 |
| `--jobs` | Weighed in task 10's plan, safe only once no agent reaches a grade folder | 10 |
| Allowance waiting | Carried for `loop`, whose runs are long: it waits while a plan window it draws on is nearly used | 12 |
| The budget and its stop | Carried: `run --budget {usd}`, exit 3 as partial; the loop's spend cap | 9, 12 |
| `--dry-run` | Carried: `run --dry-run` prints the plan, with `--json` | 9 |
| `--cases` with a seeded order (`--cases {n}`) | Dropped: `--cases` takes names; autoresearch's scripts name their cases | — |
| `--only` down to one finding, `--where` and its predicates | Dropped: `--cases` and `--failed` select; a finding is a part in a score, read with `report --case` | — |
| Holdouts refused by every command | Carried: `holdout` in `dataset.json`, `--final` alone runs them | 11, 12 |
| `--baseline`, `*.compare.ts`, the sequential stop | Redesigned: the reference column and `compare` (Q14) | 9 |
| `check`: headroom, variance, resolution, `--rescore` | Dropped here; [[comparison-efficiency]] holds it | — |
| `show` and its addresses | Carried as `report --case` | 2 |
| `report --md`, which experiments paste | Carried: `report --md` | 9 |
| `--categories`, metrics by severity, category and source (`REVIEW_METRICS`, `recall.weighted` primary) | Redesigned: the review grader's numbers named as `REVIEW_METRICS` names them, and by category and source, pooled per column | 11 |
| `list [datasets\|cases\|variants\|scorers\|comparisons]` | Dropped: datasets and cases are folders, variants are parameters; `runs` lists runs | — |
| `--scorer {name}` on every command; a scorer applied on demand | Redesigned: `score --grader {name}` grades kept trials with a grader listed `"onDemand": true`, which never runs on trials | 8 |
| `awf-lab.json`'s `scorer`, `trials`, `budget.usd`, `seed` | Dropped: graders are `dataset.json`'s, `--trials` defaults to 1, `--budget` is a flag, no seeded order (a loop's try order is task 12's) | 9, 12 |
| `awf-lab.json`'s `sandbox: { "srt": {} }` or `{ "docker": … }`: every agent in the lab's own sandbox through `awf run --sandbox` | Redesigned: `"lab"` (Q10); review datasets, whose workflows open no sandbox of their own, require it | 10, 11 |
| `comparisons` (globs of `*.compare.ts`), the config's `comparison` and `baseline`, `--comparison {name}` | Dropped: one `compare` export per dataset; the reference column replaces `baseline` | 9 |
| `RENAMED_FLAGS`, `RENAMED_COMMANDS`, `RENAMED_CONFIG_KEYS`: old names refused with what replaced them | Carried: every retired command and flag is refused with its replacement: `show` → `report --case`, `list` → `runs`, `--scorer` → `score --grader`, `--baseline` → the reference column, `--comparison` → `compare` in `graders.ts`, `--rest-from` → a grader's previous parts, `--categories` → the grader's numbers, `--source` → the loop's scope check, `--allowance` on `run` or `score` → `loop --allowance`, `--jobs` → per task 10's plan; `check`, `--rescore`, `schema`, `--only`, `--where` → dropped. The old renamed-name maps (`--set`, `--fixtures`, `--judge`, `--base`, `--repeats`, `--judge-only`, `config`, `plan`) are dropped with the review kind they belonged to, and so is the config-key map (`sets`, `set`, `scores`, `judges`, `judge`): at `/1`, `judge` is an unknown key | 13 |
| `awf-lab.json`'s `results`, `variants`, `scorers`, `holdout` | Redesigned: `results` → `records`; `variants` → parameters; `scorers` → `dataset.json`'s `graders`; `holdout` → `dataset.json`'s `holdout` | 9, 11 |
| `awf-lab.json`'s `datasets` | Dropped: a dataset is a folder of `evals/` | 2 |
| `awf-lab.json`'s `runs` | Dropped: the store's `awf-runs`, through `--run-root` | 2, 9 |
| `awf-lab.json`'s `clone` | Redesigned: the converter writes the clone's history once into the dataset's shared `files/` as a bundle; no clone at run time, and no local path in a trial's parameters or reuse key | 11 |
| `awf-lab.json`'s `dataset`, the default dataset | Dropped: with one dataset none is named, otherwise `--dataset` | 2 |
| `--cases` taking globs | Dropped: `--cases` takes names | — |
| `{name}@{version}`, a stored version of a variant or scorer | Dropped: a run is addressed by `report {id}`, a variant by its parameters, a grader's grades by its version in each entry | — |
| autoresearch's tracked old data (`datasets/` with its keys, `results/`, `reports/`, and `docs/` and `lenses/README.md`, which quote key issues) | Kept, frozen, as decided for old runs; `awf-lab.json`'s `hide` keeps it out of the box, the loop's copy and the digest | 10, 11 |
| autoresearch's `canary/` (story 013's probe of what a contained run reaches) | Dropped: task 10's tests check what the box reaches; task 13 removes it from autoresearch | 10, 13 |
| `--config {file}` | Carried: the new kind has it since task 2; the settings in `awf-lab.loop.json` become the dataset's `sandbox` and `loop`'s flags | 2, 12 |
| `score --dry-run`, `--budget`, `--yes` | Carried: `score` prints its plan, with its cost estimated, and asks at a terminal, with `--yes`, `--dry-run` and `--budget`, since grader workflows and the judge cost money | 8 |
| Judge-quality scripts (`scripts/judges.ts`, `held-out.ts`, `match.ts`), reading stored review trials | Moved onto new-kind score records (parts with labels per grader), the oracle script giving their oracle input | 11, 13 |
| `schema` | Dropped: the records' schemas ship in the package | — |
| Results committed in the repository, trials pooled across days | Redesigned: `records` and reuse (Q11, Q12) | 9 |
| A try named by its code, its trials counted again | Carried: the digest key (Q11) | 9, 12 |
| The loop: `loop {name}` (named, resumed by name), `--baseline` (now your checkout), `--source` (now the scope check), `--program`, `--proposer`, `--rounds`, `--allowance`, bundle, scope check, incumbent, keep on better, stall, spend cap, resume, `--final` | Carried onto the new kind, tries under `"lab"` and kept by `compare` | 12 |
| Exit codes: 3 a budget stop, 4 a declined plan | Redesigned: 3 a budget or cap stop (partial), 2 a declined plan; 4 stays the lab's own breakage | 9, 12, 13 |
| The ~20 internal modules autoresearch imports | Copied into the autoresearch repository as its own code, or replaced by `@agentswf/lab/cases` | 11, 13 |

### Task 8: plan (2026-11-17)

- **`dataset.json`'s `graders`** takes three forms: `"name"` (a `graders.ts` export),
  `{ "grader": "name", "onDemand": true }`, and `{ "workflow": "graders/{path}.ts", "readsFacts"?,
  "onDemand"?, "timeout"? }`; a workflow's `timeout` is its run's limit, the dataset's `timeout`
  when absent. Names are unique across both kinds.
- **The grade folder**, made in the trial's parent folder (under `score`, a fresh one under the
  system's temporary folder) and deleted after: `grade.json` (`kind: awf.case-grade/0`, the case's
  name, `scratch` or `null`, `params`, `readsFacts`), `case/` (the built case folder), `key.json`
  (the key without `marker`), `key/`, `result.json`, `facts.json` (only with `readsFacts`), `kept/`,
  and `previous.json` (`{ key, parts }`) by the rule in "Grading". `gradeCase()` reads it into the
  same shape a code grader is given, plus `params` and `previous`.
- **A grader workflow's run**: your checkout's `awf run {file}`, without the `fetch` preload, with
  `--cwd` an empty folder of its own beside the grade folder, `--run-root` the store's `awf-runs`
  and `AWF_LAB_GRADE` in its environment. Its value is checked as a code grader's answer is, with
  `parts`; its version is the module's `meta.version`, read by the grade helper (which also gives
  code graders' versions to `score` without grading). Its entry keeps its run's id, models, time
  and estimate.
- **Order**: `expect`, code graders, grader workflows; a grader workflow is `skipped` when an
  earlier grader failed the trial. Code graders may return `parts` too.
- **The key digest** for a dataset grader covers the key without `marker` and each `key/` file's
  digest, so a `key/` edit grades again and a marker change does not.
- **An `onDemand` grader's entry is marked `onDemand`**, so the verdict leaves it out whatever
  `dataset.json` says later.
- **`score [{n}] [--grader {name}] [--yes] [--dry-run] [--budget {usd}] [--json]`**, under the
  lock: a plan of (trial, grader) pairs by "Grading again", priced from the grader's earlier
  entries; cheap graders first, then the costly ones, skipped again when the trial now fails a
  cheap one; one new score record per trial graded. `--budget` stops before a costly grader once
  the graded ones' estimates reach it, and the exit is 3. A trial whose built case no longer
  matches its `input` digest is left, and the plan says to run it again.
- **Report**: a dataset grader's numbers pooled per column (counts summed, values as a median),
  leaving out trials the workflow failed and saying how many; an agreement line for two graders on
  the same trials (verdicts, and parts' labels matched by `about`); "N grades out of date: awf-lab
  score {n}" when `score` would grade something. `report --json` and `score --json`.
- **autoresearch**: in a worktree of its own (`../worktrees/autoresearch-workflow-cases`, branch
  `workflow-cases`), since its main checkout has another session's changes. `evals/air-1/graders/
  match.ts` is `match-sonnet` as a grader workflow: it reads `key/key.json` and the case's
  `fixture.json` and `request.md` (the layout task 11's converter will write), takes the findings
  from the result, and returns a part per finding (its label, `data` with the issue or finding it
  names, the votes) and `REVIEW_METRICS`' numbers as counts. Its test is `match.workflow.test.ts`'s,
  on a grade folder.

### Task 8: departures, review and checks (2026-11-17)

- **Who decides is read, not stored.** A grade keeps no `onDemand` flag. The graders that decide a
  case are computed on every read from the current `dataset.json` and key: `expect` when the key
  has values, and each dataset grader not marked `onDemand`. A grade by any other grader (one
  removed, one made on demand, an `expect` taken out of the key) is shown, marked "not in the
  verdict", and never decides. Putting a grader back makes its grades decide again without
  grading.
- **One rule for grading again** (`staleBecause` in `grading.ts`): no grade, an errored one, a
  changed key digest, or a changed `{major}.{minor}`. One rule for `previous.json`
  (`previousFrom`). Each grader carries its declared version, read before the first grade; a
  dataset grader that doesn't load, or a grader workflow sharing a `graders.ts` export's name,
  stops `run` and `score` with exit 2.
- **A grader workflow skipped before** is planned by `score` only while what stands no longer
  fails the trial. When cheap graders are being graded again, it is a "maybe", listed as "if the
  cheaper graders now pass" and priced "up to".
- **`--budget`** is checked before every grader workflow with the grades made so far, on the same
  trial too. A stop exits 3, unless the report already exits worse (1, 4 or 5).
- **The agreement line** is shown for two graders that judged the same parts (matched by
  `about`), and for a grader set aside (on demand, or no longer deciding) against each deciding
  grader but `expect`. `expect` beside a tone grader agrees by chance and says nothing.
- **`report --json`** (`awf.case-report/0`) and **`score --json`** (`awf.case-scored/0`) are
  checked against schemas before printing, published with `grade.json` and `previous.json`'s in
  `schema/`. `score --json` still asks at a terminal, on stderr.
- **`report`** says when it couldn't check for grades out of date, rather than leaving the line
  out, and builds each case once for its digest.
- Code graders are given `params` too (`{}` until task 9, which fills both paths).
- **The ported review grader** (autoresearch's `evals/air-1/graders/match.ts`) builds on the
  lab's current `review/judge` modules (`matching`, `voting`, `check`) and `review/metrics`;
  task 11 copies them into autoresearch before task 13 deletes `review/`. Its voters' working
  folder is empty until task 11's grader restores the checkout there. autoresearch's own old
  scorers still call engine APIs that are gone (`isAnswered`, `defineExecutableWorkflow`);
  another session's uncommitted changes in its main checkout migrate some of them, so this work
  is on its `workflow-cases` branch, in `../worktrees/autoresearch-workflow-cases`.

Reviews: architecture and scope (one must-fix: the stored `onDemand` flag froze who decides; six
should-fix and nits: `report`'s cost and silence, the rules duplicated in two closures, no
schemas for the JSON outputs and grade files, the agreement rule, `params`, the grade folder's
name), correctness and proof (no must-fix; four should-fix: a removed grader's or `expect`'s
grades still deciding, `--budget` not stopping between two grader workflows of a trial,
`score --json` not asking, a skipped grader planned and priced when it would be skipped again;
nits: agreement counts lost, a workflow and an export sharing a name, an `expect` error counted
as graded). All fixed, each with a test, except the budget's exit staying 1 or 5 when the report
exits worse, recorded above.

Checks:

- `bun test packages/lab`: 324 pass. autoresearch's `evals/air-1/graders/match.test.ts`: 5 pass on
  scripted agents (Jev settles sure matches; a voter labels the rest, handed back once on an
  issue already hit; recall and precision as counts; a withheld vote fails the grade; an empty
  review).
- Live, refund-desk's `refunds` with a new grader workflow, `graders/tone.ts` (three Haiku voters
  on whether the reply is courteous): run 3, 3 cases passed, grading est. $0.02 beside the
  trials' $0.006. The tone grader's minor bumped to 1.1.0: `report` said 3 grades out of date,
  `score --dry-run` priced them at $0.02 from earlier grades, and `score` graded only `tone`
  again on the three trials, exit 0. `srt` is installed under Node 22.20.0 only, while mise now
  selects Node 24, so the runs put Node 22's bin first on `PATH`.

### Task 3: the criteria judge (2026-11-17)

Built before task 1's decision, at the person's request to implement the remaining tasks; task 1
can still drop it. Its prompt is written fresh, not tuned on task 1's emails, so `JUDGE_CHECKED`
is unset and every report says "not checked against a person". Verify stays open for the two
checks that need task 1: the held-out part, and recording the checked prompt and agent.

- **Where it lives**: `src/cases/judge/criteria.workflow.ts`, a workflow the lab's own `awf` runs
  (`--harness`, `--model` from `judgeAgent`), importing `agentswf/workflow` (a dev dependency of
  the private lab; a runtime one when the lab is published) and its own folders; `version.ts`
  holds `JUDGE_VERSION` and `JUDGE_CHECKED`, which the lab reads without loading the workflow. It
  is the grader named `criteria`, in `lab/criteria.ts`.
- **Its key digest is the criteria alone** (each as `{field}: {text}`), not the whole key with
  `key/` as a dataset grader's: an `expect` or `key/` edit never runs it again. Graders gained
  three seams for it: `keyOf` (the digest), `appliesTo` (it grades only keys with criteria; no
  entry otherwise, unlike `notApplies`, which a dataset grader answers itself), and `agent`.
- **A grade records its `agent`**: the configured `judgeAgent`, which `staleBecause` and
  `previousFrom` compare, so a new judge agent judges every criterion again with no earlier parts.
  The models the run used are in `models`.
- **Its grade folder holds the criteria alone**: `key.json` with `kind`, `must` and `must-not`,
  no `expect` and no `key/`. The voters' working folder sits beside it; srt's profile denies the
  temporary folders, but nothing in the grade folder is more than the voters are shown anyway.
- **Voters**: three per criterion, each given that criterion alone, the result, the facts and the
  stages' values in the prompt, and a folder of the case's files (`case/`) and the trial's saved
  ones (`saved/`); in srt, writing nothing and reaching only their model; two criteria at a time.
  A voter that says nothing is no vote; one that timed out or failed errors the judge's run, so
  the grade is grading's error and `score` judges it again, never an `undecided` that stands.
- **Settling**: two of three, or two of two answering, decide; anything less is `unsettled`, the
  criterion `undecided`. The judge fails when any criterion failed, else is undecided when any is,
  else passes. A criterion any voter judged from `saved/` carries `readNotRun`.
- **`previous.json`**: a criterion whose text is unchanged keeps its earlier part, unless it was
  unsettled; only changed or new ones are judged.
- **The report**: `criteria judged N` with `split 2–1`, `unsettled`, `read, not run` and `not
  judged on N trials a cheaper grader failed` when not zero; `judge: {harness}/{model}`, "not
  checked against a person" unless every grade that judged matches `JUDGE_CHECKED`'s agent and
  `{major}.{minor}`; the family mark (`families.ts`, by model id, or by the harness for an alias
  such as `sonnet`) against the models of your checkout's column, per column once task 4 adds
  columns.
- **Also here, found live**: the mail project's store held runs written before task 8's score
  shape, and history stopped every new run on them (exit 4). A record that fails its schema or
  isn't JSON (`UnreadableRecord`) now leaves its run out of history, the estimate and `--failed`;
  `runs` names it with the first problem, and the report says how many runs history left out.
  Any other error still stops the command.

Reviews: architecture and scope (no must-fix; should-fix: the departures above unrecorded, the
grade folder beside the voters holding `expect` and `key/`, the unreadable-run catch swallowing
every error and silent in the report, a `PATH` override for the judge pointing at the repo's
`node_modules/.bin`, removed; nits: the checked mark comparing exact versions, no cap on voters,
the README), correctness and proof (no must-fix; should-fix: a skipped or errored trial marking a
checked judge unchecked, the recorded-check branch untested, a timed-out voter leaving a lasting
`undecided`; nits: aliases and the family table, the unsettled reason's wording, a zero count
shown). All fixed with tests, but two proofs left to the shared mechanism: the judge's minor bump
(the same `staleBecause` rule as a grader workflow's, tested there) and a reused trial (task 9).

Checks:

- `bun test packages/lab`: 342 pass.
- Live, the mail dataset with `judgeAgent` claude-sonnet-5-5: one trial each (run 9), then three
  (run 10): 21 trials, every case passed, 36 criteria judged, none split, exit 0. The trials cost
  an estimated $0.06; grading $3.53, about 60 times the workflow it judged, as three Sonnet voters
  judge each of a case's two or three criteria apart. The report marks the judge as sharing the
  anthropic family with the workflow's Haiku.


### Task 4: plan (2026-11-17)

- **`--against {folder}`**, repeatable: another checkout of the project (a worktree or a clone).
  The dataset is found at the same path inside it as in your checkout, relative to the
  repository's top; its `env.ts` there, and its code folder by the same rule as yours (the
  nearest folder at or above `evals/`'s parent holding `node_modules/agentswf`). Your checkout
  itself, a folder that doesn't exist, or one without that `env.ts` is refused (exit 2), and so is
  any folder the checks before the first trial refuse, each naming the folder.
- **What a column takes from its folder**: its `env.ts`, its code and its `awf` (started in its
  code folder, records read back with it). The cases, keys, `dataset.json` and graders are your
  checkout's, and the graders run in your checkout.
- **Order**: trial 1 of every case in every column, then trial 2; a provider's error is tried once
  more at the end of its round, per case and column.
- **The run record** keeps a folder per column; **the report** adds, with more than one column, a
  line per column (its folder, branch, commit, uncommitted changes, "env.ts differs", and its case
  verdicts), the cases that came out differently (verdicts differ, or passes by 2 or more),
  largest difference first, the count of cases with more passes on each side, "also fails in
  {column}" on your checkout's failing lines, and "The lab does not say which is better. Read the
  cases." (or, at one trial each, "One trial each: these are examples, not rates.") until task 9's
  `compare`. `report --case` labels each trial with its column; `report --json` adds `columns`.
- History, `--failed` and the exit code stay your checkout's column alone.

### Task 4: departures, review and checks (2026-11-17)

- **The other folder must be installed itself**: its code folder is found inside it, never above
  it. A worktree inside your checkout with no install of its own would otherwise run your
  checkout's code under its name. Refused, with "run bun install there".
- **The report with columns**: each other folder in the header (path, branch, commit, changes,
  "env.ts differs"); a table of each column's verdicts with its median time and cost per trial;
  each other column's pooled numbers, so a dataset graded by numbers compares too; the cases that
  came out differently, largest difference first; "more passes" each side; "also fails in";
  errored trials of another column counted as its (`errored 1 (1 by dataset), 1 in against 1`).
  `report --case` gives the case's tally in every column and labels each trial with its column,
  its logs command run in that column's folder; `report --json` adds `columns` with their numbers.
- **The plan's estimate counts grading**: the grading earlier trials were given as they ran,
  priced apart (`est. $1.82, grading $1.80 of it`), since a judge can cost far more than the
  workflow it judges; the time counts it too.
- **A reason a part already says is said once** in `report --case`: dropped only when a part of
  the same `about` has a `why`.

Review: one combined review, scope and correctness (one must-fix: the code folder found above an
uninstalled checkout; should-fix: numbers for your column alone, a reason dropped with a part
that had no `why`, `report --case` giving your column's tally alone; nits: errored trials not
told apart by column, time and cost pooled across columns, the estimate losing grading when the
workflow was unpriced, Done-when items proven only loosely). All fixed, each with a test.

Checks:

- `bun test packages/lab`: 350 pass.
- Live, the mail dataset's `trip-form`, `trip-moved` and `newsletter`, one trial each, against a
  worktree of the mail project whose prompt leaves out dates and costs (run 11): your checkout
  passed all three; the other column failed `newsletter` and `trip-form` on their date criteria
  (the judge split 2–1 on two of them), and the exit was 0, from your checkout alone. Grading cost
  an estimated $1.81 of the run's $1.83; the plan had said $0.02, before it counted grading.

### Task 5, the lab's part, and task 6 (2026-11-17)

**Task 5, what the lab needed**: a trial records each stage's time (`stageMs`, from the run
record's stages; a stage the case gave ran through the engine too, its work only handing the
value back, so `given` names are left out), and the report shows each stage's median: across
cases when each case ran once, and in `report --case`. Trials that errored, stopped or failed in
the body are left out of the medians. "read, not run" came with task 3. **web-to-cli's dataset
waits on the person**: a build drives a real, logged-in site through a browser over a unix
socket, real git (a worktree per request, a squash merge), and planner, builder, checker and
troubleshooter agents; recorded builds took 8 to 132 minutes and an estimated $1 to $44. Which
site and login, which past requests become cases (x-cli's and linkedin-cli's `.state/runs` hold
real ones), and the spend are the person's to choose; M1 is answered then.

**Task 6, `awf-lab capture {run id} (--good | --needs-work "{note}") [--dataset {name}]`**:

- **A trial's run** is found by its workflow run's id in the store. Its case's own `files/` and
  `input.json` are copied as they are now (a note says so when the case changed since the trial
  ran); no `capture.ts`. **A real run** is `.awf/runs/{workflow}/{id}` under your checkout or the
  repository's top; an id under two workflows is refused, naming both. How it ended is its last
  attempt's (`attempts/{n}.json`): one still going, or whose last attempt was lost, has not ended,
  and an earlier attempt's `out.json` is not its result. `--good` takes only a completed run.
- **`capture.ts`** is a dataset's `defineCapture(({ run, root }) => cases)`, run in the helper
  process in your checkout: `run` is `{ id, workflow, argv, args?, outcome, result, dir }`; each
  case `{ name, input?, files?, facts? }`, checked (a plain folder name; every path a file inside
  `files/`, none both a file and a folder). A name taken gets `-2`, `-3`….
- **The key** is a draft (`draft: true`, `captured: { run, mark, note? }`, a fresh marker), so no
  grader runs on it. With `--good`, `expect` drafts the facts, `error` and `_` names left out; a
  string over 60 characters is left commented, since prose an agent wrote won't match a later run
  word for word, and `expect:` itself is commented when nothing else is left. Each case is built
  whole beside `cases/` and moved into place, under the lab's lock.

Review (one, scope and correctness; two must-fix: a draft of prose facts alone the key reader
refused, which stopped every command on the dataset, and given stages timed as if they ran, with
a test faking a shape the lab never writes; should-fix: a failed write leaving a case without its
key, a run still going captured as ended, a run id matched in another workflow's runs). All fixed
with tests. Open: `capture` looks for real runs in your checkout and the repository's top, not in
a `.awf` higher up.

Checks: `bun test packages/lab` passes; live, a trial of refund-desk's `pushy` captured with
`--good`, the reply left commented, the draft finished by removing `draft: true`, and the new
case run once: passed (run 4), with time per stage `read 0.0s · decide 6.2s · act 0.0s`. The
captured case was then removed from the example. Verify waits on task 5: "a run of each workflow
becomes a case with one command, and that case runs" needs web-to-cli's dataset, and a mail
`capture.ts`.

