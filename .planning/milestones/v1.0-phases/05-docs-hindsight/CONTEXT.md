# Phase 5: Docs and desktop hindsight - CONTEXT

**Goal**: Product docs and GUI tasks reachable from any agent via substrate.

**Depends on**: Phase 0+

**Current**: RAGFlow (retired, superseded by LightRAG) hosted on Railway, hindsight components. No full proxy yet. Desktop: no KVM, use Docker/webtop.

**Success Criteria**:
1. docs.search proxies RAGFlow (retired, superseded by LightRAG) MCP (ragflow_retrieval).
2. docs.ingest redacts before ingest.
3. desktop.run uses cua Docker or recruitment-desktop webtop.
**Proof**: Agent answers docs with citation; GUI smoke in sandbox.

**v0.3**: Hindsight integration under governance, observability evidence.

**Risks**: External RAGFlow (retired, superseded by LightRAG) auth, redaction for PII in docs.

**Next**: Stub proxy in MCP/CLI, redaction hook, desktop note.
