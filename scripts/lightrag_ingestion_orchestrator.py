#!/usr/bin/env python3
"""
LightRAG 15-projects ingestion orchestrator (wave 3 / synthesize WORKFLOW).

Implements the orchestrator class for ingesting docs from the 15 projects
into a deployed LightRAG instance.

- State machine: pending -> discovered -> submitted -> polling -> completed | failed
- discover_docs: .md/.txt recursive under <project>/docs
- submit via LightRAG /documents/text (fallback safe)
- poll /documents/pipeline_status with retry: 5s base, 60s cap, max 5 attempts (exp backoff)
- on completed: run sample entity/relation queries (global mode) and log
- on fail: queue for later, continue to next project
- resume from partial state (persist to file by default; --dragonfly-url for Dragonfly/Redis)
- main supports --all or --project <name> ; --dry-run (mocks client, no net)
- retries, validation, structured logging, degradation (no URL -> mock/degrade)
 - No retired backend code paths.

Refs: SPE-33713, n5 (conclusion), n7, wave 3.
See .planning/15-repos-lightrag-ingest-evidence.md and STATE.md for context.
No retired backend.

Acceptance: runs clean on --help / --dry-run; state transitions exercised; sample queries
return under mock; resume skips completed.

Run: python3 scripts/lightrag_ingestion_orchestrator.py --help
Dry verify: python3 scripts/lightrag_ingestion_orchestrator.py --dry-run --project agent-substrate
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
from dataclasses import dataclass, field, asdict
from enum import Enum
from pathlib import Path
from typing import Any, Optional

import httpx
import redis  # Dragonfly compatible (redis protocol)

# --- Config / 15 projects (listed in .planning/15-repos-lightrag-ingest-evidence.md) ---
REPOS_ROOT = Path(os.environ.get("REPOS_ROOT", "/root/src/repos"))
DEFAULT_STATE_FILE = Path(".lightrag_ingest_state.json")
LIGHTRAG_URL_ENV = os.environ.get("LIGHTRAG_URL") or os.environ.get("SUBSTRATE_LIGHTRAG_URL")
LIGHTRAG_API_KEY_ENV = os.environ.get("LIGHTRAG_API_KEY") or os.environ.get("SUBSTRATE_LIGHTRAG_API_KEY")
DRAGONFLY_URL_ENV = os.environ.get("DRAGONFLY_URL")

PROJECTS: list[str] = [
    "agent-realm",
    "agent-substrate",
    "agent-swarm",
    "auctioning",
    "autonogrammer",
    "claude-ultrathink",
    "ClippyOS",
    "desklanes",
    "hypergrok",
    "motion-playbook",
    "trading-desk",
    "spectrumwebco-marketing",
    "token-optimisation",
    "programming-desk",
    "purpleteam",
]

# --- State machine ---
class IngestStatus(str, Enum):
    PENDING = "pending"
    DISCOVERED = "discovered"
    SUBMITTED = "submitted"
    POLLING = "polling"
    COMPLETED = "completed"
    FAILED = "failed"
    QUEUED = "queued"  # for failed that are re-queued


@dataclass
class ProjectState:
    status: str = IngestStatus.PENDING.value
    docs_count: int = 0
    track_ids: list[str] = field(default_factory=list)
    doc_ids: list[str] = field(default_factory=list)
    error: Optional[str] = None
    last_updated: float = field(default_factory=time.time)
    sample_entities: list[str] = field(default_factory=list)
    sample_relations: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> ProjectState:
        return cls(
            status=d.get("status", IngestStatus.PENDING.value),
            docs_count=d.get("docs_count", 0),
            track_ids=d.get("track_ids", []),
            doc_ids=d.get("doc_ids", []),
            error=d.get("error"),
            last_updated=d.get("last_updated", time.time()),
            sample_entities=d.get("sample_entities", []),
            sample_relations=d.get("sample_relations", []),
        )


# --- LightRAG client (minimal, matches upstream v1.5.7 / TS plane) ---
class LightRAGClient:
    def __init__(self, url: str, api_key: Optional[str] = None, timeout: float = 30.0):
        self.base = url.rstrip("/")
        self.headers = {"X-API-Key": api_key} if api_key else {}
        self.client = httpx.Client(timeout=timeout, headers=self.headers)
        self.logger = logging.getLogger("lightrag.client")

    def _post_json(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        resp = self.client.post(f"{self.base}{path}", json=payload)
        resp.raise_for_status()
        return resp.json()

    def _get(self, path: str) -> dict[str, Any]:
        resp = self.client.get(f"{self.base}{path}")
        resp.raise_for_status()
        return resp.json()

    def upload_document(self, name: str, content: str, metadata: Optional[dict[str, Any]] = None) -> str:
        """POST /documents/text -> track_id. Safe for names with special chars."""
        if not content or not content.strip():
            raise ValueError("empty content")
        body = {
            "text": content,
            "file_source": name,
            **(metadata or {}),
        }
        data = self._post_json("/documents/text", body)
        track_id = data.get("track_id") or (data.get("data") or {}).get("track_id")
        if not track_id:
            raise RuntimeError(f"upload returned no track_id: {data}")
        self.logger.info("uploaded name=%s track_id=%s", name, track_id)
        return track_id

    def resolve_document_ids(self, track_id: str, max_polls: int = 5, interval_s: float = 2.0) -> list[str]:
        """GET /documents/track_status/{track_id} -> real doc ids."""
        for _ in range(max_polls):
            try:
                data = self._get(f"/documents/track_status/{track_id}")
                docs = (data.get("documents") or data.get("data", {}).get("documents") or [])
                ids = [d.get("id") for d in docs if d.get("id")]
                if ids:
                    return ids
            except Exception as e:
                self.logger.debug("track poll transient: %s", e)
            time.sleep(interval_s)
        return []

    def scan_documents(self) -> None:
        """POST /documents/scan to trigger pipeline."""
        self._post_json("/documents/scan", {})
        self.logger.info("scan triggered")

    def get_pipeline_status(self) -> dict[str, Any]:
        """GET /documents/pipeline_status"""
        try:
            body = self._get("/documents/pipeline_status")
            if isinstance(body, dict):
                if body.get("busy") is False or (body.get("data") or {}).get("status", "").lower() in ("idle", "done", "completed"):
                    return {"kind": "idle"}
                if body.get("busy") is True:
                    return {"kind": "busy"}
                if "failed" in str(body).lower():
                    return {"kind": "failed", "detail": str(body)[:200]}
            return {"kind": "busy"}
        except Exception as e:
            self.logger.warning("pipeline status error: %s", e)
            return {"kind": "unknown", "error": str(e)}

    def query(self, question: str, mode: str = "global", top_k: int = 5) -> dict[str, Any]:
        """POST /query for entity/relation sampling. Returns graph-aware result when available."""
        payload = {"query": question, "mode": mode, "top_k": top_k}
        try:
            data = self._post_json("/query", payload)
            return data.get("data", data)
        except Exception as e:
            self.logger.error("query failed: %s", e)
            return {"entities": [], "relations": [], "error": str(e)}

    def close(self) -> None:
        self.client.close()


# --- Mock client for dry-run / degradation / tests skeleton ---
class MockLightRAGClient(LightRAGClient):
    def __init__(self):
        self.logger = logging.getLogger("lightrag.mock")
        self._calls: list[str] = []

    def upload_document(self, name: str, content: str, metadata: Optional[dict[str, Any]] = None) -> str:
        track = f"mock-track-{abs(hash(name)) % 10000}"
        self._calls.append(f"upload:{name}")
        self.logger.info("[MOCK] uploaded %s -> %s", name, track)
        return track

    def resolve_document_ids(self, track_id: str, max_polls: int = 5, interval_s: float = 2.0) -> list[str]:
        return [f"mock-doc-{track_id}"]

    def scan_documents(self) -> None:
        self._calls.append("scan")
        self.logger.info("[MOCK] scan")

    def get_pipeline_status(self) -> dict[str, Any]:
        return {"kind": "idle"}

    def query(self, question: str, mode: str = "global", top_k: int = 5) -> dict[str, Any]:
        self._calls.append(f"query:{question[:30]}")
        return {
            "entities": [f"entity-from-{question[:10]}", "LightRAG", "substrate"],
            "relations": ["substrate -> LightRAG", "project -> docs"],
            "chunks": [{"content": "mock sample"}],
        }


# --- Orchestrator with state machine, resume, retries ---
class LightRAGIngestionOrchestrator:
    def __init__(
        self,
        lightrag_url: Optional[str] = None,
        api_key: Optional[str] = None,
        state_file: Optional[Path] = None,
        dragonfly_url: Optional[str] = None,
        dry_run: bool = False,
        max_docs_per_project: int = 30,
        poll_base_s: float = 5.0,
        poll_cap_s: float = 60.0,
        poll_max: int = 5,
    ):
        self.logger = logging.getLogger("lightrag.orchestrator")
        self.dry_run = dry_run
        self.state_file = state_file or DEFAULT_STATE_FILE
        self.dragonfly_url = dragonfly_url
        self.redis_client: Optional[redis.Redis] = None
        self.max_docs = max_docs_per_project
        self.poll_base = poll_base_s
        self.poll_cap = poll_cap_s
        self.poll_max = poll_max

        if self.dragonfly_url:
            try:
                self.redis_client = redis.from_url(self.dragonfly_url, socket_connect_timeout=5)
                self.redis_client.ping()
                self.logger.info("dragonfly connected for state")
            except Exception as e:
                self.logger.warning("dragonfly unavailable, falling back to file: %s", e)
                self.redis_client = None

        url = lightrag_url or LIGHTRAG_URL_ENV
        if dry_run or not url:
            self.client: LightRAGClient = MockLightRAGClient()
            self.logger.info("degraded: using MockLightRAGClient (dry_run=%s, url=%s)", dry_run, bool(url))
        else:
            self.client = LightRAGClient(url, api_key or LIGHTRAG_API_KEY_ENV)
            self.logger.info("connected to LightRAG at %s", url)

        self.state: dict[str, ProjectState] = self._load_state()

    def _load_state(self) -> dict[str, ProjectState]:
        if self.redis_client:
            try:
                raw = self.redis_client.get("lightrag:15-ingest:state")
                if raw:
                    data = json.loads(raw)
                    return {k: ProjectState.from_dict(v) for k, v in data.items()}
            except Exception as e:
                self.logger.warning("dragonfly load failed: %s", e)
        if self.state_file.exists():
            try:
                data = json.loads(self.state_file.read_text())
                return {k: ProjectState.from_dict(v) for k, v in data.items()}
            except Exception as e:
                self.logger.warning("state file load failed: %s", e)
        return {p: ProjectState() for p in PROJECTS}

    def _save_state(self) -> None:
        serial = {k: v.to_dict() for k, v in self.state.items()}
        if self.redis_client:
            try:
                self.redis_client.set("lightrag:15-ingest:state", json.dumps(serial))
                return
            except Exception as e:
                self.logger.warning("dragonfly save failed, using file: %s", e)
        self.state_file.write_text(json.dumps(serial, indent=2))
        self.logger.debug("state persisted to %s", self.state_file)

    def _transition(self, project: str, new_status: IngestStatus, **updates: Any) -> None:
        ps = self.state.setdefault(project, ProjectState())
        old = ps.status
        ps.status = new_status.value
        for k, v in updates.items():
            setattr(ps, k, v)
        ps.last_updated = time.time()
        self.logger.info("state %s: %s -> %s", project, old, new_status.value)
        self._save_state()

    def discover_docs(self, project: str, root: Optional[Path] = None) -> list[Path]:
        """Discover .md/.txt under project/docs (per spec)."""
        base = root or REPOS_ROOT
        docs_dir = base / project / "docs"
        if not docs_dir.is_dir():
            self.logger.warning("%s: no docs/ dir at %s", project, docs_dir)
            return []
        found: list[Path] = []
        for ext in ("*.md", "*.txt"):
            found.extend(docs_dir.rglob(ext))
        found = sorted(set(found))[: self.max_docs]
        self.logger.info("%s: discovered %d docs under %s", project, len(found), docs_dir)
        return found

    def _submit_project(self, project: str, docs: list[Path]) -> list[str]:
        tracks: list[str] = []
        for i, dpath in enumerate(docs):
            try:
                content = dpath.read_text(encoding="utf-8", errors="replace")
                rel = dpath.relative_to(REPOS_ROOT / project)
                name = f"{project}__{str(rel).replace('/', '__')}"
                meta = {
                    "source_url": f"file://{dpath}",
                    "commit": "head",
                    "heading_path": str(rel),
                }
                track = self.client.upload_document(name, content, meta)
                tracks.append(track)
                if (i + 1) % 5 == 0:
                    self.logger.info("submitted %d/%d for %s", i + 1, len(docs), project)
            except Exception as e:
                self.logger.error("upload fail %s: %s", dpath.name, e)
        return tracks

    def _poll_pipeline(self) -> bool:
        """Retry poll: 5s base exp backoff, cap 60s, max 5 attempts."""
        delay = self.poll_base
        for attempt in range(self.poll_max):
            st = self.client.get_pipeline_status()
            kind = st.get("kind", "busy")
            if kind == "idle":
                self.logger.info("pipeline idle (attempt %d)", attempt + 1)
                return True
            if kind == "failed":
                self.logger.error("pipeline failed: %s", st)
                return False
            self.logger.debug("poll %d/%d: %s (sleep %.1fs)", attempt + 1, self.poll_max, kind, delay)
            time.sleep(delay)
            delay = min(delay * 2, self.poll_cap)
        self.logger.warning("poll max attempts reached")
        return False

    def run_sample_queries(self, project: str) -> tuple[list[str], list[str]]:
        """On COMPLETED: sample entity + relation queries and log."""
        q_entities = f"list the primary entities and concepts from the {project} documentation and code"
        q_rels = f"extract key relations between components, agents, and services in {project}"

        ent_res = self.client.query(q_entities, mode="global", top_k=5)
        rel_res = self.client.query(q_rels, mode="global", top_k=5)

        entities = ent_res.get("entities", []) or ent_res.get("graph", {}).get("entities", []) or []
        relations = rel_res.get("relations", []) or rel_res.get("graph", {}).get("relations", []) or []

        entities = [str(e) for e in entities][:5]
        relations = [str(r) for r in relations][:5]

        self.logger.info("%s sample entities: %s", project, entities)
        self.logger.info("%s sample relations: %s", project, relations)
        return entities, relations

    def process_project(self, project: str, root: Optional[Path] = None) -> None:
        if project not in PROJECTS:
            self.logger.error("unknown project %s", project)
            return

        ps = self.state.get(project, ProjectState())
        if ps.status == IngestStatus.COMPLETED.value:
            self.logger.info("%s already COMPLETED (resume skip)", project)
            return
        if ps.status == IngestStatus.FAILED.value:
            self._transition(project, IngestStatus.QUEUED)

        self._transition(project, IngestStatus.DISCOVERED)

        docs = self.discover_docs(project, root=root)
        if not docs:
            self._transition(project, IngestStatus.COMPLETED, docs_count=0)
            self.logger.info("%s: no docs discovered, marked COMPLETED empty (per q3)", project)
            return
        self._transition(project, IngestStatus.DISCOVERED, docs_count=len(docs))

        try:
            tracks = self._submit_project(project, docs)
            if not tracks and not self.dry_run:
                raise RuntimeError("no tracks from submit")
            self._transition(project, IngestStatus.SUBMITTED, track_ids=tracks)

            self.client.scan_documents()
            self._transition(project, IngestStatus.POLLING)

            ok = self._poll_pipeline()
            if ok:
                ents, rels = self.run_sample_queries(project)
                self._transition(
                    project, IngestStatus.COMPLETED, doc_ids=tracks, sample_entities=ents, sample_relations=rels
                )
            else:
                self._transition(project, IngestStatus.FAILED, error="poll failed or timeout")
        except Exception as e:
            self.logger.exception("project %s failed: %s", project, e)
            self._transition(project, IngestStatus.FAILED, error=str(e)[:300])

    def run(self, projects: Optional[list[str]] = None, root: Optional[Path] = None) -> dict[str, str]:
        targets = projects or PROJECTS
        results: dict[str, str] = {}
        for p in targets:
            try:
                self.process_project(p, root=root)
                ps = self.state.get(p, ProjectState())
                results[p] = ps.status
            except Exception as e:
                self.logger.error("orchestrator run error on %s: %s", p, e)
                results[p] = "error"
        self._save_state()
        return results

    def close(self) -> None:
        try:
            self.client.close()
        except Exception:
            pass
        if self.redis_client:
            try:
                self.redis_client.close()
            except Exception:
                pass


# --- CLI / main ---
def main(argv: Optional[list[str]] = None) -> int:
    global REPOS_ROOT
    parser = argparse.ArgumentParser(
        prog="lightrag_ingestion_orchestrator.py",
        description="15-project LightRAG docs ingestion orchestrator (wave 3, SPE-33713, n5/n7). Dry-run and resume supported.",
    )
    group = parser.add_mutually_exclusive_group(required=False)
    group.add_argument("--all", action="store_true", help="process all 15 projects")
    group.add_argument("--project", type=str, help="process a single project by dir name")
    parser.add_argument("--dry-run", action="store_true", help="use mocks, no network, validate state machine")
    parser.add_argument("--state-file", type=Path, default=DEFAULT_STATE_FILE, help="json state persistence path")
    parser.add_argument("--dragonfly-url", type=str, default=DRAGONFLY_URL_ENV, help="use Dragonfly/Redis for state")
    parser.add_argument("--repos-root", type=Path, default=None, help="root containing the 15 checkouts")
    parser.add_argument("--verbose", "-v", action="store_true")
    parser.add_argument("--list-projects", action="store_true", help="list the 15 projects and exit")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    logger = logging.getLogger("main")

    if args.list_projects:
        print(json.dumps(PROJECTS, indent=2))
        return 0

    repos_root = args.repos_root or REPOS_ROOT
    REPOS_ROOT = repos_root

    orch = LightRAGIngestionOrchestrator(
        lightrag_url=None,  # from env or mock
        state_file=args.state_file,
        dragonfly_url=args.dragonfly_url,
        dry_run=args.dry_run,
    )

    try:
        if args.all:
            results = orch.run(PROJECTS, root=repos_root)
            logger.info("ALL results: %s", results)
        elif args.project:
            results = orch.run([args.project], root=repos_root)
            logger.info("PROJECT result: %s", results)
        else:
            parser.print_help()
            return 2

        # quick validation summary
        completed = sum(1 for s in orch.state.values() if s.status == IngestStatus.COMPLETED.value)
        failed = sum(1 for s in orch.state.values() if s.status == IngestStatus.FAILED.value)
        logger.info("run summary: %d completed, %d failed/queued, dry=%s", completed, failed, args.dry_run)
        return 0
    finally:
        orch.close()


if __name__ == "__main__":
    sys.exit(main())
