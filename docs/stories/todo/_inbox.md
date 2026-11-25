
here is a list of short asks, triage, categorize and assign priority
ask if anything is not clear


- `awf runs` shows no duration or cost for a run whose attempt is still open (reviewer held warm), even after its turns settled: review-mr/2621 on 2026-11-23 showed "12m 39s" and a blank cost for the hour it stayed warm. Show the settled turns' cost so far.
- awf-lab, four ideas from eve.dev's evals, seen against the workday builds rounds (see [[workday-replay-findings]]):
  - a case's preconditions (the environment answers, the setup is valid, a fresh name): one that doesn't hold makes the trial the case's error, not the workflow's failure, and stops it early (eve's `t.require`);
  - graders on the run's events, not only its result: no turn ended `blocked`, no turn timed out, at most {n} check rounds; deterministic, and they tell a proposer why a case stopped or was slow;
  - repeats and parallel trials as plain settings: `--repeat {n}` reported as "3 of 5", and a dataset's limit on trials at once (Workday allows a few per account);
  - tags on cases (`smoke`, `cheap`, `slow`) to pick a subset for calibration or a quick round, instead of listing `--cases` by hand.
  - Not taken: stubbing an outside service's calls with the rest going to the real one. A call nobody stubbed reaches live data unnoticed, so a case fakes a service whole or not at all.
