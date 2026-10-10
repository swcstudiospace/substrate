---
name: substrate-skill-miner
description: Mine captured agent sessions for reusable procedures and propose them as skills to the shared library. Use when the substrate-skill-miner cron job fires, when the monitor prints `transcript <conversation_id> <content-hash>` or `day <YYYY-MM-DD>` lines, or when asked to mine Cursor transcripts, substrate events or other agents' sessions for new skills, learnings or repeatable workflows.
metadata:
  source: agent-substrate:packages/miner/skills/substrate-skill-miner
  library: swcstudiospace/agent-skills
---

# Substrate skill miner

You run as the Hermes cron job `substrate-skill-miner` (hourly). Your job is to turn work other
agents already did into at most three reusable skills per run, and to propose them — never to
publish them. Every skill you write is staged by Hermes' write approval and the substrate bridge
turns it into a pull request on the private library `swcstudiospace/agent-skills`; the owner
reviews and merges it.

## Inputs

The monitor script runs before you and prints only what is new since the last run:

- `transcript <conversation_id> <content-hash>` — a captured Cursor conversation, already redacted,
  at `/var/lib/substrate/transcripts/cursor/<conversation_id>.jsonl`. The hash changes only when
  the capture gains new content, so a repeated id with a new hash is new work to mine.
- `day <YYYY-MM-DD>` — the daily pass: also look at other surfaces' sessions.

If the monitor printed nothing new, there is nothing to do: say so and stop.

## Steps

1. For each `transcript <conversation_id> <content-hash>` line, read
   `/var/lib/substrate/transcripts/cursor/<conversation_id>.jsonl`. Read only that path; never
   look for transcripts anywhere else.
2. On a `day <date>` line, also read the substrate brief (`substrate brief --surface hermes`) and
   look at the recent `session.end` events of the other surfaces (Claude Code, Omp, Grok Build,
   Muse, Cursor) for work worth keeping.
3. From everything you read, pick **at most 3** procedures that are:
   - reusable: a sequence of steps another agent would follow again on a different task;
   - proven: the session shows them working, not just attempted;
   - new: no skill in `/root/agent-skills` already covers them. List the directory and read the
     SKILL.md of any skill whose name or description is close before you decide.
4. For each chosen procedure, write the skill with `skill_manage`:
   - a new skill: `action: create` with the full SKILL.md content;
   - a correction to a library skill that already exists in `/root/agent-skills`: `action: edit`
     or `action: patch` on that skill (supporting files with `action: write_file`).
   Hermes stages the write for review and the substrate bridge opens the pull request. You do
   not open pull requests yourself.
5. Never create or edit a skill under a name Hermes already has as a local skill (a skill under
   `~/.hermes/skills` that is not in `/root/agent-skills`). The bridge holds those writes for the
   owner instead of proposing them; pick another name or leave it.
6. Every SKILL.md you write must start with frontmatter holding:
   - `name`: the skill's directory name (lowercase letters, digits and dashes, at most 64);
   - `description`: one or two sentences saying what the skill does and when to use it, with the
     words an agent would search for;
   - `metadata:` with `source: cursor:<conversation_id>` for a Cursor transcript, or
     `source: <surface>:<session_id>` for another surface's session.
   Then numbered steps, the commands or files involved, and how to check the result.
7. Report what you proposed (skill name, action, source) and what you skipped and why.

## Never

- Never include secrets: no tokens, keys, passwords or connection strings with credentials.
  Write `$ENV_VAR` references or `<placeholder>` values instead. A proposal with a token shape
  is refused.
- Never write `/root/agent-skills` or `~/.hermes/skills` directly, and never run git in them.
  `/root/agent-skills` is a read-only checkout that only the sync timer updates.
- Never approve your own staged writes and never touch `~/.hermes/pending/memory`.
- Never propose a skill that only restates one session's facts (paths, issue numbers, dates)
  without a reusable procedure.
- If nothing is reusable, say so and stop. An empty run is a correct run.
