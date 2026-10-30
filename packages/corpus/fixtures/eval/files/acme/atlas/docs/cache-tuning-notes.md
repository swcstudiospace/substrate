# Cache tuning notes

Tune the cache by watching hit ratio, eviction count and the age of the oldest entry.

## Eviction policy

The cache evicts the least recently used entry once memory crosses the high water mark.

## Warming after deploys

A warm-up job replays the two hundred most requested keys so the first users after a deploy do not pay for misses.

## Known issues

Large values above one megabyte bypass the cache until the compression work lands.
