# Cache tuning guide

Tune the cache by watching hit ratio, eviction count and the age of the oldest entry.

## Eviction policy

The cache evicts the least recently used entry once memory crosses the high water mark.

## Warming after deploys

A warm-up job replays the hundred most requested keys so the first users after a deploy do not pay for misses.
