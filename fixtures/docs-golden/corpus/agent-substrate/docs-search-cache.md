# Docs search cache

## Keying

Answers are cached under the docs-search class for three hundred seconds,
keyed by the normalised question, the dataset names and the current pins.

## Invalidation

Every ingest and every recorded version bumps the docs generation, so a
refresh invalidates every cached answer at once. A degraded or partially
served reply is never stored.
