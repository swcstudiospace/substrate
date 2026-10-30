# Rate limiting for the public tracking API

The tracking API allows each customer sixty lookups a minute and answers faster requests with a retry hint.

## Retry hints

A refused lookup returns the number of seconds to wait, so well behaved clients never poll in a tight loop.

## Partner allowances

Partner customers with a signed agreement receive a higher allowance that is set by the account manager.
