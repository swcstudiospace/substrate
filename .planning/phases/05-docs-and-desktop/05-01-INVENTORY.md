# 05-01 library corpus inventory (D-15)

Recorded from observed output only.

Measured 2026-09-26 (UTC) on the `/root/agent-skills` checkout at `library-head` (05-BASELINE.md),
after the Task 1 commit. Command, from the repo root (the script was a throwaway and is deleted; it
imported `redact` from packages/mcp-server/src/redact.ts and read only /root/agent-skills):

```
/root/.local/share/reflex/bun/bin/bun /tmp/05-01-inventory.ts
```

The script walked every top-level dir with `manifest.json` and a `references/` dir, and for each
`references/*.md` page resolved the URL in D-08's order (manifest `pages[].url` → first
`^Source: (https?://\S+)` in the first 20 lines → manifest `root_url` → none). It printed counts
only; for the hyphenated sk shape it would print just `sk-<segment>` prefixes (no hits).

library_head=34b32e27870c49d84e166830033b42f011eaf96e
manifest_dirs=25
manifest_pages=2317
docs_glob_dirs=24
parallel_web_manifest=true
corpus_dirs=25
corpus_pages=2317
url_from_manifest=2117
url_from_source_line=200
url_from_root_url=0
url_missing=0
redact_changed_pages=294
image_embed_links=2409
image_embed_pages=386
html_img_pages=3
max_page_bytes=2751358
pages_over_1mb=2
max_name_bytes=84
new_rule_ragflow_hits=0
new_rule_sk_hyphen_hits=0
new_rule_sk_hyphen_prefixes=none
docs_python_pages=80
tracer_page=docs-python/references/001-cmath-Mathematical-functions-for-complex-numbers-Python-3-14.md
tracer_url=https://docs.python.org/3/library/cmath.html
image_heavy_page=docs-openai/references/078-OpenAI-API-docs-full-documentation.md
image_heavy_links=84
script_removed=true

All 25 manifest dirs also have `references/` (the script's `manifest_dirs_with_references=25`), so
`corpus_dirs` = `manifest_dirs`. `docs_glob_dirs` counts `docs-*` dirs with a manifest (docs-scraper
has none). The tracer is the preferred cmath page.

dir: docs-agno pages=200 url_source=source
dir: docs-anthropic pages=80 url_source=manifest
dir: docs-cloudflare pages=80 url_source=manifest
dir: docs-django pages=80 url_source=manifest
dir: docs-docker pages=76 url_source=manifest
dir: docs-fastapi pages=80 url_source=manifest
dir: docs-gitbook pages=183 url_source=manifest
dir: docs-github pages=78 url_source=manifest
dir: docs-golang pages=69 url_source=manifest
dir: docs-greptile pages=51 url_source=manifest
dir: docs-kubernetes pages=80 url_source=manifest
dir: docs-mdn-web pages=80 url_source=manifest
dir: docs-nextjs pages=80 url_source=manifest
dir: docs-nodejs pages=70 url_source=manifest
dir: docs-openai pages=80 url_source=manifest
dir: docs-postgres pages=80 url_source=manifest
dir: docs-python pages=80 url_source=manifest
dir: docs-react pages=80 url_source=manifest
dir: docs-redis pages=73 url_source=manifest
dir: docs-stripe pages=79 url_source=manifest
dir: docs-supabase pages=50 url_source=manifest
dir: docs-tailwind pages=79 url_source=manifest
dir: docs-typescript pages=80 url_source=manifest
dir: docs-vercel pages=149 url_source=manifest
dir: parallel-web pages=200 url_source=manifest

## Gaps

D-15's expectation (25 dirs, 2,317 pages: the 24 docs-* exports plus parallel-web) holds exactly
(25 corpus dirs, 2,317 pages, 24 docs-* manifest dirs, parallel-web has a manifest), and the URL
sources match research Q4 (2,117 manifest, 200 Source line from docs-agno, 0 root_url, 0 missing).
Differences from research Q4's figures, which were measured on the exports dir (27 exports, 2,321
pages) rather than this checkout — recorded, not corrected; D-15's rule (every manifest dir) stays
the scope:

- redact_changed_pages=294 vs research 295. Cause: different page set (research counted the 27
  exports, 4 pages more); which page accounts for the one-page difference was not measured.
- image_embed_links=2409 in image_embed_pages=386 vs research 2,407 in 385. Cause: not isolated;
  the checkout at library_head is not byte-identical to the exports dir research read [INFERENCE].
- html_img_pages=3 vs research "`<img src>` in 26 pages". Cause: different measure — this plan
  counts the literal `<img src="http`; on this checkout any `<img src` occurs in 17 pages (grep -l),
  and research's 26 covered the exports dir.
- max_page_bytes, pages_over_1mb and max_name_bytes (84) match research.
- The two new redaction shapes (D-11, D-20) have 0 hits in the corpus, as research found for the
  older ragflow / sk-cp shapes.
