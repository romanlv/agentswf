# @wf/cli-agent

The command an agent is told to run. It compiles against `@wf/contract` only and talks to the
engine through the local control plane. It never imports the engine or harness and never reads or
writes a run directory.

It is reached through a launcher the engine installs per agent, which supplies `--at <socket>`; the
reason that indirection is not ceremony is argued in
[`docs/design/README.md`](../../docs/design/README.md#what-an-agent-inside-a-session-sees).

`wf result <call-id>` accepts JSON from exactly one argument or standard input. Nothing it carries
is secret: the socket it arrives on is what says which agent is answering, so the call id is a
name, not a claim.
