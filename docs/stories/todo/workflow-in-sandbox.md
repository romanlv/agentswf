---
title: Run a whole workflow inside a sandbox
type: story
status: todo
priority: P2
epic: sandbox
discovered_in: "story 004, 2026-09-25"
depends_on: ["004"]
---

# Run a whole workflow inside a sandbox

Run the engine and the workflow code inside a box or on a remote machine, so every agent and the
control plane live there together.

Why it matters: [story 004](../004-sandboxed-agents.md) puts agents in sandboxes that the workflow
opens, while the engine stays on the host. A second abstraction is where the engine itself runs:
`awf run --in docker:{image}`, or on a remote machine. It is the operator's choice, not the
workflow's.

Notes:

- **This is the natural shape for remote execution.** The control plane is a unix socket whose
  connection is the agent's authority, and it does not cross a network (`permissions.md` open
  question 3). With the engine on the remote machine, sockets and session files are local there.
  Only the invocation and `output.json` travel.
- **The workflow file is trusted code today.** Running it inside the box also confines the
  workflow, not only the agents. That matters once workflows come from someone else.
- **Story 013 needs it for its network.** `awf-lab` runs a loop's generated workflow whole in a
  container (`"sandbox": { "container": … }`), with the network open by the user's choice: a
  real reviewer has the internet. What stays open is the copied codex credential leaving the box.
  `awf run --in docker:{image}` would let the engine put the docker provider's proxy in front of
  it, which the lab cannot import, and replace the lab's own `docker run`.
- **Open questions:**
  - Can story 004's providers nest inside such a box? For example, srt inside a Linux box needs
    bubblewrap.
  - How are the credentials and the run directory carried in and out?
  - How does the operator watch progress (`awf run`'s live view) from outside?
