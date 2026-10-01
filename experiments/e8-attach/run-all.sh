#!/bin/bash
# Attach experiment: start claude, pi and cursor in their own Herdr tabs, have each run the
# `awf attach` stand-in, and let host.ts drive all three through the four steps at once.
set -euo pipefail
D=$(cd "$(dirname "$0")" && pwd)
WS=${HERDR_WORKSPACE_ID:?run this from inside Herdr}
rm -f "$D"/spool/*

nohup bun "$D/host.ts" > "$D/host.log" 2>&1 &
echo "host pid $!; log: $D/host.log"

start() { # name kind -- agent args...
  local name=$1 kind=$2; shift 3
  mkdir -p "$D/cwd-$kind"; git -C "$D/cwd-$kind" init -q
  local pane
  pane=$(herdr tab create --workspace "$WS" --cwd "$D/cwd-$kind" --label "$name" |
    grep -oE '"pane_id":"[^"]+"' | head -1 | cut -d'"' -f4)
  herdr agent start "$name" --kind "$kind" --pane "$pane" --timeout 90000 -- "$@" >/dev/null
  echo "$name ready in $pane"
  herdr agent prompt "$name" "Run this command and follow what it prints: bash $D/attach.sh $name" >/dev/null
}

start attach-claude claude -- --model claude-sonnet-5-5 --allowedTools Bash &
start attach-pi pi -- --model openai-codex/gpt-5.6-terra &
start attach-cursor cursor -- --model composer-2.5 --force --trust --sandbox disabled &
wait
echo "all three attached; watch: tail -f $D/host.log"
