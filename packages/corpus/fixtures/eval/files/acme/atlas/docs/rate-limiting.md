# Rate limiting and burst budgets

Each tenant receives a steady request rate and a burst allowance that refills one token per interval.

## Token refill

Tokens refill every hundred milliseconds up to the burst ceiling. A tenant that stays idle never banks more than the ceiling.

## Shadow mode

A new limit first runs in shadow mode, counting the requests it would have refused without refusing any.
