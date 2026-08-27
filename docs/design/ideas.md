

- advanced forking
being able to fork the sessions by creating summary (compact), but without destroying original session,  that can be useful when additionl agents or additional work should be done, or if there are sidequests, that may or may not be used


- team of agents 
providing options for agents to talk to each other, with some checks enforced by the model
but main thing, it should be able send messages to each other and wait for responses, it mainly applies to the running agents


- agents may be given additionl skills or tools, and we should unifiy the way to invoke them
something like `skill:name` is less error prone than claude or codex version, that are not the same


- call workflows from other workflows
- checkpoints, of inputs from the user, stop everything until approval it given

- create monorepo structure, with multiple packages
- modular structure
- evals / autoresearch engine

- observability
- messaging can be it's own package
- ability to detect if agent is in dump zone, what is the percentage of context used so far

--- 
## evaluation and self improvemt loop 

given enough data, sandbox and some freedom, iterate on the variables to create better, faster, and cheaper workflows


## self improving

- figure out how it works in hermes agent

## messaging 

I still not quite sure if messaging can be it's own tool or not, in theory, adhoc workflows, can be implmented with messaging/signaling too and some prompts, or maybe it's just one of the commands in the toolchain? and it can be integrated 

## sandboxing
This deserves some upfront thinking, although it can be a next step after that, I still need to prove that design is right for the workflows, let's postpone

## memory 
self documenting and self cleaning, maybe some kind of skills for now 

## awf powered by awf? 

that can be quite cool
