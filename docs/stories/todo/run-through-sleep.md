---
title: A run the machine slept through
summary: Story 008's two runs that ended 5 and 14 minutes past their deadline were not slow to close; the Mac slept through the deadline, and a run's times then count the sleep as work.
type: story
status: todo
discovered_in: "story 008, the trial; measured 2026-10-02"
depends_on: ["operator-settings"]
---

# A run the machine slept through

Why it matters: `awf-lab` compares variants on time, and gives each run a timeout. A run the machine
sleeps through ends after its deadline by the length of the sleep, and its `wallMs`, `agentMs` and
`spanMs` count that sleep as work, with nothing in the record to say so.

What was measured (2026-10-02, `pmset -g log` against the run directories in the autoresearch
repository's `runs/`):

- The panel judge, deadline 08:07:31Z: the Mac slept 08:06:11Z to 08:21:58Z ("Dark Wake Thermal
  Emergency"), and `output.json`'s `finishedAt` is 08:21:58.5Z. An earlier sleep, 07:49:46Z to
  08:04:55Z, is why its first claude turn took 17 minutes.
- The catalogue review, deadline 08:33:35Z: asleep 08:22:47Z to 08:38:56Z, `finishedAt` 08:38:56.9Z.
- Neither error names a cleanup grace exceeded. Each run ended within a second of waking: the
  deadline had passed in its sleep, and its timers fired on wake.
- The close path is bounded: on fakes, a headless turn that ignores its stop ended 1 s after the
  deadline. `finishedAt` waits at most the owner's and control plane's 5 s graces, and 10 s more
  for turns left finishing after a body that returned; `output.json` then waits for the usage read,
  at most 20 s plus the status command's 10 s and 2 s of slack.
- Found on the way: [[headless-orphans]].

Decide:

- Holding the machine awake for a run, as `caffeinate -i` does on macOS: probably yes, by default,
  with a setting to turn it off ([[operator-settings]]). Still to decide: `awf run` or only
  `awf-lab`, and what it does where there is no `caffeinate`.
- Whether a run records time it slept through, so a scorer can discount it or drop the trial: a
  wall-clock jump against a monotonic one at each phase is enough to see it.
