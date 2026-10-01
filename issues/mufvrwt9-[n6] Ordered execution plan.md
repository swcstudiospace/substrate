# [n6] Ordered execution plan
## Node
`n6` · synthesize · deps: n3,n4,n5

## Question
Produce an ordered execution plan grouped into waves. Each wave contains file-disjoint units that can run in parallel. Each unit names the files it owns, the change it makes, and its verification commands (e.g. cat .planning/STATE.md, a git status check on both repos, grep of the todo files, the verifier command output). Waves: record the option 1 decision via the verifier; confirm Phase 1's status; unblock the Phase 2/4/6 todos and Phase 3 transitively, keeping Phase 5 blocked on RAGFlow config and discuss answers; start Phase 2 by executing its existing plans. End with a concise status-table report, or with the stop-and-ask path if option 1 cannot be recovered.

## Chain of Thought
(pending)

parent: mufvrwt3

<!-- aio-id: 1-6b86b273/n6 -->
## Links
- tissue: mufvrwt9
- github: https://github.com/swcstudiospace/agent-substrate
- repo: swcstudiospace/agent-substrate
