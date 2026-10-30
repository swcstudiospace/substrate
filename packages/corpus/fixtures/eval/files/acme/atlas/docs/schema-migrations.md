# Schema migration rules

A migration may add a column or an index but may never rename or drop one in the same release.

## Expand then contract

The expand step ships first and the application learns to write both shapes. The contract step ships at least one release later.

## Rollback notes

Every migration carries a down script that is tested against a copy of production before the release is approved.
