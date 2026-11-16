---
id: "044"
title: "Run a workflow on cases you wrote, with its services faked, and get a score"
summary: "A person writes cases (an input and what a good result looks like); awf-lab runs the workflow, with outside services swapped for the case, and says case by case what passed. A case that must pass and fails is a regression, and the command exits non-zero. The same cases can run on code in another folder, such as a worktree of main, side by side."
type: story
status: in-progress
epic: loop
discovered_in: "a conversation about evals built from runs, 2026-11-09"
depends_on: ["008", "010", "011"]
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

The story has two angles. The first is most of the work; the second is small once the first
exists.

**1. Run and score: the regression loop.**

- You write **cases**: an input (an email, a request) and a **key** that says what a good result
  looks like. Often a case starts as a run that went wrong.
- A small file of your own per dataset, the **environment** (`env.ts`), sets up each case's world
  the way a unit test's setup does: `bun:test` mocks in place of the inbox, `fetch` routes in
  place of a site, the clock set to the case's day. Then it says what to read off once the run is over.
  The workflow runs as it ships; its settings, such as the model, are its code.
- `awf-lab run` runs the workflow, as it is in your checkout, on every case, as many times as you
  ask, each trial in a throwaway folder, and grades each result against the key.
- Each case says whether it **must pass** (the default) or is **known failing** (a problem you
  have written down but not fixed). The report lists what failed and why, and `run` exits
  non-zero when a case that must pass failed.
- The loop: add a case for what went wrong; it fails; fix the workflow; run that case until it
  passes reliably; run them all to see nothing else broke.

**2. Compare: the same cases on other code.**

- `awf-lab run --against ../worktrees/app-main` runs the same cases, in the same run, on the code
  in another folder: a worktree of `main`, another branch, an experiment. The change can be
  anything (a prompt, a tool, a stage), since each side is a whole folder of code.
- The report puts the two side by side and lists the cases that came out differently. It does not
  say which side is better.

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

Reviews, today the lab's only kind of case, move onto this design in the next story. Scope lists
what is left out.

## How it works

### The parts

| Part | What it is | Who writes it |
| --- | --- | --- |
| **Case** | One folder: the input (files, small facts) and the key | you, by hand or with `capture` |
| **Environment** | `env.ts`: a code file that sets up one case's world (mocks, `fetch` routes, a prepared folder, stages given), runs the workflow as it ships, and returns the facts to grade | you |
| **Grader** | Turns a trial's result and the key into passed, failed or undecided. Two are built in: exact checks done by code (`expect`) and written criteria judged by agents (`criteria`). A dataset can add its own | built in, or you |

A workflow's cases, environment and settings together are its **dataset**. One run of the
workflow on one case is a **trial**. One `awf-lab run`, with all its trials, is a **run**. Each
folder of code, your checkout and with angle 2 each other folder, is a **column** of the report.

```text
evals/                              in your project, beside your workflows
  awf-lab.json                      marks the folder; names the judge's model
  mail/                             a dataset: a folder holding dataset.json
    dataset.json                    the sandbox setting, agents' reach, other settings
    files/                          what every case shares, such as the priorities
    env.ts                          each case's world, and what to read off after the run
    graders.ts                      optional: the dataset's own graders
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
- **Trusted code, unsandboxed.** `env.ts` is your code, as the workflow is. Only the agents the
  workflow starts are sandboxed, by the workflow's own sandboxes.
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
  trip-form           2/3   k2 unmet once (judges split 2–1)                             history ✓✓✓
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
`--cases grade-3-only --trials 3` until it passes every time, then run everything once more to see
nothing else broke.

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
the same graders, trial by trial in turn, so a live site that changes during the run falls on both.

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

The lab does not say which is better. A case that passes 2 times in 3 can show 3/3 once and 1/3
the next. Read the cases.

exit 1: a case that must pass failed in this checkout
```

A case is listed when its verdicts differ or its passes differ by 2 or more. Each column's own
failed and flaky cases are listed as in a single run, with "also fails in app-main" where that is
so: the answer to "did my change break this, or was it broken already?" The exit code is your
checkout's alone. Comparing models is the same: the other model in a worktree's code, run with
`--against`.

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
and `--failed` runs again only what did not pass. The report adds the time each stage took, read
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
- A workflow that opens a sandbox for every agent it starts; an agent outside one errors the
  trial as `reach`.
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
  your machine with your whole environment, outside any sandbox. An `observe` that runs what agents
  built runs code agents wrote: give it only the environment it needs, as the example does.
- A trial of web-to-cli's build acts on a live site. A `must-not` is graded after the act; it
  prevents nothing.
- Results, with a copy of each trial's input and result, are kept outside the repository, under
  `~/.awf/lab/`. They can hold private text such as real email. Delete a run's folder to be rid of
  it. A cases folder with real mail belongs in a private repository.
- A dataset with `"sandbox": "workflow"` trusts the workflow's own sandboxes to keep agents out of
  your home folder, where results are kept, and out of `evals/`, where the keys are. Both workflows
  here are checked for it. What they reach outside is checked on every trial: every agent
  sandboxed, no domain, web search or socket beyond `agentReach`.

## Scope

In scope:

- Cases written by hand: `input.json`, `files/`, `key.md` with `expect`, `must`, `must-not`,
  `known-failing` and `pass`, and files a dataset's cases share. `case new`.
- `defineEnv` and its `c` (`json`, `text`, `input`, `dir`, `scratch`, `root`, `mock`, `fake`,
  `http` with `http.requests`, the lab's `fetch` on every trial, `cleanup`),
  `setup`'s `observe`, `argv`, `stages` and `until`; `defineGrader` and `gradeCase`; all from
  `@agentswf/lab/cases`. `dataset.json`.
- Trials of the whole workflow, or of part of it from given stages, repeated, each in a fresh
  process with a case folder without the key.
- The reach check after each trial against `dataset.json`'s `agentReach`.
- Grading: `expect` by code, `criteria` by a judge, both behind one grader interface a dataset can
  add its own to, as code or as a workflow. The interface is shaped against what the review scorer
  needs; no review grader ships here.
- A verdict per case, its history, known-failing cases, and the exit code.
- `run` (with `--dataset`, `--cases`, `--failed`, `--trials`, `--against`, `--yes`), `report`,
  `runs` and `score`.
- `capture`: a past run turned into a case, marked good or needing work.
- Both workflows working end to end, with their datasets in their own repositories.

Out of scope:

- Any change to `engine` or `contract`: given stages and `until` are the lab's own `wf`, not
  engine options.
- Moving reviews onto this design. That is the next story ([[second-case-kind]], rewritten for
  it); the old review lab is replaced then, not kept beside it. Here reviews are the testing ground
  on paper: every interface is checked against what they need, and `review/` keeps running with
  only its import paths changed.
- The `"lab"` sandbox setting, one sandbox around every agent of a trial, and a grader that
  rebuilds the scratch folder at `score` time. Only reviews need them; they come with the move.
- Comparing against a run kept from earlier, and reusing any trial: every run costs its full
  price, and each comparison runs both sides. The store keeps enough to add it later.
- Statistics beyond counts.
- The lab making a checkout or installing dependencies for `--against`.
- Faking an agent's answer inside a stage: a recorded answer goes stale as soon as an earlier step
  changes. A whole stage can be given (`stages`).
- A stage run live once and its value reused by the case's other trials: cheaper, but every trial
  then shares one sample of that stage. If it comes, it is a named option, never the default.
- Faking what an agent's own commands reach inside a sandbox (Q9), and mocks shared with child
  processes, which the same route would carry. Their reach is checked here (`agentReach`).
- The improvement loop and holdouts.
- A ceiling the engine enforces on what a workflow's own sandboxes may allow, before an agent
  starts. Needed before an agent edits workflows in the loop, since an edit could loosen its own
  sandbox. This story checks reach after each trial (`agentReach`), which catches it but doesn't
  prevent it.
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
- Fact: of the lab's 13,000 lines, about 700 (`src/compare`) know nothing of reviews; this story
  does not use them. The rest, the command line included, is under `src/review`.
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
  keeps working as it is until the next story. What both share moves to a neutral folder, so the
  new kind never imports `review/`: `runner.ts` (once its one review type moves out),
  `awf-lab.json`'s schema and the loader of its common fields, and `validate.ts`'s `checkSchema`
  and `describeProblems`.
- The runner's request gains an environment to add and the folder's `awf` bin, started as
  `bun --no-env-file --preload {fetch} {awf bin}`, with its working folder. Its contained mode, which mounts the lab's checkout, stays review-only.
- The command line moves to a neutral entry that hands a dataset to the new kind or to `review/`;
  each kind keeps its own flags and help (`--cases` differs). `package.json`'s `bin` follows it
  and gains `./cases` and `./cases/fetch` exports.

### `packages/engine`, `packages/contract`

- Checked, no change. The lab reads a run through `awf run --json` and `awf logs --json`, and the
  run folder through its layout, as `execute.ts` does today, parsing lines with `contract`'s
  `readRun`.

### `scripts/check-boundaries.ts`

- Among the lab's folders, the new folder imports only the shared folder and contract. `review/`
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
  as its working folder, exchanging JSON with the lab, that runs `graders.ts` and `capture.ts`.
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
  workflow's result, typed from its import: `Result` when `setup` returns no `until`, and
  `Result | null` when it may (`null` under `until`); `stages` holds every stage's
  value by name, given or live, `Partial` under `until`. A throw errors the trial as the dataset's.
- **`c`**: `json(name)`, `text(name)`, synchronous (the case folder, the case's own files over the
  dataset's shared ones), `input` (`{}` without `input.json`), `dir`, `scratch`, `root`, `mock`,
  `fake`, `http`, `cleanup(fn)`. `cleanup` is the one teardown. The lab sets `AWF_LAB_CASE` for the run; `defineEnv` refuses to run without it.
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
- **The trial file.** `defineEnv` appends to a file the lab names in `AWF_LAB_TRIAL`, under
  `~/.awf/lab/` whatever `store` says (a sandbox may not be granted a path there), outside the case and scratch
  folders: each change of phase, each refused call (function or host), the unused mocks and
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
- **`defineGrader({ grade, readsFacts? })`**: a dataset's own code grader, a named export of
  `graders.ts`. `readsFacts: true` gives it the facts and the stages' values; without it, only the
  case, the result and the saved files. A grader workflow takes the same flag in `dataset.json`.
- **`gradeCase()`**: what a grader workflow reads its input from.
- **`capture`**: the default export of `capture.ts` (task 6).

### Settings files

- **`dataset.json`**: `kind: awf.case-dataset/0`; `sandbox` and `agentReach`, required; `timeout`, a trial's limit
  for the workflow's body (`"30m"` by default), and `setupTimeout` for `setup` and `observe`
  (`"10m"`), see "Timeouts";
  `realHosts`, the hosts the workflow's own code may reach for real (the engine's own are
  always allowed); `pass`, the bar for every case (`"all"` by default, or a fraction such as
  `"2/3"`); `keep`, the
  paths saved from the scratch folder; `graders`, the dataset's own; `judgeAgent`, when not the
  workspace's.
- **`sandbox`** accepts only `"workflow"` in this story: trust the sandboxes the workflow opens
  itself. It is required, with no default to grow used to, so `"lab"` can come with the reviews'
  move without breaking a dataset file. The report says which setting a run used.
- **`agentReach`**: `{ "network": [domains], "webSearch": false, "sockets": false }` (`webSearch`
  and `sockets` optional, `false` by default; a cursor agent counts as web search, since its
  harness keeps its web tools), what the workflow's agents may
  reach outside, beyond their model domains; required, so a dataset says it even when it is
  nothing (`{ "network": [] }`). Checked after every trial (see "What agents call themselves").
  `sockets` is outreach too: a host process behind a socket, such as web-to-cli's browser, can
  reach anything, so a sandbox with sockets needs `"sockets": true`, and the report names them.
  Paths stay the workflow's, checked in each workflow's task (2 and 5) to keep agents out of the
  home folder, the store and `evals/`.
- **`key.md`** frontmatter: `kind: awf.case-key/0`, `marker`, and optionally `expect`, `must`, `must-not` (lists of sentences),
  `known-failing: true`, `pass` (this case's bar), `draft: true` and `captured` (task 6). It is read
  strictly with the `yaml` package (YAML 1.2 core schema, a new dependency), and an unknown field
  (`expects:`) is refused: only `true` and
  `false` are booleans, and an `expect` value that is a string must be quoted, so `no` is refused
  rather than read as a string or false.
- **`awf-lab.json`** serves both kinds until the move: `kind: awf.lab-workspace/0`, optional until
  a new-kind dataset is used; `datasets`, the review kind's folder (a new-kind dataset is a folder of `evals/` itself); `judgeAgent: { harness, model }` (not
  `judge`, which the review loader refuses as the old name of `scorer`); `store`, optional, in
  place of the default store, refused inside the repository. The review fields (`clone`,
  `dataset`, `results`, `runs`, `variants`, `scorers`) become optional, checked only when a review
  dataset is used.
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
  as `reach`, the dataset's, for:
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
- **The trial's environment**: the lab's own, less the calling session's variables, with the
  folder's `node_modules/.bin` first on `PATH`, `AWF_LAB_CASE` and `AWF_LAB_TRIAL`; `setup` adds
  to it in its process. The criteria judge, on the lab's own `awf`, gets the lab checkout's
  `node_modules/.bin` instead.
- **Folders** are made under the system's temporary folder, in a parent folder per trial that
  holds the case folder and the empty scratch folder, and are deleted when the trial ends. The
  parent holds an owner file with its run's id and process id; at its start, `run` removes only folders
  whose process is gone.
- **Order**: trial 1 of every case and column, then trial 2, and so on.
- **The plan**: before the first trial, `run` prints the trials it will run and, when the store has
  earlier trials of the same cases, their median time and cost times the count. It
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

**A grader** is given the case (folder, input and key, `key/` included), the workflow's whole
result, the facts and the stages' values when it `readsFacts`, the saved files (`keep`), and,
during the trial only, the scratch folder. It returns:

- `verdict`, optional: `passed`, `failed` or `undecided` (it could not tell);
- `numbers`, optional, by name: a count out of a total (`recall: { count: 7, of: 10 }`) or a plain
  value, shown pooled per column;
- `reasons`: a list of `{ about, text }`, `about` naming the field, criterion or finding;
- `parts`, optional: one per thing judged (a criterion, a finding), each with its verdict and raw
  `votes`.

The lab stores parts and votes without knowing what they mean. Whether this fits the review
scorer is M2; the shape is a first guess, settled by trying it.

**Two forms:**

- **Code**: a `defineGrader` export of `graders.ts`, named in `dataset.json`:
  `"graders": ["recall"]`.
- **A workflow**: `"graders": [{ "workflow": "graders/judge.ts", "readsFacts": true }]`, a path
  inside the dataset. The lab starts it with your checkout's `awf run`, under its own sandboxes,
  with `AWF_LAB_GRADE` naming a **grade folder** that `gradeCase()` reads. The grade folder is made
  outside the repository, beside the trial's other folders, and deleted after. It holds the case
  with its key (without `marker`), `result.json`, `facts.json` (the facts and the stages' values,
  only when the grader `readsFacts`), `kept/`, and `grade.json` (`kind: awf.case-grade/0`), which
  names the scratch folder during the trial and none under `score`. Its run is recorded in the store; its cost is grading's
  cost. The criteria judge is the one grader workflow that runs on the lab's own `awf`, since it
  ships with the lab.

**Built in.** `expect` and the criteria judge are graders like any other, stored under the names
`expect` and `criteria`, which a dataset grader may not take. A dataset uses them by having
`expect`, or `must` or `must-not`, in its keys.

**Order, cheap first**: `expect`, then the dataset's code graders, then grader workflows and the
judge. When a grader has failed the trial, the costly ones are skipped and their criteria show
"not judged"; `score` judges them if a key edit later lets the trial pass the cheap ones.

**A trial's verdict across graders**: failed when any grader failed it; passed when at least one
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
| **not graded** | no grader applies, or the key is a draft |

A trial errored by the provider is tried once more at the end of its round. A broken grader is
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

**History**: each listed case shows its verdicts in this store's earlier runs of the same column
(your checkout, or another folder by its path), newest last, up to five.

**Known failing**: a case whose key says `known-failing: true` is listed under "known failing".
When it passes at three trials or more, it is listed as "now passing", with the suggestion to
remove the flag; a pass at fewer trials says to confirm with `--trials 3`.

**`--failed`**: the cases whose newest verdict in your checkout's column, in this store, is
failed, flaky or unclear. `--trials` defaults, per case, to the trials of the run that gave that case's verdict.

**The exit code**, for `run`, `report` and `score` of the new kind, from your checkout's column
alone:

- **0**: every case that must pass passed;
- **1**: a case that must pass failed;
- **5**: none failed, but a trial errored by the dataset or by grading, or leaked: the
  environment, a grader or the key's hiding is broken, which a CI that tolerates 3 must not pass;
- **3**: none failed, errored so or leaked, but one was flaky or unclear, the run is partial, or
  no case was graded at all (neither a verdict nor numbers);
- **2**: refused before any trial: a usage error, or a folder or dataset missing what it needs;
- **4**: the lab itself broke during the run.

Known-failing cases and cases with no verdict never change it by their verdict (an errored or
leaked trial of one still gives 5), except that a run in which no
case was graded at all, by a verdict or by numbers, exits 3. A dataset graded by numbers only
counts as graded. Review datasets keep their codes
until the move.

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
  checked against a person; the sandbox setting.
- With more than one column: the columns side by side; the cases that came out differently
  (verdicts differ, or passes differ by 2 or more), largest difference first; the count of cases
  with more passes on each side; "also fails in {column}" on a column's failing lines. Then "The
  lab does not say which is better. Read the cases.", or at one trial each "One trial each: these
  are examples, not rates."

### What is kept

**The store**: `~/.awf/lab/{name}-{hash}/`, one per checkout, named from its folder and a hash of
its absolute path, unless `awf-lab.json`'s `store` says otherwise. A moved checkout or a new
worktree starts with an empty store, so only history and `--failed` start over.

- A run's id is a number, the next one in the store, taken under the lock. `report` shows the last
  run; `report {n}` another; `awf-lab runs` lists them, newest first.
- The workflows' run records are kept there too, through `--run-root`.

**A run record** (`kind: awf.case-run/0`): its number, the dataset, the folders (for
each: path, branch or "detached", starting commit, whether there were uncommitted changes), the
cases and trials asked for, start and finish times. No finish means partial.

**A trial record** (`kind: awf.case-trial/0`):

- which: run, dataset, case, folder, and the `awf` it ran on with its version;
- the input: a copy of the built case folder (shared files and `input.json`, never the key) with
  its digest;
- the conditions: the sandbox setting, `agentReach`, the models used, when it ran;
- what happened: the workflow run's id and outcome, its time and cost (the accounting's
  `estimate`, with its `known` and `priced` counts), the setup's time, the whole result, the
  facts, the stages' values (which were given), the unused mocks, the refused
  calls each with its phase, the saved files, whether the marker was found, the outcome, and
  the agents' sandboxes and the reach check's result, and `errored: { by, phase, reason }`
  (phase `after` for `reach`) or the workflow's error when there was one.

**A score record** (`kind: awf.case-score/0`): the trial, when it was made, and one entry per
grader. A trial keeps every score it is given; the report reads each grader's newest entry, and an
errored one shows the trial as errored by grading until a later `score` succeeds.
Each entry has the grader's name and a digest of its code (a workflow grader: its file, with its
run's id), a digest of the part of the key it reads (`expect`'s values for `expect`, each
criterion by its text for the judge, the whole key with `key/` for a dataset's own), its verdict,
numbers, reasons, model and cost, its parts with their votes, and `errored` when it errored.

### Grading again: `score`

`awf-lab score [{n}]` grades the last run (or run n) again. It never runs `env.ts`: not `setup`,
the workflow, or `observe`.

- **What it grades again**: a grader whose key digest or code digest no longer matches, whose
  newest entry errored, or that has no entry (a draft key made final, criteria added, a grader
  added, a criterion skipped as "not judged"). Editing the note under a key's frontmatter costs
  nothing for `expect` and the judge. The judge judges only a trial's changed criteria.
- **What it grades from**: the trial's stored case folder, the current key, the stored result, the
  stored facts and stages' values, and the saved files. There is no scratch folder: `grade.json`
  names none, a code grader is given none, and a grader that needs one errors as grading's error.
  A trial whose case input changed since it ran is not graded again; the report says to run that
  case again.
- **The digests**: a code grader's covers `graders.ts` and the dataset files it imports; a grader
  workflow's, its file and the dataset files it imports; the criteria judge's, its model, its
  number of voters and its prompt. A file imported from outside the dataset folder is not covered.

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
  score and `grade.json` stay `/0` until the reviews move, where they become `/1`.
- **Costly to change**: the names that pair kept results (a case's folder name, a dataset's
  folder name, a grader's name, a criterion's `id`), the case and dataset layout and its reserved
  names (`cases/`, `files/`, `input.json`, `key.md`, `key/`, `env.ts`, `graders.ts`,
  `capture.ts`), the exit codes, and the
  formats people write by hand and commit (`key.md`, `dataset.json`, `awf-lab.json`). These start
  at `/0`; their next incompatible change makes them `/1`, with a converter in the lab.
  `dataset.json`'s `graders` is exempt until the reviews move.
- **Unstable, no converter**: the code shapes people write against (`defineEnv`, `setup`'s
  return, `c`, a grader's result).

### Decisions

Settled by the owner:

- **The judge reads the facts** (2026-11-15): what a workflow did is often only in a mock's
  record, not in its result (the mail triage's summary goes out as an email), so `observe` hands
  it to the judge as a fact.
- **Criteria are two lists of sentences** (2026-11-15): `must:` and `must-not:` in a key's
  frontmatter, no ids. A criterion is known by its text, so an edited one is judged again.
  Found writing the mail evals, where `id`, `kind` and `text` per criterion was most of the key.
- **Run and score first; compare second.** A case says whether it must pass; a run gives a
  verdict and an exit code from its own trials. Comparing is the same run on more folders
  (2026-11-14).
- **The unit of change is a folder of code** (2026-11-14). There are no variants: a setting such
  as the model is code too, and comparing one is comparing folders (2026-11-15).
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
- **Reviews move over in the next story** (2026-11-14).
- **A past run becomes a case from its traces**: the dataset's own code rebuilds it; the engine
  does not change (2026-11-14).

Settled in the design:

- **Both sides run in one run.** Paired: same cases, graders, time and machine. A kept run is not
  a baseline.
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
  workflow.

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
- **A variant as the way to compare a change to code**: it cannot hold a change to a prompt, a
  tool or a stage without the workflow exposing every part someone might change.
- **Fakes passed to the workflow as arguments**, through a **variant** (a file per setting that
  wrapped the workflow, the earlier draft): it reaches nothing an agent does, bends every workflow
  around being tested, and a setting such as the model is code anyway.
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
- Reusing a trial when the code is unchanged: if "the code" includes the cases, editing a note
  runs everything again; if not, editing `env.ts` runs nothing again.
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
- Turning a workflow's own sandbox off for every trial: the mail triage's is stricter than the
  lab's, web-to-cli's browser is reached only through its own, and a trial should run what ships.
- The whole trial in a container: the workflow's own sandbox would have to run inside it.

## Tasks at a glance

0. [x] The mail triage's evals written against this design, in `mini-workflows` on its `evals`
   branch, and reviewed by the person: `env.ts`, seven cases, and what writing them changed here

- [ ] 1. By hand: ten mail cases, and whether a judge agrees with the person
- [x] 2. The mail triage runs on cases, graded by `expect`, with a verdict and an exit code
- [ ] 3. Criteria are judged, and a changed key is graded again
- [ ] 4. The same cases on code in another folder
- [ ] 5. web-to-cli's build runs on cases
- [ ] 6. A past run becomes a case

## Open questions

None open. The owner's answers, Q8 and Q9 among them, are under Decisions. Smaller ones,
settled in the design:

- Q1. The default bar: every trial passes; a mixed result is flaky, not failed.
- Q2. The judge: three voters, majority; splits counted.
- Q3. Exit codes: 0 clean, 1 a must-pass case failed, 2 refused, 3 flaky, unclear, partial or
  nothing graded, 4
  the lab broke, 5 a trial errored by the dataset or grading, or leaked.
- Q4. Where runs are kept: one store per checkout, numbered runs; one `run` or `score` per machine
  at a time.
- Q5. One set of commands for both kinds: yes; `dataset.json`'s `kind` marks the new one.
- Q6. The judge's model: once for the workspace; a dataset may override it.
- Q7. A setup that runs the project's own commands: accepted; a case does not carry a prepared
  checkout.

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

## Task execution rule

Process one task at a time, with one exception: task 2 may start before task 1's decision is
recorded, since task 1 is the person's work and no code. Every task repeats the checklist shown
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
reader refuses `must` and `must-not`; task 3 builds the grader interface with `expect` and a dataset's own
code graders behind it, the key digest and `score`, with no judge and no grader-workflow path
(`gradeCase`, the grade folder and `grade.json` come with the reviews' move); its `Done when` items
that need the judge are dropped, and so are task 5's "read, not run" and the person's check of the
judge.

Done when:

- The numbers and the decision are in Implementation notes.

### 2. The mail triage runs on cases, graded by `expect`, with a verdict and an exit code

Outcome: `awf-lab run` and `report` work for the mail dataset, set up by its `env.ts`; each case
gets a verdict and `run` exits by it. It does not wait for task 1.

Execution:

- [x] Plan: first, amend ADR 0003 and rewrite [[second-case-kind]] as "move reviews onto the case
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
  passed with one failed, flaky (3); one undecided through a grader hook internal to the lab's tests (task 3 builds the real
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

### 3. Criteria are judged, and a changed key is graded again

Outcome: `criteria` count in each case's verdict; `score` grades a kept run again after a key
changes.

Execution:

- [ ] Plan: the grader interface as M2 left it; the judge's prompt, from task 1's tuned part. The
  review judge's voting (`review/judge/voting.ts`) is built around finding labels, so the three
  voters are written fresh in the new folder, reusing only the shared runner. The judge is a lab
  workflow that reads its input through the grade folder and `gradeCase()`, so that path has a
  shipping user; it puts what the voters need into their prompts. It runs on the lab's own `awf`,
  under a sandbox that reaches only its model, with its records in the store and its cost on the
  score entry. The reach check is for trials only: a grader's run is the lab's own, not graded.
- [ ] Implement: only this task's change, with tests.
- [ ] Review: architecture and scope; correctness and proof.
- [ ] Resolve: disposition every finding.
- [ ] Verify: the `Done when` items.

Work:

- The grader interface: `defineGrader` and `gradeCase`, as code and as a workflow; `expect` moved
  behind it; the order, cheap first; the criteria judge, its voters, majority and splits, and what
  it is given; pooled numbers; grading errors; the key's and graders' digests on a score; `score`.
- The report marks `score` brings: keys changed since grading, a case edited since the run.
- For the live check, a script calls the judge directly on each of task 1's fixtures.

Done when:

- Editing a criterion and running `score` changes the report without a new trial, and judges only
  that criterion.
- A test: a trial `expect` failed skips the judge, shows its criteria "not judged", and `score`
  judges them after the key's `expect` is changed to pass.
- A test: no voter's prompt holds the marker, `expect`, `key/` or the agents' logs.
- A test: a 2–1 split decides by majority and is counted; a voter with no answer and the other two
  split leaves the criterion unsettled.
- A test: a dataset's own code grader returns counts that are pooled into report rows, and a
  dataset whose graders give no verdict shows its cases as graded by numbers only.
- A test on scripted agents: a grader workflow is given its folder, and its result and cost reach
  the score.
- A test: `score` never runs `env.ts`; a grader is given no scratch
  folder there; a trial whose case was edited since it ran is not graded again and is reported as
  edited.
- A test: a grader that throws leaves the trial errored by grading, and `score` grades it again.
- A test pins the outcome order: a failed `expect` with a grader that errored reads as errored; a
  leaked trial that also errored reads as leaked.
- The model-family table and the column mark.
- The interface built is the one M2 left, or Implementation notes say what changed and why.
- Live: the mail dataset, three trials each, with criteria judged.
- Live: on task 1's held-out part, the built judge gives the hand-run judge's verdicts, except
  where voters split; any other difference is a bug, fixed before the task is done.

### 4. The same cases on code in another folder

Outcome: `awf-lab run --against {folder}` runs both folders in one run and reports them side by
side.

Execution:

- [ ] Plan: the folder checks, as task 2 built them for one folder; the run record's folders.
- [ ] Implement: only this task's change, with tests.
- [ ] Review: architecture and scope; correctness and proof.
- [ ] Resolve: disposition every finding.
- [ ] Verify: the `Done when` items.

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
- The build's sandbox is checked to keep agents out of the home folder, the store and the
  project's `evals/`.

### 6. A past run becomes a case

Outcome: `awf-lab capture {run id} --good` or `--needs-work "{note}"` makes a case from a past run
of the workflow, a trial's or a real one.

Execution:

- [ ] Plan: confirm the shape below against both workflows' run records.
- [ ] Implement: only this task's change, with tests.
- [ ] Review: architecture and scope; correctness and proof.
- [ ] Resolve: disposition every finding.
- [ ] Verify: the `Done when` items.

Work:

- Flags: `--dataset {name}` as for `run`.
- The run id is looked up first in the lab's store (a trial's run), then in the project's
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

Tasks are checkpoints, not a file-by-file edit script. The implementation agent may adjust the
implementation without changing their outcomes, order, or the story's scope.

## Verification

Automated:

- [ ] A dataset runs end to end on scripted agents: trials, scores, verdicts, report, exit code.
- [ ] Two folders run side by side on scripted agents, each on its own `awf` (task 4).
- [ ] The lab copies `key.md` and `key/` into neither folder, and a leaked marker is caught.
- [ ] The review lab's existing tests pass, with only their import paths changed.
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

- ADR 0003 is amended (cases for a workflow live beside it), and [[second-case-kind]] is rewritten
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
- For task 3: a grader workflow gets an empty working folder of its own (`--cwd`), and may be
  given its previous parts and key digest, so a key edit judges only what changed.
- For the reviews' move, not now: grading a run the workflow failed (the review counts its recall
  as 0), graders identified by a version instead of a code digest (one trial holds 21 scores of
  several scorer versions), and a key digest limited to the files a grader reads.

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

## Human review

- [ ] Every task is complete and story-level verification passes.
- [ ] Set the story status to `awaiting-human-review` and present the outcome, architecture
  decisions, task-level subagent findings and dispositions, exact verification results, deviations,
  and remaining risks.
- [ ] Record the human's explicit approval or requested changes here.
- [ ] If changes are requested, return to the affected task and repeat its review and verification.
- [ ] Only after explicit approval, mark the story `done` and update `Stories at a glance`.
