```
 your workflow.ts            awf run                                   agents
 ────────────────            ───────                                   ──────
 wf.agents.open(...)    ──▶  starts claude / codex / pi / cursor  ──▶  pane in Herdr, or headless
 agent.run({ prompt,    ──▶  sends the prompt, plus how           ──▶  works in your repo as usual,
             schema })       to answer                                 then runs `wfa result {call} …`
 await outcome          ◀──  checks it against the schema         ◀──  over a socket just for that agent
 parallel / loops / ifs      deadlines, nudges, cleanup,
 return result               usage for the record
```
