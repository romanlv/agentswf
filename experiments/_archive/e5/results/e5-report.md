## First attempt, and whether the agent fixed it inside the turn

| arm     | harness | backend  | n  | valid 1st | corrected | still bad | never tried | in-turn fix rate | delivered |
|---------|---------|----------|----|-----------|-----------|-----------|-------------|------------------|-----------|
| shipped | claude  | pane     | 20 | 0 (0%)    | 20        | 0         | 0           | 100%             | 20/20     |
| shipped | claude  | headless | 20 | 0 (0%)    | 20        | 0         | 0           | 100%             | 20/20     |
| shipped | codex   | pane     | 20 | 0 (0%)    | 20        | 0         | 0           | 100%             | 20/20     |
| shipped | codex   | headless | 20 | 0 (0%)    | 20        | 0         | 0           | 100%             | 20/20     |
| shipped | pi      | pane     | 20 | 0 (0%)    | 20        | 0         | 0           | 100%             | 20/20     |
| shipped | pi      | headless | 20 | 0 (0%)    | 20        | 0         | 0           | 100%             | 20/20     |
| shipped | cursor  | pane     | 20 | 0 (0%)    | 20        | 0         | 0           | 100%             | 20/20     |
| shipped | cursor  | headless | 20 | 0 (0%)    | 20        | 0         | 0           | 100%             | 20/20     |
| terse   | claude  | headless | 20 | 0 (0%)    | 20        | 0         | 0           | 100%             | 20/20     |
| terse   | codex   | headless | 20 | 0 (0%)    | 20        | 0         | 0           | 100%             | 20/20     |
| terse   | pi      | headless | 20 | 0 (0%)    | 20        | 0         | 0           | 100%             | 20/20     |
| terse   | cursor  | headless | 20 | 0 (0%)    | 20        | 0         | 0           | 100%             | 20/20     |
| schema  | claude  | headless | 20 | 20 (100%) | 0         | 0         | 0           | —                | 20/20     |
| schema  | codex   | headless | 20 | 20 (100%) | 0         | 0         | 0           | —                | 20/20     |
| schema  | pi      | headless | 20 | 20 (100%) | 0         | 0         | 0           | —                | 20/20     |
| schema  | cursor  | headless | 20 | 20 (100%) | 0         | 0         | 0           | —                | 20/20     |

## How many tries it took, for turns that were never nudged

| arm     | harness | backend  | n clean turns | 1  | 2  | 3  | 4+ | max |
|---------|---------|----------|---------------|----|----|----|----|-----|
| shipped | claude  | pane     | 20            | 0  | 20 | 0  | 0  | 2   |
| shipped | claude  | headless | 20            | 0  | 20 | 0  | 0  | 2   |
| shipped | codex   | pane     | 20            | 0  | 20 | 0  | 0  | 2   |
| shipped | codex   | headless | 20            | 0  | 20 | 0  | 0  | 2   |
| shipped | pi      | pane     | 20            | 0  | 20 | 0  | 0  | 2   |
| shipped | pi      | headless | 20            | 0  | 20 | 0  | 0  | 2   |
| shipped | cursor  | pane     | 20            | 0  | 20 | 0  | 0  | 2   |
| shipped | cursor  | headless | 20            | 0  | 20 | 0  | 0  | 2   |
| terse   | claude  | headless | 20            | 0  | 7  | 10 | 3  | 11  |
| terse   | codex   | headless | 20            | 0  | 0  | 3  | 17 | 8   |
| terse   | pi      | headless | 20            | 0  | 0  | 3  | 17 | 8   |
| terse   | cursor  | headless | 20            | 0  | 2  | 18 | 0  | 3   |
| schema  | claude  | headless | 20            | 20 | 0  | 0  | 0  | 1   |
| schema  | codex   | headless | 20            | 20 | 0  | 0  | 0  | 1   |
| schema  | pi      | headless | 20            | 20 | 0  | 0  | 0  | 1   |
| schema  | cursor  | headless | 20            | 20 | 0  | 0  | 0  | 1   |

## What the first rejection was about

| arm     | maximum | not JSON | total |
|---------|---------|----------|-------|
| shipped | 159     | 1        | 160   |
| terse   | 79      | 1        | 80    |

## Turns that did not converge

None: every turn that was refused ended the turn with an accepted value.

## Wall clock and cost of a corrected turn

| arm     | harness | backend  | mean first-turn ms, clean | mean first-turn ms, corrected |
|---------|---------|----------|---------------------------|-------------------------------|
| shipped | claude  | pane     | —                         | 23639                         |
| shipped | claude  | headless | —                         | 24704                         |
| shipped | codex   | pane     | —                         | 15543                         |
| shipped | codex   | headless | —                         | 18332                         |
| shipped | pi      | pane     | —                         | 13405                         |
| shipped | pi      | headless | —                         | 14903                         |
| shipped | cursor  | pane     | —                         | 15664                         |
| shipped | cursor  | headless | —                         | 15996                         |
| terse   | claude  | headless | —                         | 64173                         |
| terse   | codex   | headless | —                         | 48808                         |
| terse   | pi      | headless | —                         | 34050                         |
| terse   | cursor  | headless | —                         | 26803                         |
| schema  | claude  | headless | 15067                     | —                             |
| schema  | codex   | headless | 12716                     | —                             |
| schema  | pi      | headless | 10942                     | —                             |
| schema  | cursor  | headless | 12535                     | —                             |
