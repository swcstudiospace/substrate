# Data planes

## Access path

The substrate is the only door to the data planes. Every agent reaches the
docs plane, the event ledger and the recall plane through substrate-mcp;
no agent configuration registers a plane server of its own.

## Docs search fan-out

A docs search retrieves every configured dataset at once under one shared
budget. A dataset that misses the budget is listed as degraded while the
other datasets still answer with their citations.
