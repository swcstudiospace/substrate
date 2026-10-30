# Log retention policy

Application logs are kept for fourteen days and audit logs for four hundred days.

## Hot and cold storage

Logs younger than three days sit on fast disks. Older logs move to compressed object storage in monthly partitions.

## Legal holds

A legal hold pauses deletion for the named tenant until the legal team lifts it in writing.
