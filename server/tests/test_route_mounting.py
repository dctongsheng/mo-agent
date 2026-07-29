"""The /api/mo routes must win against the dashboard's catch-all.

The Hermes dashboard registers `GET /{path:path}` at import time. FastAPI
matches in registration order, so mounting our router afterwards means every
/api/mo request is answered by the catch-all with "No such API endpoint" —
hence the re-ordering step at the end of `_mount_mo_routes`.

That step matched on `route.path.startswith("/api/mo")`, which held until
FastAPI 0.140 changed `include_router()` from splicing the router's Route
objects into `app.router.routes` to appending a single lazy `_IncludedRouter`
whose `path` is `""`. The filter then found nothing, the re-order became a
silent no-op, and the entire desktop API 404'd — with no error anywhere,
because nothing had failed.

This test fails on that regression regardless of which FastAPI shape is in use.
"""

from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path

import pytest

_SERVER = Path(__file__).resolve().parent.parent
_GATEWAY = _SERVER / "mo-gateway.py"


@pytest.fixture
def gateway(tmp_hermes_home, monkeypatch):
    """Import mo-gateway.py by path — its filename has a hyphen, so it is not
    importable normally. This is the only test that loads it."""
    agent_root = os.environ.get("HERMES_AGENT_ROOT", "")
    if agent_root and agent_root not in sys.path:
        sys.path.insert(0, agent_root)
    spec = importlib.util.spec_from_file_location("mo_gateway_under_test", _GATEWAY)
    mod = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(mod)
    except Exception as exc:                      # pragma: no cover
        pytest.skip(f"gateway not importable in this environment: {exc}")
    return mod


@pytest.fixture
def app_with_catchall():
    fastapi = pytest.importorskip("fastapi")
    app = fastapi.FastAPI()

    # Registered BEFORE our router, exactly as the dashboard does.
    @app.get("/{path:path}")
    def catchall(path: str):
        return {"detail": f"No such API endpoint: /{path}"}

    return app


def test_mo_routes_are_reachable_past_the_catchall(gateway, app_with_catchall):
    from fastapi.testclient import TestClient

    gateway._mount_mo_routes(app_with_catchall)
    client = TestClient(app_with_catchall)

    for path in ("/api/mo/evolve/status", "/api/mo/evolve/calibration",
                 "/api/mo/evolve/plans", "/api/mo/evolve/schedule",
                 "/api/mo/curator/status", "/api/mo/curator/proposals",
                 "/api/mo/curator/skills", "/api/mo/curator/archived",
                 "/api/mo/learn/status", "/api/mo/learn/drafts",
                 "/api/mo/pending", "/api/mo/pending/review-log"):
        res = client.get(path)
        assert res.status_code == 200, f"{path} -> {res.status_code}"
        assert "No such API endpoint" not in str(res.json()), (
            f"{path} was answered by the dashboard catch-all — the re-order "
            f"in _mount_mo_routes is not recognising this FastAPI's route shape"
        )


def test_the_router_actually_registered_its_routes(gateway, app_with_catchall):
    """Guards the other half: a mount that silently contributes nothing."""
    before = len(app_with_catchall.router.routes)
    gateway._mount_mo_routes(app_with_catchall)
    assert len(app_with_catchall.router.routes) > before


def test_non_mo_paths_still_reach_the_catchall(gateway, app_with_catchall):
    """The re-order must not starve the dashboard's own routing."""
    from fastapi.testclient import TestClient

    gateway._mount_mo_routes(app_with_catchall)
    res = TestClient(app_with_catchall).get("/some/dashboard/path")
    assert res.status_code == 200
    assert "No such API endpoint" in str(res.json())
