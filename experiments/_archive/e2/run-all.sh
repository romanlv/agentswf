#!/bin/sh
# Drives the E2 matrix one cell at a time into a single run directory. Sequential on purpose:
# a concurrency effect on the return rate would be indistinguishable from the thing measured.
#
#   sh e2/run-all.sh            full matrix
#   TRIALS=2 sh e2/run-all.sh   a rehearsal
set -u

HERE=$(cd "$(dirname "$0")/.." && pwd)
ROOT="$HERE/e2/results"
RUN=${RUN:-e2}
TRIALS=${TRIALS:-20}
HARNESSES="claude codex pi cursor"

cell() {
  backend=$1
  method=$2
  trials=$3
  for harness in $HARNESSES; do
    echo "--- $harness $backend $method x$trials  $(date +%H:%M:%S)"
    bun run "$HERE/e2.ts" --root "$ROOT" --run "$RUN" \
      --harness "$harness" --backend "$backend" --method "$method" --trials "$trials" \
      2>&1 | grep -v '^harness  ' | grep -v '^run '
  done
}

cell headless cli-callback "$TRIALS"
cell pane cli-callback "$TRIALS"
cell headless write-a-file "$TRIALS"
cell pane write-a-file "$TRIALS"
cell headless delimited-line "$TRIALS"
# The design expected this cell to be lost by construction — a pane runs on the alternate screen,
# so the markers were not supposed to be readable. A one-trial-per-harness check found all four
# recoverable, so the cell is run in full rather than dropped.
cell pane delimited-line "$TRIALS"

echo "done $(date +%H:%M:%S)"
