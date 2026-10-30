# Feature flag lifecycle

A feature flag moves from created to rolled out to removed, and each stage has an owner.

## Rollout stages

A flag starts at one percent of tenants and doubles after each clean day until it reaches everyone.

## Removing a flag

Once a flag has been fully on for two weeks the owner deletes the flag and the dead branch of code behind it.
