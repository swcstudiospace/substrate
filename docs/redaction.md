# Redaction

Owned by `packages/mcp-server/src/redact.ts`. Enforced by
`packages/mcp-server/src/redact-lock.test.ts`, which fails `bun test` when any
package redacts through anything else.

One module guards every publication path — event summaries and payloads,
memory bodies, skill files, transport diagnostics — because a second rule
table is a second door past the first one. `redact()` keeps its signature
and output; the labelled table only names what was already there.

## The rule table

Thirty-nine named rules on the event pass. The skill pass mirrors each one under
the same name, except where the exclusion list says otherwise. The table
below names each rule and the shape it catches; the middle column is the
reported skill family, which groups shapes that mean the same credential.

| Event rule | Skill family | Shape |
|------------|--------------|-------|
| `private-tag` | `private-tag` | A `<private>` block up to its closing tag, claimed first so a key inside it goes as one block; an inner high-confidence shape is still reported as a finding |
| `pem` | `pem` | A PEM block |
| `tailscale` | `tailscale` | A `tskey-` key |
| `password` | `password` | A `password` key assignment |
| `password-env` | `password` | A `*_PASSWORD`, `*_PASSWD` or `*_PASS` assignment |
| `daytona` | `assignment` | A `DAYTONA_KEY` assignment |
| `vault` | `assignment` | A vault token assignment |
| `assignment` | `assignment` | Any `*_TOKEN`, `*_KEY`, `*_SECRET` assignment, ours included; `KEYBOARD_LAYOUT` is not one |
| `api-key-lower` | `api-key-lower` | A lowercase `api_key` / `apiKey` assignment |
| `authorization` | `authorization` | An authorization header |
| `bearer` | `bearer` | A `Bearer` token |
| `url-password` | `url-password` | A password inside a connection URL; the host survives |
| `linear-api` | `linear` | A `lin_api_` key |
| `linear-oauth` | `linear` | A `lin_oauth_` key |
| `notion` | `notion` | A Notion key |
| `github` | `github` | A `ghp_` / `gho_` / `ghu_` / `ghs_` / `ghr_` token |
| `github-pat` | `github` | A fine-grained personal access token |
| `xai` | `xai` | An `xai-` key |
| `anthropic` | `anthropic` | An `sk-ant-` key |
| `openai` | `openai` | An `sk-` key that is not an Anthropic one |
| `aws` | `aws` | An `AKIA` or `ASIA` access key id |
| `google` | `google` | A Google API key |
| `slack` | `slack` | A Slack `xox[abprs]-` token or `xapp-` app token |
| `npm` | `npm` | An `npm_` token |
| `gitlab` | `gitlab` | A personal access token |
| `digitalocean` | `digitalocean` | A personal access token |
| `openai-proj` | `openai-proj` | An `sk-proj-`, `sk-svcacct-` or `sk-admin-` key, which the `sk-` rule stops short of |
| `stripe` | `stripe` | A Stripe `sk_live_` or `rk_live_` key |
| `huggingface` | `huggingface` | An `hf_` token |
| `google-oauth` | `google-oauth` | A `ya29.` OAuth access token |
| `sendgrid` | `sendgrid` | An `SG.` key |
| `shopify` | `shopify` | A `shpat_` access token |
| `supabase` | `supabase` | An `sbp_` token |
| `glitch` | `glitch` | A `glsoat-` token |
| `twilio` | `twilio` | An `SK` key id: `SK` followed by 32 hex digits |
| `pk-rk` | `pk-rk` | A publishable or restricted key — digit-bearing only, see below |
| `jwt` | `jwt` | A JWT |
| `keypair-array` | — (excluded) | A pasted private keypair array; byte arrays are ordinary code in docs |

The D-04 classes are `private-tag`, `api-key-lower` and the eight rows from
`aws` to `pk-rk`: shapes the September `/remember` path did not filter, now stored as `[REDACTED]`.

### The `pk-rk` deviation (D18-21, operator 2026-10-08)

September's rule matched word-only slugs too, so a branch named `pk-…`
without a digit came back `[REDACTED]` on the event path and quarantined the
memory body as `secret`. The shipped rule requires at least one digit in the
matched tail, on both passes. A digit-bearing key is still redacted; the two
pinned word-only slugs survive `redact()`, the skill scan, and `classify()`.
This is the only D-04 pattern that is not byte-identical to September.

### The `api-key-lower` value runs to the end of the token

September's rule redacted only the characters of its value class (`[A-Za-z0-9_\-/.+]{16,}`), so
`api_key: <a long key>!2024` came back `api_key: [REDACTED]!2024` and, on the skill
pass, the 18-character prefix `yoursecretpassword` of `yoursecretpassword!2024` looked like a
placeholder and the whole value was kept. The value now continues to the end of the token
(`[^\s"'`,;)]*` after the class), on both passes, so a value carrying punctuation is redacted whole
and a placeholder is judged on everything that was assigned. Trailing quotes and closers are not
part of the value.

### Linear-time scanning

The event pass runs on bodies up to 1 MB before they are capped, so a rule that rescans the rest of
the text from every opening is a way for one writer to hold the event loop. Four rules are applied
by a function instead of their pattern, each making one pass: `private-tag` and `pem` (a missing
closing delimiter ends the scan, since no later opening can have one), `pk-rk` (the run is matched
once and tested for its digit, rather than looked ahead at from every `pk-`) and `url-password`
(text with no `://` is skipped; the pattern needs one). `redact()` measures `private-tag` and `pem`
on the original text and replaces their union: the earlier marker stands, and the copy runs to the
end of the overlap, so a PEM whose only BEGIN or END line sits inside `<private>` does not keep its
key body. The pattern in the table stays the definition, the fixtures and the lock read it, and
`redact-adversarial.test.ts` pins each function to its pattern on ordinary text and on 600 random
strings. The skill pass finds `<private>` blocks and PEMs with the same scan, skips `url-password`
when the file has no `://`, and checks each match against the ranges already claimed by binary
search. Line numbers walk forward from the last newline, so a file of tens of thousands of matches
scans in time proportional to its size.

Known limit: `url-password` is still quadratic on text that repeats `://` with a long colon-led run
and no `@` (for example `a://b:` repeated), because the password run is rescanned from every
`://`. It predates this phase and is tracked as a follow-up; it needs a hand-written scan rather
than a prefilter.

### Verbatim-port gaps, kept on purpose

The D-04 entries port September's text as-is, gaps included — tuning them
here would fork the two tables silently:

- `api-key-lower` misses `openai_api_key:` (no word boundary between the
  trailing underscore and the value) and JSON `{"api_key":"…"}` (the closing
  quote sits between key and colon).
- The fixed-length shapes (`npm_`, the Google key, the DigitalOcean token)
  carry no trailing boundary, so a longer run leaves a tail past the marker.
- On the event path `api-key-lower` crosses a newline; the skill pass keeps
  its whitespace on its line (`[ \t]`), so a bare `password` key with its colon at a line end
  never eats the next line's first word.

## The counter exemption

`redactValue` redacts a sensitive key whole — but `input_tokens` is a count,
not a credential, and the substring rule once blanked every usage count on
the write path, invisibly. The exemption is narrow on purpose: only the
listed counter names, and only when the value is a count — a finite number
or a digit string, because collectors ship both. Anything else under the
key is still redacted whole, so a token shape under `tokens` and a bare
`api_key: "short"` both come back `[REDACTED]`.

## Findings versus redactions

The event pass rewrites silently: the value is gone, the surrounding text
stays. The skill pass distinguishes, because skill files are instructions an
agent has to read — an `Authorization` header with the value `Bearer $PARALLEL_API_KEY` is a working
line, not a leak:

- **Kept:** env references, angle-bracket placeholders, placeholder words and
  already-redacted markers come back as written, with nothing reported. A
  placeholder is judged on the whole assigned value, never on a prefix of it.
- **Redactions:** contextual rules with a real value are rewritten and
  reported with file, line and rule.
- **Findings:** a high-confidence shape is never rewritten silently — it is
  reported for the caller to refuse on, unless it is an allowed documentation
  example (`pem`, `jwt`, opt-in only). That holds however the shape sits against a
  `<private>` block: inside it, the block's own redaction removes it; across one of
  its edges, the two are replaced together as one span and the shape is still
  reported.

Results name the file, the line and the rule, never the value. A memory body
holding a D-04 shape or a `<private>` block classifies as `secret` through
`redact(text) !== text`: quarantined, unreleasable, kept redacted for review.

## The lock and its allowlist

`redact-lock.test.ts` states five rules, each asserting an offender list
equal to `[]`:

1. Every redactor import resolves to the shared module, judged against the
   importing file's directory.
2. No second redactor is defined anywhere else — the name is the door, even
   a definition that today delegates.
3. No second marker: no `[REDACTED…]` literal and no replace spelling it
   elsewhere.
4. No hand-rolled credential-shape detector: no pattern holding a prefix the
   shared module names. Runtime-assembled decoys stay legal.
5. Injected seams stay injected. `packages/audit` (`log.ts`, `record.ts`)
   and `packages/observability` (`otlp.ts`) take `redact` as a
   `(text: string) => string` parameter, because importing it back would be a
   cycle — `mcp-server` depends on them. A companion rule pins that the only
   non-test constructions of those classes pass the shared `redact`.

Each detector is proven against planted in-memory offenders and
non-offenders, so a detector that silently matches nothing fails the suite.
The lock watches the repository, not installed artifacts: a copy built from
this file is not a second source.

One dormant seam is noted, not allowlisted: `packages/observability/src/trace.ts`
takes a `describe` function defaulting to `String` for span failure causes. It
is not a redactor and matches no lock rule today; if it ever renders a
credential-bearing cause into a span, it joins the injected seams above.

## How a new package redacts

Import `redact`, `redactValue`, `redactKnown`, `redactSkillContent` or
`scanSkillFiles` from `packages/mcp-server/src/redact.ts` — through a
relative specifier the lock resolves — and call it before the value is
stored or published. Redact before any cap: truncating first can cut a
shape so its own pattern no longer matches, and the fragment is stored.

When importing back would be a dependency cycle, take `redact` as an
injected `(text: string) => string` parameter defaulting to identity, and
have the single construction site pass the shared one. Name the seam in the
lock's allowlist with the cycle reason. For caller-known values — a
provisioned token, a URL component — scrub with `redactKnown` first
(every occurrence of every value is found, overlapping ones included, and the
union of the spans is replaced; empties are ignored; only the module's own
`[REDACTED]`, `[REDACTED_PEM]` and `[REDACTED_TSKEY]` are left alone, so a
marker-shaped lookalike never shields a value), then run the result through
`redact()` for shapes the list cannot name.

## How to add a rule

One rule is four things: a labelled entry in `RULES` (unique name, pattern,
replacement), a runtime-assembled fixture in `redact.test.ts` (no literal
shape in git — the store lock scans tracked files), a same-name skill entry
or a reasoned line in `SKILL_EXCLUSIONS`, and a detector decision in the
lock. The coverage, parity and detector-source tests fail until all four
exist, so a rule cannot land half-added. Port September's order: structural
patterns first, provider shapes before the JWT rule, and keep the skill pass
line-local.

## Before the restart

Stored rows keep the table they were written under — append-only forbids
re-redaction. Rows written after the operator's approved restart get the
wider table; earlier rows keep their unredacted bytes. Identifier
normalisation now redacts key-shaped branch and session ids the same way,
so a post-restart query for such a raw id normalises to `[REDACTED]` and
misses rows stored before the restart. That is the cost of widening, noted
here so nobody reads it as a regression.
