## First attempt, and whether the agent fixed it inside the turn

| arm    | harness | backend  | n  | valid 1st | corrected | still bad | never tried | in-turn fix rate | delivered |
|--------|---------|----------|----|-----------|-----------|-----------|-------------|------------------|-----------|
| schema | claude  | headless | 20 | 20 (100%) | 0         | 0         | 0           | —                | 20/20     |
| schema | codex   | headless | 20 | 20 (100%) | 0         | 0         | 0           | —                | 20/20     |
| schema | pi      | headless | 20 | 20 (100%) | 0         | 0         | 0           | —                | 20/20     |
| schema | cursor  | headless | 20 | 20 (100%) | 0         | 0         | 0           | —                | 20/20     |

## How many tries it took, for turns that were never nudged

| arm    | harness | backend  | n clean turns | 1  | 2 | 3 | 4+ | max |
|--------|---------|----------|---------------|----|---|---|----|-----|
| schema | claude  | headless | 20            | 20 | 0 | 0 | 0  | 1   |
| schema | codex   | headless | 20            | 20 | 0 | 0 | 0  | 1   |
| schema | pi      | headless | 20            | 20 | 0 | 0 | 0  | 1   |
| schema | cursor  | headless | 20            | 20 | 0 | 0 | 0  | 1   |

## What the first rejection was about

| arm | total |
|-----|-------|

## Turns that did not converge

None: every turn that was refused ended the turn with an accepted value.

## Wall clock and cost of a corrected turn

| arm    | harness | backend  | mean first-turn ms, clean | mean first-turn ms, corrected |
|--------|---------|----------|---------------------------|-------------------------------|
| schema | claude  | headless | 15067                     | —                             |
| schema | codex   | headless | 12716                     | —                             |
| schema | pi      | headless | 10942                     | —                             |
| schema | cursor  | headless | 12535                     | —                             |
