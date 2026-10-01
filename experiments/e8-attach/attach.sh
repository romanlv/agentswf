#!/bin/bash
# Stand-in for `awf attach`: runs inside the agent's sandbox, so it only files a request. The
# host finds the pane by the code this prints, since a shared harness daemon can carry another
# pane's HERDR_PANE_ID.
D=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$D/spool"
code=awf-attach-$(openssl rand -hex 4)
echo "${1:-}" > "$D/spool/$code.req"
echo "Workflow attached. End your turn now by replying with only this line, verbatim: $code"
