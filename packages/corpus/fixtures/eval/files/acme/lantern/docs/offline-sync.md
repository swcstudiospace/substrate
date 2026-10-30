# Offline sync conflict resolution

When two devices edit the same note while offline the later edit wins field by field.

## Merge rules

Text fields merge by timestamp and list fields merge by union, so a deleted item can reappear after a conflict.

## Sync queue

Edits made without a connection wait in a local queue that is flushed in order once the network returns.
