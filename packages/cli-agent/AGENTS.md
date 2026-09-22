# @wf/cli-agent

The command an agent is told to run. It compiles against `@wf/contract` only and talks to the
engine through the local control plane. It never imports the engine or harness and never reads or
writes a run directory.

It is reached through a launcher the engine installs per agent, which supplies `--at <socket>`.
That indirection is not ceremony: a Codex pane runs its tool commands in a different process from
the one the harness launched, so neither that pane's environment nor its `PATH` reaches them. A
prompt does, so the agent is given a path and a call id and nothing else.

`wf result <call-id>` accepts JSON from exactly one argument or standard input. Nothing it carries
is secret: the socket it arrives on is what says which agent is answering, so the call id is a
name, not a claim.
