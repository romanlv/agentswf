
here is a list of short asks, triage, categorize and assign priority
ask if anything is not clear


- `awf runs` shows no duration or cost for a run whose attempt is still open (reviewer held warm), even after its turns settled: review-mr/2621 on 2026-11-23 showed "12m 39s" and a blank cost for the hour it stayed warm. Show the settled turns' cost so far.
- Linking an unpublished awf into a consumer breaks its types: a worktree's `packages/lab` symlinked into mini-workflows brought a second `@agentswf/contract`, so `AgentOpenSpec` wasn't assignable to itself (2026-11-16); two `bun-types` (1.4.0 and 1.4.5) did the same in the factory (2026-11-27, fixed by a47634e5). Document a recipe for linking that works, or make one command do it.
- `awf runs` lists one folder's runs only: a wait loop over the factory's runs watched the wrong folder and saw nothing (2026-11-27). Related to [[serve-several-projects]].
- The lab reads a case's files and `env.ts` from the checkout as each trial starts, not from the commit its header names. An edit during a run broke trial 3 of every case on 2026-11-16 (ENOENT on the renamed `email.json`). Check whether 044 fixed it; if not, snapshot the case files and `env.ts` when the run starts.
- No setting says "nobody watches these agents": the factory review opened 10 Herdr TUI panes a pass, unwatched, on a loaded machine (2026-11-27), until its lenses were switched to `placement: "headless"` by hand. Consider a run-level default placement for unattended runs (`awf tick`, a service).
- `testWorkflow` has no start time for its virtual clock: it starts at the real now, so a test of working-hours logic picks a time zone where it is 23:00 now (factory `workflows/review/flow.test.ts`, `lateEvening()`), and a scripted fake (GitLab) can't read the test's clock to act "at the first nudge", so it counts calls instead. A `now` option, and the clock readable from outside the run, would fix both (2026-11-27).
