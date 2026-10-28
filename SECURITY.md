# Security policy

## Supported version

Only `main` is supported. There are no release branches and no published packages (`package.json` is `private: true`).

## Reporting a vulnerability

Report privately to the maintainer, [@SomeRandmGuyy](https://github.com/SomeRandmGuyy). This repository is private and GitHub's private vulnerability reporting and repository security advisories are not available for it today (both API endpoints answer 404), so there is no form to fill in: send the report over the channel through which you were given access to the repository (the maintainer's invitation, or the direct contact you already share with them). If you have no such channel, ask the person who granted you access to put you in touch with the maintainer. Do not open a public issue or pull request for a vulnerability. If the repository later enables GitHub's private reporting, that flow replaces this paragraph.

A report should contain:

- the affected component and the commit or version of `main` you tested;
- what an attacker needs (network position, credentials, local access) and what they gain;
- the steps to reproduce, or a failing test;
- any suggested fix, and whether the issue is already public.

Do not include live credentials in a report. Describe where one is exposed and redact the value.

## Secrets

If a credential has been exposed in a commit, issue, pull request, log or transcript, rotate it first, then remove it from the repository and its history. Removal does not make an exposed credential safe again. Never paste a credential into an issue, pull request or log. Reference environment variables by name only; the real environment file is root-owned, mode 0600, and is never committed (see `.env.example` and `.gitignore`). Do not write tailnet names or internal hostnames into the repository ([`AGENTS.md`](AGENTS.md)).

## Dependency advisories

`scripts/audit-gate.ts` reads `bun audit --json` and fails on any high or critical advisory that is not listed in [`.github/audit-accepted-risk.json`](.github/audit-accepted-risk.json). The `dependency-audit` CI job runs it on pushes to `main` and weekly; `bun run verify --audit` runs it locally. Each accepted entry names the advisory id, the package and exact version, the reason, an `owner` and a `review_by` date. Once `review_by` has passed, the gate fails until the entry is re-reviewed (extended with a new date) or removed. An entry within 30 days of its date produces a warning. Accepting a risk is a reviewed change to that file made by the owner. See [`docs/ci.md`](docs/ci.md).

## Scope

In scope:

- `substrate-mcp` (`packages/mcp-server`) and its HTTP endpoints;
- the CLI (`packages/cli`);
- the ledger and anchoring (`packages/ledger`, the hash chain, memo and Merkle roots);
- the redactor (`packages/mcp-server/src/redact.ts`), including a secret shape it fails to catch ([`docs/redaction.md`](docs/redaction.md));
- the MCP audit trail (`packages/audit`).

Out of scope: vulnerabilities in third-party services or dependencies that are already tracked as accepted risk, and findings that need an already-compromised host.
