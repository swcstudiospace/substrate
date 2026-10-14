# Draft pull requests

## The only kind of pull request a cloud agent opens

Cloud agents open a draft pull request into the default branch. They do
not merge, enable auto-merge, force-push or delete branches.

## Secrets

Tokens, keys and passphrases are referenced by environment variable name
only and never printed, committed or echoed.
