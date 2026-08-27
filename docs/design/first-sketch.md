
well, it starts a workflow 
and it has some states that can be transitioned to 

e.g. 

```json 

{
  name: "review {mrId}", 
  agents: [
    {
      name: "reviewer1", 
      model: "main",
      hooks: [
       {
        kind: "on_idle",
        mode: "fork", 
        prompt: "are all issues fixed", 
        result: "{ yes: boolean }"
       }  
      ]
      states: [
        { id: "all_issues_fixed", prompt: "are all issues fixed?"}
      ]
    }
  ]
}
```

```yaml 
# models:

space:
  name: `review ${mrId}`
  agents:
    - id: review1
      model: main
  flow:
    - prompt: '/new-worktree'
      result: 'what is the result'
      
    - on the workflow '/review
    - prompt:
        input: 'file.md'
        inline: `does it have all issues resolved`? 
    - 


like 

```
from:
  x


## update 

first reaction was to use yaml files, and in fact, it's not a such a bad idea 


see https://github.com/rlouf/zeta 

.md files with yaml frontmatter, that define events consumed and published 
not bad to be honest, something to learn from
