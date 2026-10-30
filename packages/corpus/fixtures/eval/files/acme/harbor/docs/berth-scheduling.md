# Berth scheduling algorithm

The scheduler assigns each arriving vessel to the berth that minimises waiting time at anchor.

## Conflicts between vessels

When two vessels want the same berth the larger draught wins and the smaller one is moved to the next free window.

## Delays at sea

A late vessel keeps its slot for ninety minutes before the scheduler offers it to the next ship in line.
