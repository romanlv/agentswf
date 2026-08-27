## First attempt, and whether the agent fixed it inside the turn

| arm   | harness | backend  | n  | valid 1st | corrected | still bad | never tried | in-turn fix rate | delivered |
|-------|---------|----------|----|-----------|-----------|-----------|-------------|------------------|-----------|
| terse | claude  | headless | 20 | 0 (0%)    | 20        | 0         | 0           | 100%             | 20/20     |
| terse | codex   | headless | 20 | 0 (0%)    | 20        | 0         | 0           | 100%             | 20/20     |
| terse | pi      | headless | 20 | 0 (0%)    | 20        | 0         | 0           | 100%             | 20/20     |
| terse | cursor  | headless | 20 | 0 (0%)    | 20        | 0         | 0           | 100%             | 20/20     |

## How many tries it took, for turns that were never nudged

| arm   | harness | backend  | n clean turns | 1 | 2 | 3  | 4+ | max |
|-------|---------|----------|---------------|---|---|----|----|-----|
| terse | claude  | headless | 20            | 0 | 7 | 10 | 3  | 11  |
| terse | codex   | headless | 20            | 0 | 0 | 3  | 17 | 8   |
| terse | pi      | headless | 20            | 0 | 0 | 3  | 17 | 8   |
| terse | cursor  | headless | 20            | 0 | 2 | 18 | 0  | 3   |

## What the first rejection was about

| arm   | maximum | not JSON | total |
|-------|---------|----------|-------|
| terse | 79      | 1        | 80    |

## Turns that did not converge

None: every turn that was refused ended the turn with an accepted value.

## Wall clock and cost of a corrected turn

| arm   | harness | backend  | mean first-turn ms, clean | mean first-turn ms, corrected |
|-------|---------|----------|---------------------------|-------------------------------|
| terse | claude  | headless | —                         | 64173                         |
| terse | codex   | headless | —                         | 48808                         |
| terse | pi      | headless | —                         | 34050                         |
| terse | cursor  | headless | —                         | 26803                         |
