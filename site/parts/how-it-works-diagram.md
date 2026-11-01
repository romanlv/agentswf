```
 your workflow.ts         awf run                 agents
 ────────────────         ───────                 ──────
 wf.agents.open(...)  ──▶ starts claude /     ──▶ pane in Herdr,
                          codex / pi / cursor     or headless
 agent.run({ prompt,  ──▶ sends the prompt,   ──▶ works in your repo
   schema })              plus how to answer      as usual, then runs
                                                  `wfa result {call} …`
 await outcome        ◀── checks it against   ◀── over a socket just
                          the schema              for that agent
 parallel, loops, ifs     deadlines, nudges,
 return result            cleanup, usage for
                          the record
```
