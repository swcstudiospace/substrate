#!/usr/bin/env python3
"""
Skeleton tests for lightrag_ingestion_orchestrator (wave 3).

Run: python -m pytest scripts/lightrag_ingestion_orchestrator_test.py -q --tb=line
(requires pytest; mocks used, no live LightRAG)
"""

from __future__ import annotations

import tempfile
from pathlib import Path

import pytest

# bootstrap
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))

from lightrag_ingestion_orchestrator import (
    LightRAGIngestionOrchestrator,
    IngestStatus,
    PROJECTS,
    MockLightRAGClient,
)


def test_projects_list():
    assert len(PROJECTS) == 15
    assert "agent-substrate" in PROJECTS


def test_dry_run_state_machine_and_resume():
    with tempfile.TemporaryDirectory() as td:
        sf = Path(td) / "s.json"
        o = LightRAGIngestionOrchestrator(dry_run=True, state_file=sf)
        assert o.state["agent-substrate"].status == IngestStatus.PENDING.value

        res = o.run(["agent-substrate"])
        assert res["agent-substrate"] == IngestStatus.COMPLETED.value
        ps = o.state["agent-substrate"]
        assert ps.docs_count > 0
        assert ps.sample_entities
        assert ps.sample_relations

        # resume
        o2 = LightRAGIngestionOrchestrator(dry_run=True, state_file=sf)
        assert o2.state["agent-substrate"].status == IngestStatus.COMPLETED.value


def test_mock_client_sample_queries():
    c = MockLightRAGClient()
    q = c.query("test entities", mode="global")
    assert "entities" in q
    assert "relations" in q


def test_degrade_to_mock_when_no_url(monkeypatch):
    monkeypatch.delenv("LIGHTRAG_URL", raising=False)
    monkeypatch.delenv("SUBSTRATE_LIGHTRAG_URL", raising=False)
    o = LightRAGIngestionOrchestrator(dry_run=False)
    assert isinstance(o.client, MockLightRAGClient)


if __name__ == "__main__":
    pytest.main([__file__, "-q"])
