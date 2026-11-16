# Phase 5: Docs and desktop hindsight - CONTEXT

**Goal**: Product docs and GUI tasks reachable from any agent via substrate.

**Depends on**: Phase 0+

**Current**: RAGFlow (retired) hosted on Railway, hindsight components. No full proxy yet. Desktop: no KVM, use Docker/webtop.

**Success Criteria**:
1. docs.search proxies RAGFlow (retired) MCP (ragflow (retired)_retrieval).
2. docs.ingest redacts before ingest.
3. desktop.run uses cua Docker or recruitment-desktop webtop.
**Proof**: Agent answers docs with citation; GUI smoke in sandbox.

**v0.3**: Hindsight integration under governance, observability evidence.

**Risks**: External RAGFlow (retired) auth, redaction for PII in docs.

**Next**: Stub proxy in MCP/CLI, redaction hook, desktop note.
