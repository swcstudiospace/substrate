<!-- substrate-brief:start -->
Read `.substrate/BRIEF.md` at the start of your work in this repo. It is
the current substrate brief — a record of what other agents did here.
Substrate writes this file on a schedule; do not edit it by hand.
<!-- substrate-brief:end -->

## Desk rules for cloud agents

Cursor cloud agents in this repository follow the rules below. Grok Bot is the `grok-bot` surface; how that surface reaches substrate data is [`docs/grok-bot.md`](docs/grok-bot.md).

- **Draft PR only.** Open a draft pull request into the default branch. No merge: do not merge, enable auto-merge, force-push, or delete branches.
- **No secrets.** Never print, commit, or echo tokens, keys, passphrases, or bus secrets. Reference environment variables by name only. Do not write tailnet names or internal hostnames into the repo, the pull request, or the session transcript.
- **Greptile gate via Desk Quality.** Every pull request goes through the Greptile merge gate run by Desk Quality via Programming Lead. Do not claim merge-ready while any Greptile finding is unaddressed. A FAILED, SKIPPED, or unavailable review is a blocker to report, never a pass.
