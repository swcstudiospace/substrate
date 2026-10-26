# Architecture decision records

One file per decision, numbered in the order it was taken. An ADR records the
context that forced a choice, the choice, what it deliberately refuses, and what
it costs — so the next person does not have to re-derive the argument from the
code.

| # | Decision | Status | Tickets |
|---|----------|--------|---------|
| [0001](0001-agent-swarm-as-sdlc-mesh-on-substrate.md) | Integrate [Agent Swarm](https://github.com/swcstudiospace/agent-swarm) as the SDLC mesh on Agent Substrate | Accepted | [SPE-5051](https://linear.app/swcstudio/issue/SPE-5051) / [SPE-5050](https://linear.app/swcstudio/issue/SPE-5050) |
| [0002](0002-anda-kip-concept-mapping.md) | Anda and KIP concept mapping for the memory nexus (concepts only, no code copied) | Accepted | v1.6 phase 60 |
| [0003](0003-memory-nexus-design.md) | Memory nexus design: record identity, verification, capsules, redaction and the limits of immutability | Accepted | v1.6 phase 60 |

Superseding an ADR means a new file that says so, not an edit to the old one. A
decision that was taken and then reversed is two records; the reasoning in the
first is the reason the second was needed.
