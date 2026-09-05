# @wf/cli-agent

The command placed on an agent session's `PATH`. It compiles against `@wf/contract` only and
talks to the engine through the local control plane. It never imports the engine or harness and
never reads or writes a run directory.

`wf result` accepts JSON from exactly one argument or standard input. The operation id and bearer
capability come from the process environment and must never appear in output or diagnostics.
