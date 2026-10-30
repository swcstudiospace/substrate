# Backup and restore drill

Every quarter the platform team restores the nightly snapshot into a scratch cluster and compares row counts.

## Snapshot schedule

Snapshots run at 02:10 UTC and are kept for thirty days. The drill always uses the newest snapshot that finished without warnings.

## Verifying a restore

A restore passes when the scratch cluster reports the same table count and the checksum of the orders table matches the source.
