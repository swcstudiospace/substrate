# Push notification delivery draft

Notifications are queued on the server and handed to the platform push services in batches.

## Token hygiene

A device token that the platform reports as unregistered is deleted so the queue never retries it.

## Quiet hours

Notifications raised during a user's quiet hours are held and delivered as one digest at the end.

## Open questions

We have not decided whether silent pushes should count against the daily notification budget.
