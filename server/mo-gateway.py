"""Desktop gateway entry point — starts the full Hermes gateway + web dashboard.

Spawned by Electron as a single child process. Finds free ports for the API
server and the web dashboard, starts both in the same asyncio event loop,
and prints the listening ports to stdout so the main process can connect
the renderer to the gateway and embed the dashboard in an iframe.

Stdout protocol:
    HERMES_PORT:<gateway_port>
    HERMES_DASHBOARD_PORT:<dashboard_port>
"""

from __future__ import annotations

import asyncio
import logging
import os
import socket
import sys
import threading

_HERMES_ROOT = os.environ.get("HERMES_AGENT_ROOT", "")
if _HERMES_ROOT and _HERMES_ROOT not in sys.path:
    sys.path.insert(0, _HERMES_ROOT)


def _load_env() -> None:
    try:
        from hermes_cli.env_loader import load_hermes_dotenv
        from hermes_constants import get_hermes_home
        load_hermes_dotenv(hermes_home=get_hermes_home())
    except Exception:
        pass


def _find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _mount_mo_routes(app) -> None:
    """Extension routes for the Mo desktop app: memory specimens, trajectory
    collection and self-evolution stats. Backed by simple JSON files under
    HERMES_HOME so they survive restarts. Auth is inherited from the dashboard
    app's middleware (Bearer session token)."""
    import json
    import time
    import uuid
    from pathlib import Path

    from fastapi import APIRouter, HTTPException, Request

    # This module uses `from __future__ import annotations`, so parameter
    # annotations are strings that FastAPI resolves against module globals.
    # Request is imported locally — expose it there or every `request: Request`
    # param silently degrades to a required query parameter (422s).
    globals()["Request"] = Request

    home = Path(os.environ.get("HERMES_HOME", os.path.expanduser("~/.hermes")))
    memory_file = home / "memory" / "specimens.json"
    traj_file = home / "trajectories" / "trajectories.jsonl"
    molt_file = home / "trajectories" / "moltings.json"
    lock = threading.Lock()

    def _read_json(p: Path, default):
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            return default

    def _write_json(p: Path, data) -> None:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")

    def _read_trajs() -> list:
        try:
            lines = traj_file.read_text(encoding="utf-8").splitlines()
            return [json.loads(ln) for ln in lines if ln.strip()]
        except Exception:
            return []

    # ---- OpenViking memory backend (optional) ----
    # When OPENVIKING_ENDPOINT is set and the server is healthy, the memory
    # room reads/writes go to OpenViking. Otherwise everything falls back to
    # the local JSON specimen store below. Endpoint shapes mirror the bundled
    # plugins/memory/openviking/__init__.py _VikingClient.
    _OV_USER = os.environ.get("OPENVIKING_USER", "default")
    _OV_ACCOUNT = os.environ.get("OPENVIKING_ACCOUNT", "default")
    _OV_AGENT = os.environ.get("OPENVIKING_AGENT", "hermes")
    _OV_MEM_DIR = f"viking://user/{_OV_USER}/memories"

    def _ov_endpoint() -> str:
        return (os.environ.get("OPENVIKING_ENDPOINT") or "").rstrip("/")

    def _ov_headers() -> dict:
        h = {
            "Content-Type": "application/json",
            "X-OpenViking-Agent": _OV_AGENT,
            "X-OpenViking-Account": _OV_ACCOUNT,
            "X-OpenViking-User": _OV_USER,
        }
        key = os.environ.get("OPENVIKING_API_KEY", "")
        if key:
            h["X-API-Key"] = key
            h["Authorization"] = "Bearer " + key
        return h

    def _ov_healthy() -> bool:
        ep = _ov_endpoint()
        if not ep:
            return False
        try:
            import httpx
            r = httpx.get(ep + "/health", headers=_ov_headers(), timeout=3.0)
            return r.status_code == 200
        except Exception:
            return False

    def _ov_get(path: str, params: dict = None) -> dict:
        import httpx
        r = httpx.get(_ov_endpoint() + path, params=params or {},
                      headers=_ov_headers(), timeout=30.0)
        r.raise_for_status()
        return r.json()

    def _ov_post(path: str, payload: dict = None) -> dict:
        import httpx
        r = httpx.post(_ov_endpoint() + path, json=payload or {},
                       headers=_ov_headers(), timeout=30.0)
        r.raise_for_status()
        return r.json()

    def _ov_unwrap(resp):
        if isinstance(resp, dict) and "result" in resp:
            return resp["result"]
        return resp

    # OpenViking memory category → display source label (matches UI categories)
    _OV_CAT_FROM_URI = ("preferences", "entities", "events", "cases", "patterns")

    def _ov_read_content(uri: str) -> str:
        """Read the raw markdown body of a memory file (best-effort)."""
        try:
            resp = _ov_get("/api/v1/content/read", {"uri": uri})
            body = _ov_unwrap(resp)
            if isinstance(body, str):
                return body
            if isinstance(body, dict):
                return body.get("content") or body.get("text") or ""
        except Exception:
            pass
        return ""

    def _ov_specimen_from_entry(e: dict, *, read_body: bool = False) -> dict:
        """Map an OpenViking fs entry / search hit to the UI's Specimen shape.

        read_body=True reads the raw markdown body via content/read and uses
        it as the card text — this is what the user actually wrote, as opposed
        to OpenViking's VLM-generated abstract/overview. Used for both the
        memory wall (fs/ls has no abstract anyway) and search (whose hits carry
        a verbose overview we want to bypass).
        """
        uri = e.get("uri", "")
        source = next((c for c in _OV_CAT_FROM_URI if f"/{c}/" in uri or uri.endswith("/" + c)), "memories")
        text = ""
        if read_body and uri.endswith(".md"):
            text = _ov_read_content(uri)
        if not text:
            text = e.get("abstract") or e.get("overview") or e.get("name") or uri.rsplit("/", 1)[-1]
        return {
            "id": uri,
            "uri": uri,
            "text": text.strip(),
            "source": source,
            "strength": 1,
            "created_at": e.get("created_at") or e.get("mtime") or time.time(),
        }

    router = APIRouter(prefix="/api/mo")

    # ---- memory specimens ----
    # Request bodies are parsed manually (request.json()) instead of pydantic
    # models: the dashboard app's FastAPI/pydantic combination treats locally
    # defined models as query params, yielding 422s.
    #
    # When OpenViking is configured + healthy these routes are backed by it;
    # otherwise they transparently fall back to the local JSON specimen store.

    @router.get("/memory/status")
    def memory_status():
        if _ov_healthy():
            return {"backend": "openviking", "ready": True, "endpoint": _ov_endpoint()}
        return {"backend": "local", "ready": bool(_ov_endpoint()) is False, "endpoint": _ov_endpoint() or None}

    def _is_real_memory_uri(uri: str) -> bool:
        """A user-written memory file, not an auto-generated directory summary
        (.abstract.md/.overview.md), a trashed item, or a non-memory resource."""
        name = uri.rsplit("/", 1)[-1]
        return (
            "/memories/" in uri
            and "/.trash/" not in uri
            and name.startswith("mem_")
            and name.endswith(".md")
        )

    @router.get("/memory/search")
    def search_memory(q: str = ""):
        if not q.strip():
            return {"data": []}
        if _ov_healthy():
            try:
                resp = _ov_post("/api/v1/search/find", {"query": q, "top_k": 30})
                result = resp.get("result", {}) if isinstance(resp, dict) else {}
                hits = []
                # Only actual memory files — skip OpenViking's L0/L1 directory
                # summaries (.abstract.md/.overview.md) and resources. Show the
                # raw written text, not the VLM overview. And skip stale index
                # entries (a forgotten memory moved to .trash still lingers in
                # the vector index but its file is gone → empty body).
                for item in (result.get("memories") or []):
                    uri = item.get("uri", "")
                    if not _is_real_memory_uri(uri):
                        continue
                    body = _ov_read_content(uri)
                    if not body.strip():
                        continue
                    hits.append({
                        "id": uri, "uri": uri, "text": body.strip(),
                        "source": next((c for c in _OV_CAT_FROM_URI if f"/{c}/" in uri), "memories"),
                        "strength": 1, "created_at": time.time(),
                    })
                return {"data": hits}
            except Exception:
                pass
        # local fallback: substring match
        items = _read_json(memory_file, [])
        ql = q.lower()
        return {"data": [it for it in items if ql in str(it.get("text", "")).lower()]}

    @router.get("/memory")
    def list_memory():
        if _ov_healthy():
            try:
                out = []
                for cat in _OV_CAT_FROM_URI:
                    try:
                        resp = _ov_get("/api/v1/fs/ls", {"uri": f"{_OV_MEM_DIR}/{cat}/"})
                    except Exception:
                        continue
                    raw = _ov_unwrap(resp)
                    entries = raw if isinstance(raw, list) else (
                        raw.get("entries") or raw.get("items") or raw.get("children") or []
                        if isinstance(raw, dict) else []
                    )
                    for e in entries:
                        if isinstance(e, dict) and _is_real_memory_uri(e.get("uri", "")):
                            out.append(_ov_specimen_from_entry(e, read_body=True))
                return {"data": out}
            except Exception:
                pass
        return {"data": _read_json(memory_file, [])}

    @router.post("/memory")
    async def add_memory(request: Request):
        body = await request.json()
        text = str(body.get("text", "")).strip()
        if not text:
            raise HTTPException(400, "text required")
        if _ov_healthy():
            try:
                cat = str(body.get("source", "preferences"))
                if cat not in _OV_CAT_FROM_URI:
                    cat = "preferences"
                uri = f"{_OV_MEM_DIR}/{cat}/mem_{uuid.uuid4().hex[:12]}.md"
                _ov_post("/api/v1/content/write", {"uri": uri, "content": text, "mode": "create"})
                return {"data": {"id": uri, "uri": uri, "text": text, "source": cat,
                                 "strength": 1, "created_at": time.time()}}
            except Exception:
                pass
        with lock:
            items = _read_json(memory_file, [])
            item = {
                "id": uuid.uuid4().hex[:12],
                "text": text,
                "source": str(body.get("source", "手记")),
                "strength": 1,
                "created_at": time.time(),
            }
            items.insert(0, item)
            _write_json(memory_file, items)
        return {"data": item}

    @router.post("/memory/{item_id:path}/strengthen")
    def strengthen_memory(item_id: str):
        # OpenViking has no strength concept — strengthening is a local-only
        # affordance. Succeed as a no-op when the id is an OpenViking URI.
        if item_id.startswith("viking://"):
            return {"data": {"id": item_id, "strength": 1}}
        with lock:
            items = _read_json(memory_file, [])
            for it in items:
                if it["id"] == item_id:
                    it["strength"] = min(3, it.get("strength", 1) + 1)
                    _write_json(memory_file, items)
                    return {"data": it}
        raise HTTPException(404, "specimen not found")

    @router.delete("/memory/{item_id:path}")
    def forget_memory(item_id: str):
        if item_id.startswith("viking://") and _ov_healthy():
            # OpenViking 0.3.x has no delete endpoint — "forget" moves the
            # memory into a per-user .trash/ directory via fs/mv so it drops
            # out of listings and retrieval.
            try:
                name = item_id.rsplit("/", 1)[-1]
                _ov_post("/api/v1/fs/mv", {
                    "from_uri": item_id,
                    "to_uri": f"viking://user/{_OV_USER}/.trash/{uuid.uuid4().hex[:8]}_{name}",
                })
                return {"ok": True}
            except Exception:
                return {"ok": False, "error": "openviking forget failed"}
        with lock:
            items = _read_json(memory_file, [])
            kept = [it for it in items if it["id"] != item_id]
            if len(kept) == len(items):
                raise HTTPException(404, "specimen not found")
            _write_json(memory_file, kept)
        return {"ok": True}

    @router.post("/sessions/{session_id}/commit")
    def commit_session(session_id: str):
        # api_server never fires on_session_end, so the desktop triggers the
        # OpenViking session commit (→ 6-category memory extraction) explicitly
        # when the user starts/switches sessions. Best-effort.
        if _ov_healthy():
            try:
                _ov_post(f"/api/v1/sessions/{session_id}/commit", {})
                return {"ok": True}
            except Exception:
                return {"ok": False}
        return {"ok": False, "skipped": "openviking unavailable"}

    # ---- trajectories ----

    @router.get("/trajectories")
    def list_trajectories(limit: int = 20):
        trajs = _read_trajs()
        return {"data": list(reversed(trajs))[:limit]}

    def _write_trajs(trajs: list) -> None:
        traj_file.parent.mkdir(parents=True, exist_ok=True)
        with traj_file.open("w", encoding="utf-8") as f:
            for t in trajs:
                f.write(json.dumps(t, ensure_ascii=False) + "\n")

    @router.post("/trajectories")
    async def add_trajectory(request: Request):
        # A trajectory is one *episode* (= one chat session), not one turn.
        # Successive turns in the same session are folded into the same
        # trajectory so the specimen number stays stable within a session
        # instead of incrementing on every reply.
        body = await request.json()
        session_id = str(body.get("session_id", "")).strip()
        prompt = str(body.get("prompt", ""))[:2000]
        reply = str(body.get("reply", ""))[:4000]
        model = str(body.get("model", "unknown"))
        duration = int(body.get("duration_ms", 0))
        now = time.time()
        with lock:
            trajs = _read_trajs()
            existing = None
            if session_id:
                for t in trajs:
                    if t.get("session_id") == session_id:
                        existing = t
                        break
            if existing is not None:
                turn = {"prompt": prompt, "reply": reply, "duration_ms": duration, "at": now}
                existing.setdefault("turns_log", []).append(turn)
                existing["prompt"] = prompt   # representative = latest turn
                existing["reply"] = reply
                existing["model"] = model
                existing["turns"] = len(existing["turns_log"])
                existing["duration_ms"] = existing.get("duration_ms", 0) + duration
                existing["updated_at"] = now
                entry = existing
                count = trajs.index(existing) + 1
            else:
                entry = {
                    "id": uuid.uuid4().hex[:12],
                    "session_id": session_id,
                    "prompt": prompt,
                    "reply": reply,
                    "model": model,
                    "turns": 1,
                    "turns_log": [{"prompt": prompt, "reply": reply, "duration_ms": duration, "at": now}],
                    "duration_ms": duration,
                    "label": None,
                    "created_at": now,
                    "updated_at": now,
                }
                trajs.append(entry)
                count = len(trajs)
            _write_trajs(trajs)
        return {"count": count, "turns": entry.get("turns", 1), "data": entry}

    @router.post("/trajectories/{traj_id}/label")
    async def label_trajectory(traj_id: str, request: Request):
        body = await request.json()
        label = body.get("label")
        if label not in ("pos", "neg"):
            raise HTTPException(400, "label must be pos or neg")
        with lock:
            trajs = _read_trajs()
            found = False
            for t in trajs:
                if t["id"] == traj_id:
                    t["label"] = label
                    found = True
            if not found:
                raise HTTPException(404, "trajectory not found")
            traj_file.write_text(
                "".join(json.dumps(t, ensure_ascii=False) + "\n" for t in trajs),
                encoding="utf-8",
            )
        return {"ok": True}

    # ---- moltings (fine-tuning runs) & stats ----
    @router.post("/moltings")
    async def add_molting(request: Request):
        body = await request.json()
        with lock:
            molts = _read_json(molt_file, [])
            molts.append({"at": time.time(), "note": str(body.get("note", ""))})
            _write_json(molt_file, molts)
        return {"count": len(molts)}

    # ---- API key live test ----
    # Cheap read-only probe per provider: 401/403 = bad key, 2xx/429 = good.
    _KEY_PROBES = {
        "deepseek": "https://api.deepseek.com/models",
        "openrouter": "https://openrouter.ai/api/v1/key",
        "openai": "https://api.openai.com/v1/models",
        "xai": "https://api.x.ai/v1/models",
        "anthropic": "https://api.anthropic.com/v1/models",
        "moonshot": "https://api.moonshot.cn/v1/models",
    }

    @router.post("/test-key")
    async def test_key(request: Request):
        import httpx

        body = await request.json()
        provider = str(body.get("provider", "")).lower()
        value = str(body.get("value", "")).strip()
        if not value:
            return {"ok": False, "reachable": True, "message": "先填上钥匙再测。"}
        url = _KEY_PROBES.get(provider)
        if not url:
            return {"ok": True, "reachable": False, "message": "这家供给方没有探针,无法在线验证。"}
        headers = {"Accept": "application/json"}
        if provider == "anthropic":
            headers["x-api-key"] = value
            headers["anthropic-version"] = "2023-06-01"
        else:
            headers["Authorization"] = f"Bearer {value}"
        try:
            with httpx.Client(timeout=httpx.Timeout(10.0)) as client:
                resp = client.get(url, headers=headers)
        except Exception:
            return {"ok": False, "reachable": False, "message": "连不上供给方,检查网络或代理。"}
        if resp.status_code in (401, 403):
            return {"ok": False, "reachable": True, "message": "钥匙被拒绝了,检查一下有没有抄错。"}
        if resp.status_code == 429 or resp.is_success:
            return {"ok": True, "reachable": True, "message": ""}
        return {"ok": False, "reachable": True, "message": f"供给方返回 HTTP {resp.status_code}。"}

    @router.get("/evolution/stats")
    def evolution_stats():
        trajs = _read_trajs()
        specimens = _read_json(memory_file, [])
        molts = _read_json(molt_file, [])
        pos = sum(1 for t in trajs if t.get("label") == "pos")
        neg = sum(1 for t in trajs if t.get("label") == "neg")
        labeled = pos + neg
        return {
            "task_count": len(trajs),
            "specimen_count": len(specimens),
            "labeled_pos": pos,
            "labeled_neg": neg,
            "success_rate": (pos / labeled) if labeled else None,
            "molting_count": len(molts),
            "last_molting": molts[-1] if molts else None,
        }

    # ---- Harness self-evolution: skills via GEPA (vendored pipeline) ----
    # The evolver is a dedicated permanent profile so its skills + evolution
    # artifacts live apart from the user's main profile. Runs spawn the
    # vendored `evolution.skills.evolve_skill` as a subprocess; output lands in
    # a staging dir and is only applied to the profile's SKILL.md on accept.
    import subprocess
    import difflib

    EVOLVER_PROFILE = "ye-mao-evolve"
    _hermes_root = Path(os.environ.get("HERMES_HOME", os.path.expanduser("~/.hermes")))
    _evolver_home = _hermes_root / "profiles" / EVOLVER_PROFILE
    _evolve_dir = _evolver_home / "evolve"
    _schedule_file = _evolve_dir / "schedule.json"
    _server_dir = Path(__file__).resolve().parent
    _vendor_dir = _server_dir / "vendor"

    # Run/schedule/skill-listing state lives in an importable module so it can
    # be unit-tested — this file's name has a hyphen and everything below is
    # inside a closure, so nothing here is reachable from a test.
    if str(_server_dir) not in sys.path:
        sys.path.insert(0, str(_server_dir))
    from mo_evolve.store import EvolveStore
    from mo_evolve import skill_archive as _archive
    from mo_evolve import accept as _accept
    from mo_evolve import reflect as _reflect
    from mo_evolve import verify as _verify

    _store = EvolveStore(_hermes_root)
    _evolve_lock = _store.lock  # also serializes the fine-tune run ledger below

    # Eval/optimizer models route through DSPy→LiteLLM at the OpenAI-compatible
    # endpoint configured for the gateway (OPENAI_API_BASE/KEY). Fall back to
    # whatever the user has set; these defaults match the bundled qwen gateway.
    # Evolution model config is now user-editable via Settings → 模型配置,
    # persisted to ~/.hermes-mo/mo-config/evolve.json. Precedence for each
    # value: that file → env override → ov.conf / qwen defaults (so leaving a
    # field blank preserves the prior behaviour).
    _evolve_model_cfg_file = _hermes_root / "mo-config" / "evolve.json"

    def _read_evolve_model_cfg() -> dict:
        return _read_json(_evolve_model_cfg_file, {})

    def _evolve_models() -> tuple[str, str]:
        c = _read_evolve_model_cfg()
        opt = (c.get("optimizer_model") or "").strip() or os.environ.get("MO_EVOLVE_OPTIMIZER_MODEL", "openai/qwen3.6-plus")
        ev = (c.get("eval_model") or "").strip() or os.environ.get("MO_EVOLVE_EVAL_MODEL", "openai/qwen3.5-flash")
        return opt, ev

    def _qualify(model: str) -> str:
        """DSPy/LiteLLM needs a provider prefix. The PUT handler adds it, but a
        hand-edited evolve.json or an env override won't have it."""
        m = (model or "").strip()
        return ("openai/" + m) if (m and "/" not in m) else m

    def _critic_model() -> str:
        """Model for the cross-model review. Defaults to the eval model, which
        already differs from the optimizer — a critic sharing the author's
        weights shares its blind spots and rubber-stamps."""
        c = _read_evolve_model_cfg()
        m = (c.get("critic_model") or "").strip() or os.environ.get("MO_EVOLVE_CRITIC_MODEL", "")
        if m:
            return _qualify(m)
        opt, ev = _evolve_models()
        return ev if ev != opt else ""

    def _reflect_model() -> str:
        """Model 夜貘 reasons with when choosing a target."""
        c = _read_evolve_model_cfg()
        m = (c.get("reflect_model") or "").strip() or os.environ.get("MO_EVOLVE_REFLECT_MODEL", "")
        return _qualify(m) if m else _evolve_models()[0]

    def _evolve_eval_creds() -> tuple[str, str]:
        """OpenAI-compatible base+key for evaluation. Precedence: evolve.json →
        MO_EVOLVE_* env → the embedding gateway in ~/.openviking/ov.conf."""
        c = _read_evolve_model_cfg()
        base = (c.get("api_base") or "").strip() or os.environ.get("MO_EVOLVE_API_BASE", "")
        key = (c.get("api_key") or "").strip() or os.environ.get("MO_EVOLVE_API_KEY", "")
        if base and key:
            return base, key
        try:
            ovc = json.loads((Path(os.path.expanduser("~/.openviking/ov.conf"))).read_text(encoding="utf-8"))
            dense = (ovc.get("embedding") or {}).get("dense") or {}
            base = base or dense.get("api_base", "")
            key = key or dense.get("api_key", "")
        except Exception:
            pass
        return base, key

    def _engine_ready() -> tuple[bool, str]:
        try:
            import dspy  # noqa: F401
        except Exception:
            return False, "dspy 未安装"
        if not (_vendor_dir / "evolution" / "skills" / "evolve_skill.py").exists():
            return False, "进化流水线未随包"
        if not (_hermes_root / "skills").exists():
            return False, "技艺目录未就绪"
        return True, ""

    # Skill listing, built-in classification and run bookkeeping now live in
    # mo_evolve.store (importable → unit-tested). Evolution operates on the
    # user's real skills dir (~/.hermes-mo/skills), where skills they author
    # show up — not the evolver-profile clone. So a newly-created skill is
    # immediately evolvable; accept writes back to the file the user owns.
    _skills_dir = _store.skills_dir
    _list_evolver_skills = _store.list_skills

    _read_runs = _store.read_runs
    _write_runs = _store.write_runs
    _update_run = _store.update_run

    def _verify_quietly(run_id: str) -> None:
        """Score the run's plan, if it has one. Never raises — a bookkeeping
        failure must not change the run's recorded outcome."""
        try:
            _verify.verify_run(_store, _store.get_run(run_id))
        except Exception as exc:
            logging.getLogger("hermes.desktop").warning("verify plan failed: %s", exc)

    def _spawn_evolution(skill: str, iterations: int, eval_source: str,
                         plan: dict | None = None) -> dict:
        ok, why = _engine_ready()
        if not ok:
            return {"ok": False, "reason": why}
        run_id = uuid.uuid4().hex[:12]
        run_cwd = _evolve_dir / "runs" / run_id
        run_cwd.mkdir(parents=True, exist_ok=True)
        opt_model, eval_model = _evolve_models()
        env = dict(os.environ)
        # The vendored engine imports `mo_evolve.*` defensively (try/except
        # ImportError) for the tiered judge and the safety scan, so the server
        # dir has to be on the subprocess path too — otherwise every run
        # silently falls back to the keyword-overlap heuristic.
        env["PYTHONPATH"] = os.pathsep.join(
            [str(_vendor_dir), str(_server_dir)] + ([env["PYTHONPATH"]] if env.get("PYTHONPATH") else [])
        )
        env["HERMES_AGENT_REPO"] = str(_hermes_root)  # find_skill scans ~/.hermes-mo/skills
        # Eval/optimizer go through DSPy→LiteLLM at an OpenAI-compatible
        # endpoint. Prefer explicit MO_EVOLVE_* overrides; otherwise reuse the
        # OpenAI-compatible gateway the user already configured for OpenViking
        # embeddings (~/.openviking/ov.conf), which is the same qwen gateway.
        base, key = _evolve_eval_creds()
        if base:
            env["OPENAI_API_BASE"] = base
        if key:
            env["OPENAI_API_KEY"] = key
        cmd = [
            sys.executable, "-m", "evolution.skills.evolve_skill",
            "--skill", skill, "--iterations", str(iterations),
            "--eval-source", eval_source,
            "--optimizer-model", opt_model, "--eval-model", eval_model,
        ]
        critic_model = _critic_model()
        if critic_model:
            cmd += ["--critic-model", critic_model]
        # The critic is asked whether the rewrite addresses 夜貘's hypothesis,
        # so it needs to know what that hypothesis was.
        if plan and plan.get("hypothesis"):
            env["MO_EVOLVE_HYPOTHESIS"] = plan["hypothesis"]
        log_path = run_cwd / "run.log"
        entry = {
            "id": run_id, "skill": skill, "iterations": iterations,
            "eval_source": eval_source, "status": "running",
            "created_at": time.time(), "cwd": str(run_cwd),
            "opt_model": opt_model, "eval_model": eval_model,
        }
        if plan:
            # Carried as fields so the runs list can show WHY without a join.
            entry["plan_id"] = plan.get("id")
            entry["why"] = plan.get("why", "")[:400]
        _store.insert_run(entry)

        def _runner():
            try:
                with log_path.open("w", encoding="utf-8") as logf:
                    proc = subprocess.run(cmd, cwd=str(run_cwd), env=env,
                                          stdout=logf, stderr=subprocess.STDOUT)
                rc = proc.returncode
            except Exception as exc:
                _update_run(run_id, status="failed", error=str(exc), finished_at=time.time())
                return
            # Locate the newest output dir produced by the pipeline
            out_root = run_cwd / "output" / skill
            latest = None
            if out_root.exists():
                subdirs = [d for d in out_root.iterdir() if d.is_dir()]
                if subdirs:
                    latest = max(subdirs, key=lambda d: d.stat().st_mtime)
            if latest and (latest / "evolved_skill.md").exists():
                _update_run(run_id, status="done", output_dir=str(latest),
                            finished_at=time.time(), rc=rc)
                # Score 夜貘's prediction now, not on accept: the claim is about
                # whether the rewrite worked, which is independent of whether
                # the user chose to keep it.
                _verify_quietly(run_id)
                return
            # A candidate rejected by the hard constraints writes
            # evolved_FAILED.md + failed_constraints.json directly under
            # output/<skill>/ — no timestamped subdir, because the pipeline
            # returns before creating one. Record that directory anyway: a run
            # rejected *for* a prompt-injection finding is exactly the one whose
            # findings someone needs to read, and without this it survived only
            # as one line in run.log.
            failed = (out_root / "evolved_FAILED.md") if out_root.exists() else None
            if failed is not None and failed.exists():
                reasons = _read_json(out_root / "failed_constraints.json", {})
                bad = [c.get("name") for c in reasons.get("constraints", [])
                       if not c.get("passed")]
                _update_run(run_id, status="failed", output_dir=str(out_root),
                            constraints_failed=True,
                            error="候选未通过硬约束：" + ("、".join(bad) if bad else "见 run.log"),
                            finished_at=time.time(), rc=rc)
                _verify_quietly(run_id)
                return
            _update_run(run_id, status="failed",
                        output_dir=str(latest) if latest else "",
                        error="未产出 evolved_skill（见 run.log）",
                        finished_at=time.time(), rc=rc)
            # Stamp the plan even here. A failed run produces no holdout scores,
            # so the prediction lands in `unverifiable` — which is what
            # verify.py documents, and it was previously dropped entirely.
            _verify_quietly(run_id)

        threading.Thread(target=_runner, daemon=True, name=f"evolve-{run_id}").start()
        return {"ok": True, "run_id": run_id}

    @router.get("/evolve/status")
    def evolve_status():
        ok, why = _engine_ready()
        opt, ev = _evolve_models()
        return {"ready": ok, "reason": why, "profile": EVOLVER_PROFILE,
                "optimizer_model": opt, "eval_model": ev}

    @router.get("/evolve/skills")
    def evolve_skills():
        return {"data": _list_evolver_skills()}

    @router.post("/evolve/run")
    async def evolve_run(request: Request):
        body = await request.json()
        skill = str(body.get("skill", "")).strip()
        if not skill:
            raise HTTPException(400, "skill required")
        iterations = max(1, min(20, int(body.get("iterations", 4))))
        eval_source = str(body.get("eval_source", "mixed"))
        if eval_source not in ("synthetic", "sessiondb", "trajectory", "mixed"):
            eval_source = "mixed"
        # Carry the plan through when this run came from 夜貘 picking the target.
        # Without it the prediction is saved, never attached to a run, and so
        # never verified — the tally would only ever reflect scheduled runs,
        # which is not the path the 「让夜貘自己挑一条」 button drives.
        plan = None
        plan_id = str(body.get("plan_id", "")).strip()
        if plan_id:
            plan = _reflect.get_plan(_store, plan_id)
            if plan and plan.get("skill") != skill:
                plan = None      # the user changed the target; the plan no longer applies
        return _spawn_evolution(skill, iterations, eval_source, plan=plan)

    @router.get("/evolve/runs")
    def evolve_runs():
        return {"data": _read_runs()}

    @router.get("/evolve/runs/{run_id}")
    def evolve_run_detail(run_id: str):
        runs = _read_runs()
        run = next((r for r in runs if r["id"] == run_id), None)
        if not run:
            raise HTTPException(404, "run not found")
        result = dict(run)
        if run.get("plan_id"):
            result["plan"] = _reflect.get_plan(_store, run["plan_id"])
        out = run.get("output_dir")
        if out:
            od = Path(out)
            base = (od / "baseline_skill.md")
            met = (od / "metrics.json")
            base_txt = base.read_text(encoding="utf-8") if base.exists() else ""

            # A constraint-rejected run has no evolved_skill.md — its candidate
            # is evolved_FAILED.md, one directory up from where a passing run
            # would put things. Show it: the user still needs to see WHAT was
            # rejected and why, especially for an injection finding.
            evo = (od / "evolved_skill.md")
            if not evo.exists() and (od / "evolved_FAILED.md").exists():
                evo = od / "evolved_FAILED.md"
            evo_txt = evo.read_text(encoding="utf-8") if evo.exists() else ""

            # The live skill stands in for the baseline when the pipeline never
            # got far enough to save one, so the diff is still meaningful.
            if not base_txt and evo_txt:
                live = _store.find_skill_file(run["skill"])
                if live:
                    base_txt = live.read_text(encoding="utf-8")

            result["baseline"] = base_txt
            result["evolved"] = evo_txt
            result["metrics"] = _read_json(met, {}) if met.exists() else {}
            result["gate"] = _read_json(od / "gate.json", None)
            result["critic"] = _read_json(od / "critic.json", None)

            safety = _read_json(od / "safety.json", None)
            failed = _read_json(od / "failed_constraints.json", None)
            if failed:
                result["constraints"] = failed.get("constraints", [])
                # Findings from the rejected candidate live here, not in
                # safety.json — the pipeline returns before writing that.
                if failed.get("safety_findings"):
                    safety = {"findings": failed["safety_findings"]}
            result["safety"] = safety
            result["diff"] = "".join(difflib.unified_diff(
                base_txt.splitlines(keepends=True),
                evo_txt.splitlines(keepends=True),
                fromfile="baseline", tofile="evolved",
            ))
            # Has the live skill drifted from what this run started against?
            # Accepting a stale candidate silently discards the user's edits.
            tgt = _store.find_skill_file(run["skill"])
            if tgt and base_txt:
                result["stale_baseline"] = (
                    _archive.sha256_file(tgt) != _archive.sha256_text(base_txt))
        return result

    @router.post("/evolve/runs/{run_id}/accept")
    async def evolve_accept(run_id: str, request: Request):
        """Apply an evolved skill — but only past the gate, and never without a
        way back.

        Before: a bare `target.write_text(evolved)`. No backup, no rollback, no
        significance check, and no comparison against what the file currently
        holds — so a nightly run accepted hours later silently clobbered every
        hand edit made in between.
        """
        try:
            body = await request.json()
        except Exception:
            body = {}
        run = _store.get_run(run_id)
        if not run or not run.get("output_dir"):
            raise HTTPException(404, "run or output not found")
        target = _store.find_skill_file(run["skill"])
        if target is None:
            raise HTTPException(404, "target skill not found")
        try:
            result = _accept.apply_run(_store, run, target,
                                       force=bool(body.get("force", False)))
        except _accept.AcceptRefused as refused:
            # 409 = "we can do this, but not without you saying so again."
            raise HTTPException(409, detail=refused.to_detail())
        return result.to_dict()

    @router.get("/evolve/plans")
    def evolve_plans(limit: int = 30):
        return {"data": _reflect.list_plans(_store, limit)}

    @router.get("/evolve/calibration")
    def evolve_calibration():
        """夜貘's prediction hit rate.

        The number that makes the reasoning worth something: it goes *down*
        when 夜貘 is wrong, which is what separates a reasoning step from
        activity reporting.
        """
        cal = _verify.read_calibration(_store)
        return {**cal, "accuracy": _verify.accuracy(cal)}

    @router.post("/evolve/reflect")
    def evolve_reflect():
        """Run reflection on demand — 「让夜貘现在想一想」."""
        ok, why = _engine_ready()
        if not ok:
            return {"ok": False, "reason": why}
        try:
            plan = _reflect_now()
        except Exception as exc:
            return {"ok": False, "reason": str(exc)}
        if not plan:
            return {"ok": True, "abstained": True,
                    "reason": "证据不足,夜貘这次没有挑出该磨的技艺。"}
        return {"ok": True, "abstained": False, "data": plan}

    @router.get("/evolve/skills/{skill}/versions")
    def evolve_skill_versions(skill: str):
        return {"data": _archive.list_versions(_store.archive_dir, skill),
                "head": _archive.read_head(_store.archive_dir, skill)}

    @router.post("/evolve/skills/{skill}/revert")
    async def evolve_skill_revert(skill: str, request: Request):
        try:
            body = await request.json()
        except Exception:
            body = {}
        version = body.get("version")
        target = _store.find_skill_file(skill)
        if target is None:
            raise HTTPException(404, "target skill not found")
        ok, msg = _archive.revert(_store.archive_dir, target, skill,
                                  int(version) if version is not None else None)
        if not ok:
            raise HTTPException(400, msg)
        _write_json(_store.pending_file, {"skill": skill, "at": time.time(),
                                          "reverted": True})
        return {"ok": True, "message": msg, "activation": "next_session"}

    @router.post("/evolve/runs/{run_id}/reject")
    def evolve_reject(run_id: str):
        _update_run(run_id, status="rejected", rejected_at=time.time())
        return {"ok": True}

    @router.get("/evolve/runs/{run_id}/log")
    def evolve_run_log(run_id: str, tail: int = 400):
        run = next((r for r in _read_runs() if r["id"] == run_id), None)
        if not run:
            raise HTTPException(404, "run not found")
        log_path = Path(run.get("cwd", "")) / "run.log"
        if not log_path.exists():
            return {"data": "", "exists": False, "total_lines": 0}
        try:
            lines = log_path.read_text(encoding="utf-8", errors="replace").splitlines()
        except Exception as exc:
            return {"data": "", "exists": True, "error": str(exc), "total_lines": 0}
        # Drop noise: LiteLLM botocore warnings and bare tqdm progress-bar
        # repaint lines, keep everything else (incl. GEPA iteration logs).
        clean = []
        for ln in lines:
            if "LiteLLM:WARNING" in ln or "botocore" in ln:
                continue
            stripped = ln.strip()
            if stripped.endswith("it/s]") or stripped.endswith("rollouts/s]"):
                continue
            clean.append(ln)
        total = len(clean)
        if tail and total > tail:
            clean = clean[-tail:]
        return {"data": "\n".join(clean), "exists": True, "total_lines": total}

    @router.get("/evolve/schedule")
    def evolve_get_schedule():
        sched = _read_json(_schedule_file, None) or {}
        return {"enabled": bool(sched.get("enabled", False)),
                "hour": int(sched.get("hour", 3)), "minute": int(sched.get("minute", 0)),
                "skill": sched.get("skill", "auto"),
                "iterations": int(sched.get("iterations", 4)),
                "eval_source": sched.get("eval_source", "mixed"),
                "reflect": bool(sched.get("reflect", True))}

    @router.put("/evolve/schedule")
    async def evolve_set_schedule(request: Request):
        body = await request.json()
        sched = {
            "enabled": bool(body.get("enabled", False)),
            "hour": max(0, min(23, int(body.get("hour", 3)))),
            "minute": max(0, min(59, int(body.get("minute", 0)))),
            "skill": str(body.get("skill", "auto")) or "auto",
            "iterations": max(1, min(20, int(body.get("iterations", 4)))),
            "eval_source": (str(body.get("eval_source", "mixed"))
                            if body.get("eval_source") in ("synthetic", "trajectory", "mixed")
                            else "mixed"),
            "reflect": bool(body.get("reflect", True)),
        }
        _evolve_dir.mkdir(parents=True, exist_ok=True)
        _write_json(_schedule_file, sched)
        return {"ok": True, "data": sched}

    def _ensure_soul() -> None:
        """Seed 夜貘's constitution if it's missing.

        Deliberately outside _ensure_evolver_profile's early return: that bails
        as soon as the profile directory exists, so on any install created
        before reflection landed the SOUL.md would never be written — and it is
        now read on every reflection rather than being decoration.
        """
        # Deliberately does NOT mkdir. hermes_cli.profiles.list_profiles()
        # treats any directory under profiles/ as an existing profile — no
        # marker file needed — so creating this directory early makes
        # create_profile() skip, leaving a husk with no config.yaml, no .env
        # and no seeded dirs. It would also permanently defeat the self-heal
        # below: a user who deletes the profile could never get it re-cloned.
        if not _evolver_home.exists():
            return
        soul = _evolver_home / "SOUL.md"
        try:
            cur = soul.read_text(encoding="utf-8") if soul.exists() else ""
        except Exception as exc:
            logging.getLogger("hermes.desktop").warning("read SOUL.md failed: %s", exc)
            return

        # Replace when missing, empty, or still the stock Hermes soul. The
        # profile is cloned from `default` with clone_config=True, which copies
        # that soul in — so seeding only-if-absent left 夜貘 reasoning as a
        # generic assistant, which is not a persona that knows it is supposed to
        # abstain rather than pick a target at random.
        #
        # Comparing against the stock text (rather than, say, looking for 夜貘)
        # means a constitution the user has written is never clobbered.
        stock = ""
        try:
            from hermes_cli.default_soul import DEFAULT_SOUL_MD  # type: ignore
            stock = DEFAULT_SOUL_MD.strip()
        except Exception:
            pass

        if cur.strip() and cur.strip() != stock:
            return                       # user-authored, or already 夜貘's
        try:
            soul.write_text(_reflect.DEFAULT_CONSTITUTION, encoding="utf-8")
            logging.getLogger("hermes.desktop").info("seeded 夜貘 constitution at %s", soul)
        except Exception as exc:
            logging.getLogger("hermes.desktop").warning("seed SOUL.md failed: %s", exc)

    def _ensure_evolver_profile() -> None:
        """Make sure the permanent 夜貘（进化）profile exists with seeded skills.
        Runs once on startup; recreates it if the user/anything deleted it."""
        if _evolver_home.exists() and (_evolver_home / "skills").exists():
            _ensure_soul()   # existing install: only the constitution may be missing
            return
        try:
            sys.path.insert(0, os.environ.get("HERMES_AGENT_ROOT", ""))
            from hermes_cli import profiles as _P  # type: ignore
            names = [p.name for p in _P.list_profiles()]
            if EVOLVER_PROFILE not in names:
                path = _P.create_profile(name=EVOLVER_PROFILE, clone_from="default", clone_config=True)
            else:
                path = _evolver_home
            try:
                _P.seed_profile_skills(path, quiet=True)
            except Exception:
                pass
            # Give it an identity — the constitution is read on every
            # reflection, so it has to exist wherever the profile landed.
            soul = Path(path) / "SOUL.md"
            if not soul.exists():
                soul.write_text(_reflect.DEFAULT_CONSTITUTION, encoding="utf-8")
            _ensure_soul()
        except Exception as exc:
            logging.getLogger("hermes.desktop").warning("ensure evolver profile failed: %s", exc)

    threading.Thread(target=_ensure_evolver_profile, daemon=True, name="ensure-evolver").start()

    # Nightly scheduler. When skill == "auto", 夜貘 reads its constitution, the
    # recent 差评 trajectories and its own track record, and picks a target with
    # a reason and a falsifiable prediction. Alphabetical rotation remains as
    # the fallback for when it can't or won't choose.
    _next_auto_skill = _store.next_auto_skill
    _traj_file_path = _hermes_root / "trajectories" / "trajectories.jsonl"

    def _reflect_now() -> dict | None:
        """One structured LLM call. Returns a saved plan, or None to abstain."""
        return _reflect.choose_target(
            _store, _traj_file_path, _evolver_home / "SOUL.md", _reflect_model())

    def _fire_scheduled(sched: dict) -> None:
        """Pick a target and start a run. Runs on its own thread — reflection
        makes an LLM call, and the scheduler ticks every 30 seconds."""
        try:
            # Check before reflecting: bailing out afterwards would leave a
            # saved plan with a prediction attached to no run, permanently
            # unverifiable.
            if any(r.get("status") == "running" for r in _read_runs()):
                return
            skill = sched.get("skill", "auto")
            plan = None
            if skill == "auto":
                if sched.get("reflect", True):
                    try:
                        plan = _reflect_now()
                    except Exception as exc:
                        logging.getLogger("hermes.desktop").warning("reflection failed: %s", exc)
                if plan:
                    skill = plan["skill"]
                else:
                    # Abstained or errored — rotation is the safety net, never
                    # removed, so a bad reflection model can't stall evolution.
                    skill = _next_auto_skill()
            if not skill:
                return
            if any(r.get("status") == "running" for r in _read_runs()):
                return          # don't double-fire
            iterations = int((plan or {}).get("iterations") or sched.get("iterations", 4))
            source = (plan or {}).get("eval_source") or sched.get("eval_source", "mixed")
            _spawn_evolution(skill, iterations, source, plan=plan)
        except Exception as exc:
            logging.getLogger("hermes.desktop").warning("scheduled evolution failed: %s", exc)

    def _scheduler_loop():
        last_fire_day = None
        while True:
            try:
                sched = _read_json(_schedule_file, None)
                if sched and sched.get("enabled"):
                    now = time.localtime()
                    key = (now.tm_year, now.tm_yday, sched["hour"], sched["minute"])
                    if (now.tm_hour == sched["hour"] and now.tm_min == sched["minute"]
                            and key != last_fire_day):
                        last_fire_day = key
                        threading.Thread(target=_fire_scheduled, args=(dict(sched),),
                                         daemon=True, name="evolve-fire").start()
            except Exception:
                pass
            time.sleep(30)

    threading.Thread(target=_scheduler_loop, daemon=True, name="evolve-scheduler").start()

    # --- Skip semantic memory recall for short/trivial messages ----------
    # A bare "你好"/"在吗"/"谢谢" gains nothing from a vector search, but the
    # OpenViking plugin still fires a background embed (queue_prefetch) and the
    # next turn blocks up to 3s joining it (prefetch). We wrap both to early-out
    # when the message is shorter than MO_RECALL_MIN_CHARS (default 6 chars), so
    # short greetings never trigger an embed and never wait on one.
    #
    # The recall lives in the *bundled* openviking plugin, which Hermes loads
    # before any user-dir copy (find_provider_dir: bundled wins) — so a shipped
    # override can't replace it. Instead we monkeypatch the class in-place: we
    # pre-load the bundled module into sys.modules["plugins.memory.openviking"]
    # (no network — __init__/register only set fields), patch its methods, and
    # the agent later reuses our cached, patched module for every session.
    def _install_recall_skip() -> None:
        try:
            from plugins.memory import load_memory_provider  # noqa: F401

            # Populate sys.modules with the bundled module (safe: no network).
            load_memory_provider("openviking")
            mod = sys.modules.get("plugins.memory.openviking")
            cls = getattr(mod, "OpenVikingMemoryProvider", None) if mod else None
            if cls is None or getattr(cls.queue_prefetch, "_mo_recall_skip", False):
                return

            def _min_chars() -> int:
                try:
                    return int(os.environ.get("MO_RECALL_MIN_CHARS", "6") or "0")
                except Exception:
                    return 0

            def _is_short(query) -> bool:
                m = _min_chars()
                return bool(m) and len((query or "").strip()) < m

            _orig_queue = cls.queue_prefetch
            _orig_prefetch = cls.prefetch

            def queue_prefetch(self, query, *, session_id=""):
                # Don't embed short/trivial messages (你好 …).
                if _is_short(query):
                    return None
                return _orig_queue(self, query, session_id=session_id)

            def prefetch(self, query, *, session_id=""):
                # Don't block the turn waiting on a recall we skipped.
                if _is_short(query):
                    return ""
                return _orig_prefetch(self, query, session_id=session_id)

            queue_prefetch._mo_recall_skip = True
            prefetch._mo_recall_skip = True
            cls.queue_prefetch = queue_prefetch
            cls.prefetch = prefetch
            logging.getLogger("hermes.desktop").info(
                "recall-skip installed (MO_RECALL_MIN_CHARS=%s)", _min_chars()
            )
        except Exception as exc:
            logging.getLogger("hermes.desktop").warning("recall-skip install failed: %s", exc)

    threading.Thread(target=_install_recall_skip, daemon=True, name="recall-skip").start()

    # ====================================================================
    # Model self-evolution (fine-tuning): local-model service + datasets +
    # a fine-tune runner scaffold. Gated on (1) train/test datasets ready
    # (train >= 100 rows) and (2) the agent chatting with a local model.
    # ====================================================================
    import shutil
    import platform
    import re

    _OLLAMA_URL = "http://127.0.0.1:11434"
    _mo_config_dir = _hermes_root / "mo-config"
    _ft_config_file = _mo_config_dir / "finetune.json"
    _ft_datasets_dir = _mo_config_dir / "datasets"
    _ft_runs_file = _mo_config_dir / "finetune_runs.json"
    _ft_runs_dir = _mo_config_dir / "finetune_runs"
    _LOCAL_PROVIDERS = ("ollama", "local", "llama", "lmstudio", "llamacpp", "vllm", "custom")

    # ---- local model service (Ollama) ----
    def _ollama_installed() -> str:
        return shutil.which("ollama") or ""

    def _ollama_tags() -> list:
        try:
            import httpx
            r = httpx.get(f"{_OLLAMA_URL}/api/tags", timeout=3.0)
            if r.status_code == 200:
                return r.json().get("models", []) or []
        except Exception:
            pass
        return []

    @router.get("/local/status")
    def local_status():
        installed = _ollama_installed()
        running = False
        if installed:
            try:
                import httpx
                running = httpx.get(f"{_OLLAMA_URL}/api/tags", timeout=2.0).status_code == 200
            except Exception:
                running = False
        # is the current chat model local?
        try:
            cfg = _read_config_model()
            prov = str(cfg.get("provider", "")).lower()
            base = str(cfg.get("base_url", ""))
            local_active = any(k in prov for k in _LOCAL_PROVIDERS) or "11434" in base or "localhost" in base or "127.0.0.1" in base
            current = cfg.get("default") or cfg.get("model") or ""
        except Exception:
            local_active, current, prov = False, "", ""
        return {"installed": bool(installed), "running": running,
                "endpoint": _OLLAMA_URL, "local_active": bool(local_active),
                "current_model": current, "current_provider": prov}

    @router.get("/local/models")
    def local_models():
        return {"data": [{"name": m.get("name", ""), "size": m.get("size", 0)} for m in _ollama_tags()]}

    @router.post("/local/pull")
    async def local_pull(request: Request):
        body = await request.json()
        model = str(body.get("model", "")).strip()
        if not model:
            raise HTTPException(400, "model required")
        if not _ollama_installed():
            return {"ok": False, "reason": "ollama 未安装"}
        # fire-and-forget; client polls /local/models
        try:
            subprocess.Popen(["ollama", "pull", model],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception as exc:
            return {"ok": False, "reason": str(exc)}
        return {"ok": True}

    def _read_config_model() -> dict:
        """Parse the `model:` block from ~/.hermes-mo/config.yaml (best-effort,
        line-based — avoids a hard yaml dependency)."""
        out = {}
        cfg_path = _hermes_root / "config.yaml"
        try:
            lines = cfg_path.read_text(encoding="utf-8").splitlines()
        except Exception:
            return out
        in_model = False
        for ln in lines:
            if re.match(r"^model:\s*$", ln):
                in_model = True
                continue
            if in_model and re.match(r"^\S", ln):
                break
            if in_model:
                m = re.match(r"^\s+(provider|default|model|base_url):\s*(.*)$", ln)
                if m:
                    out[m.group(1)] = m.group(2).strip().strip("'\"")
        return out

    @router.post("/local/use")
    async def local_use(request: Request):
        body = await request.json()
        model = str(body.get("model", "")).strip()
        if not model:
            raise HTTPException(400, "model required")
        cfg_path = _hermes_root / "config.yaml"
        try:
            lines = cfg_path.read_text(encoding="utf-8").splitlines()
        except Exception:
            raise HTTPException(500, "config.yaml not readable")
        # Rewrite the model: block to point at the local Ollama OpenAI endpoint.
        new_block = [
            "model:",
            "  provider: custom",
            f"  default: {model}",
            "  base_url: http://localhost:11434/v1",
        ]
        out, i, n = [], 0, len(lines)
        replaced = False
        while i < n:
            if re.match(r"^model:\s*$", lines[i]):
                out.extend(new_block)
                i += 1
                while i < n and not re.match(r"^\S", lines[i]):
                    i += 1  # skip old model block body
                replaced = True
                continue
            out.append(lines[i])
            i += 1
        if not replaced:
            out.extend(new_block)
        try:
            cfg_path.write_text("\n".join(out) + "\n", encoding="utf-8")
        except Exception as exc:
            raise HTTPException(500, f"write failed: {exc}")
        # OpenAI client needs a non-empty key even for local endpoints.
        env_path = _hermes_root / ".env"
        try:
            etxt = env_path.read_text(encoding="utf-8") if env_path.exists() else ""
            if not re.search(r"^OPENAI_API_KEY=", etxt, re.M):
                etxt += ("" if etxt.endswith("\n") or not etxt else "\n") + "OPENAI_API_KEY=ollama\n"
                env_path.write_text(etxt, encoding="utf-8")
        except Exception:
            pass
        return {"ok": True, "model": model, "note": "新会话生效;必要时重启应用"}

    # ---- fine-tune dataset config ----
    def _count_jsonl(path: str) -> int:
        try:
            p = Path(os.path.expanduser(path))
            if not p.exists():
                return 0
            return sum(1 for ln in p.read_text(encoding="utf-8").splitlines() if ln.strip())
        except Exception:
            return 0

    def _read_ft_config() -> dict:
        return _read_json(_ft_config_file, {
            "train_path": "", "test_path": "", "mint_api_key": "", "min_train_rows": 100,
        })

    @router.get("/finetune/config")
    def ft_get_config():
        cfg = _read_ft_config()
        tr, te = _count_jsonl(cfg.get("train_path", "")), _count_jsonl(cfg.get("test_path", ""))
        cfg["train_rows"] = tr
        cfg["test_rows"] = te
        cfg["datasets_ready"] = tr >= int(cfg.get("min_train_rows", 100)) and te > 0
        cfg["mint_api_key_set"] = bool(cfg.get("mint_api_key"))
        cfg.pop("mint_api_key", None)  # never echo the key back
        return cfg

    @router.put("/finetune/config")
    async def ft_put_config(request: Request):
        body = await request.json()
        cur = _read_ft_config()
        for k in ("train_path", "test_path"):
            if k in body:
                cur[k] = str(body[k]).strip()
        if body.get("mint_api_key"):
            cur["mint_api_key"] = str(body["mint_api_key"]).strip()
        _mo_config_dir.mkdir(parents=True, exist_ok=True)
        _write_json(_ft_config_file, cur)
        return ft_get_config()

    @router.post("/finetune/gen-dataset")
    def ft_gen_dataset():
        # Convert the trajectory pool into SFT {prompt, completion} JSONL,
        # split ~85/15 into train/test under mo-config/datasets/.
        rows = []
        for t in _read_trajs():
            for turn in (t.get("turns_log") or []):
                p = (turn.get("prompt") or "").strip()
                c = (turn.get("reply") or "").strip()
                if p and c:
                    rows.append({"prompt": p, "completion": c})
        if not rows:
            return {"ok": False, "reason": "还没有可用轨迹（去工作台多聊几句）", "train_rows": 0, "test_rows": 0}
        _ft_datasets_dir.mkdir(parents=True, exist_ok=True)
        split = max(1, int(len(rows) * 0.85))
        train, test = rows[:split], rows[split:] or rows[-1:]
        train_p = _ft_datasets_dir / "train.jsonl"
        test_p = _ft_datasets_dir / "test.jsonl"
        train_p.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in train) + "\n", encoding="utf-8")
        test_p.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in test) + "\n", encoding="utf-8")
        cfg = _read_ft_config()
        cfg["train_path"] = str(train_p)
        cfg["test_path"] = str(test_p)
        _write_json(_ft_config_file, cfg)
        return {"ok": True, "train_rows": len(train), "test_rows": len(test),
                "train_path": str(train_p), "test_path": str(test_p)}

    # ---- fine-tune runner (scaffold) ----
    def _ft_read_runs() -> list:
        return _read_json(_ft_runs_file, [])

    def _ft_write_runs(runs: list) -> None:
        _mo_config_dir.mkdir(parents=True, exist_ok=True)
        _write_json(_ft_runs_file, runs)

    def _ft_update_run(run_id: str, **fields) -> None:
        with _evolve_lock:
            runs = _ft_read_runs()
            for r in runs:
                if r["id"] == run_id:
                    r.update(fields)
                    break
            _ft_write_runs(runs)

    @router.get("/finetune/status")
    def ft_status():
        ls = local_status()
        cfg = ft_get_config()
        is_mac = platform.system() == "Darwin"
        has_key = bool(_read_ft_config().get("mint_api_key"))
        backend = "mint" if is_mac else "grpo-or-mint"
        backend_reason = ("macOS 仅支持 MinT 云训练（grpo 需 NVIDIA CUDA）" if is_mac
                          else "可用 grpo(本地 CUDA) 或 MinT 云训练")
        mode = "real" if has_key else "scaffold"
        return {
            "datasets_ready": cfg["datasets_ready"],
            "train_rows": cfg["train_rows"], "test_rows": cfg["test_rows"],
            "min_train_rows": cfg.get("min_train_rows", 100),
            "local_active": ls["local_active"], "current_model": ls["current_model"],
            "backend": backend, "backend_reason": backend_reason,
            "mode": mode, "mint_api_key_set": has_key,
            "can_start": bool(cfg["datasets_ready"] and ls["local_active"]),
        }

    def _ft_spawn(method: str, steps: int, base_model: str) -> dict:
        st = ft_status()
        if not st["can_start"]:
            gate = "数据集未就绪" if not st["datasets_ready"] else "未使用本地模型"
            return {"ok": False, "reason": f"开启条件未满足：{gate}"}
        cfg = _read_ft_config()
        run_id = uuid.uuid4().hex[:12]
        run_cwd = _ft_runs_dir / run_id
        run_cwd.mkdir(parents=True, exist_ok=True)
        train_path = cfg.get("train_path", "")
        run_name = f"mo-{method}-{run_id}"
        ft_vendor = Path(__file__).resolve().parent / "vendor" / "finetune" / "scripts"
        script = "train_grpo.py" if method == "grpo" else "train_sft.py"
        cmd = [sys.executable, str(ft_vendor / script),
               "--base-model", base_model or st["current_model"] or "Qwen/Qwen3-4B-Instruct-2507",
               "--run-name", run_name, "--data", train_path,
               "--rank", "64", "--steps", str(steps)]
        entry = {"id": run_id, "method": method, "steps": steps,
                 "base_model": base_model or st["current_model"], "status": "running",
                 "created_at": time.time(), "cwd": str(run_cwd), "mode": st["mode"]}
        with _evolve_lock:
            runs = _ft_read_runs()
            runs.insert(0, entry)
            _ft_write_runs(runs)
        log_path = run_cwd / "run.log"
        has_key = bool(cfg.get("mint_api_key"))

        def _runner():
            try:
                with log_path.open("w", encoding="utf-8") as lf:
                    lf.write("=== 模型微调 · 蜕皮 ===\n")
                    lf.write(f"method={method}  steps={steps}\n")
                    lf.write(f"base_model={entry['base_model']}\n")
                    lf.write(f"train_data={train_path} ({st['train_rows']} 行)\n\n")
                    lf.write("将执行的命令:\n  " + " ".join(cmd) + "\n\n")
                    if not has_key:
                        lf.write("[scaffold 模式] 未配置 MinT API key — 不实际训练。\n")
                        lf.write("在 设置 · 微调数据集 里填入 MinT API key 后即可真正发起云上 LoRA 训练。\n")
                        lf.flush()
                        _ft_update_run(run_id, status="done", finished_at=time.time(), scaffold=True)
                        return
                    # The MinT training scripts are not redistributed with the
                    # open-source build (see THIRD_PARTY_LICENSES/README.md).
                    # Fail with an actionable message instead of a bare
                    # FileNotFoundError from subprocess.
                    if not (ft_vendor / script).exists():
                        lf.write(
                            "[未安装] 云训练脚本不在此发行版中。\n"
                            f"缺少: {ft_vendor / script}\n\n"
                            "开源版仅提供微调脚手架（数据集收集 + 运行台账）。\n"
                            "如需真正发起 MinT 云训练，请自行安装 mint-lora-training\n"
                            "到 server/vendor/finetune/，参见 docs/configuration.md。\n"
                        )
                        lf.flush()
                        _ft_update_run(run_id, status="failed", finished_at=time.time(),
                                       error="finetune scripts not bundled in this distribution")
                        return
                    env = dict(os.environ)
                    env["MINT_API_KEY"] = cfg["mint_api_key"]
                    env.setdefault("MINT_BASE_URL", "https://mint.macaron.xin")
                    proc = subprocess.run(cmd, cwd=str(run_cwd), env=env,
                                          stdout=lf, stderr=subprocess.STDOUT)
                    _ft_update_run(run_id, status="done" if proc.returncode == 0 else "failed",
                                   finished_at=time.time(), rc=proc.returncode)
            except Exception as exc:
                _ft_update_run(run_id, status="failed", error=str(exc), finished_at=time.time())

        threading.Thread(target=_runner, daemon=True, name=f"finetune-{run_id}").start()
        return {"ok": True, "run_id": run_id}

    @router.post("/finetune/run")
    async def ft_run(request: Request):
        body = await request.json()
        method = str(body.get("method", "sft")).lower()
        if method not in ("sft", "grpo", "dpo"):
            method = "sft"
        if method == "grpo" and platform.system() == "Darwin":
            return {"ok": False, "reason": "grpo 需 NVIDIA CUDA，macOS 不支持；请用 SFT(MinT 云训练)"}
        steps = max(1, min(2000, int(body.get("steps", 10))))
        base_model = str(body.get("base_model", "")).strip()
        return _ft_spawn(method, steps, base_model)

    @router.get("/finetune/runs")
    def ft_runs():
        return {"data": _ft_read_runs()}

    @router.get("/finetune/runs/{run_id}/log")
    def ft_run_log(run_id: str, tail: int = 400):
        run = next((r for r in _ft_read_runs() if r["id"] == run_id), None)
        if not run:
            raise HTTPException(404, "run not found")
        log_path = Path(run.get("cwd", "")) / "run.log"
        if not log_path.exists():
            return {"data": "", "exists": False, "total_lines": 0}
        lines = log_path.read_text(encoding="utf-8", errors="replace").splitlines()
        clean = [ln for ln in lines if "LiteLLM:WARNING" not in ln and "botocore" not in ln]
        total = len(clean)
        if tail and total > tail:
            clean = clean[-tail:]
        return {"data": "\n".join(clean), "exists": True, "total_lines": total}

    # ====================================================================
    # 模型配置 — endpoint library + per-use model selection.
    # Configure each OpenAI-compatible endpoint (base_url + key + models) ONCE
    # in the endpoint library; embedding / skills-evolution then just pick an
    # {endpoint, model}, and the gateway resolves the endpoint's creds into the
    # runtime files (ov.conf / evolve.json). GET never returns plaintext keys.
    # ====================================================================
    _ovconf_path = Path(os.path.expanduser("~/.openviking/ov.conf"))
    _endpoints_file = _mo_config_dir / "endpoints.json"
    _embedding_sel_file = _mo_config_dir / "embedding_sel.json"
    import urllib.parse as _urlparse

    def _read_endpoints() -> list:
        eps = _read_json(_endpoints_file, None)
        if isinstance(eps, list) and eps:
            return eps
        # Auto-migrate: seed one endpoint from the existing ov.conf so the
        # user's current tokendance setup appears without any re-entry.
        try:
            ovc = json.loads(_ovconf_path.read_text(encoding="utf-8"))
            dense = ((ovc.get("embedding") or {}).get("dense")) or {}
            vlm = ovc.get("vlm") or {}
            base = dense.get("api_base", "")
            key = dense.get("api_key", "")
            if base:
                host = _urlparse.urlparse(base).hostname or "endpoint"
                models = [m for m in {dense.get("model", ""), vlm.get("model", ""),
                                      "qwen3.6-plus", "qwen3.5-flash"} if m]
                seeded = [{"id": uuid.uuid4().hex[:12], "name": host,
                           "base_url": base, "api_key": key, "models": sorted(models)}]
                _mo_config_dir.mkdir(parents=True, exist_ok=True)
                _write_json(_endpoints_file, seeded)
                return seeded
        except Exception:
            pass
        return []

    def _resolve_endpoint(ep_id: str) -> tuple[str, str, list]:
        for e in _read_endpoints():
            if e.get("id") == ep_id:
                return e.get("base_url", ""), e.get("api_key", ""), e.get("models", [])
        return "", "", []

    def _endpoint_id_for_base(base: str) -> str:
        b = (base or "").rstrip("/")
        for e in _read_endpoints():
            if e.get("base_url", "").rstrip("/") == b:
                return e.get("id", "")
        return ""

    def _endpoints_public() -> list:
        return [{"id": e["id"], "name": e.get("name", ""), "base_url": e.get("base_url", ""),
                 "models": e.get("models", []), "api_key_set": bool(e.get("api_key"))}
                for e in _read_endpoints()]

    @router.get("/endpoints")
    def endpoints_list():
        return {"data": _endpoints_public()}

    @router.post("/endpoints")
    async def endpoints_add(request: Request):
        body = await request.json()
        name = str(body.get("name", "")).strip()
        base_url = str(body.get("base_url", "")).strip().rstrip("/")
        if not name or not base_url:
            raise HTTPException(400, "name and base_url required")
        eps = _read_endpoints()
        eps.append({"id": uuid.uuid4().hex[:12], "name": name, "base_url": base_url,
                    "api_key": str(body.get("api_key", "")).strip(),
                    "models": list(body.get("models", []) or [])})
        _mo_config_dir.mkdir(parents=True, exist_ok=True)
        _write_json(_endpoints_file, eps)
        return {"data": _endpoints_public()}

    @router.put("/endpoints/{ep_id}")
    async def endpoints_update(ep_id: str, request: Request):
        body = await request.json()
        eps = _read_endpoints()
        for e in eps:
            if e["id"] == ep_id:
                if "name" in body:
                    e["name"] = str(body["name"]).strip()
                if "base_url" in body:
                    e["base_url"] = str(body["base_url"]).strip().rstrip("/")
                if "models" in body:
                    e["models"] = list(body["models"] or [])
                if body.get("api_key"):
                    e["api_key"] = str(body["api_key"]).strip()
                _write_json(_endpoints_file, eps)
                return {"data": _endpoints_public()}
        raise HTTPException(404, "endpoint not found")

    @router.delete("/endpoints/{ep_id}")
    def endpoints_delete(ep_id: str):
        eps = [e for e in _read_endpoints() if e["id"] != ep_id]
        _write_json(_endpoints_file, eps)
        return {"data": _endpoints_public()}

    @router.post("/endpoints/{ep_id}/detect")
    def endpoints_detect(ep_id: str):
        base, key, _ = _resolve_endpoint(ep_id)
        if not base:
            raise HTTPException(404, "endpoint not found")
        try:
            import httpx
            headers = {"Authorization": f"Bearer {key}"} if key else {}
            r = httpx.get(base.rstrip("/") + "/models", headers=headers, timeout=15.0)
            r.raise_for_status()
            data = r.json().get("data", [])
            models = sorted({m.get("id", "") for m in data if m.get("id")})
        except Exception as exc:
            return {"ok": False, "reason": str(exc)}
        eps = _read_endpoints()
        for e in eps:
            if e["id"] == ep_id:
                e["models"] = models
                _write_json(_endpoints_file, eps)
                break
        return {"ok": True, "models": models}

    # ---- embedding: pick {endpoint, model} → resolve creds → write ov.conf ----
    @router.get("/models/embedding")
    def models_get_embedding():
        sel = _read_json(_embedding_sel_file, {})
        try:
            ovc = json.loads(_ovconf_path.read_text(encoding="utf-8"))
            dense = ((ovc.get("embedding") or {}).get("dense")) or {}
            vlm = ovc.get("vlm") or {}
        except Exception:
            dense, vlm = {}, {}
        ep_id = sel.get("endpoint_id") or _endpoint_id_for_base(dense.get("api_base", ""))
        return {
            "endpoint_id": ep_id,
            "model": sel.get("model") or dense.get("model", ""),
            "vlm_model": sel.get("vlm_model") or vlm.get("model", ""),
            "dimension": sel.get("dimension") or dense.get("dimension", 1024),
            "endpoints": _endpoints_public(),
        }

    @router.put("/models/embedding")
    async def models_put_embedding(request: Request):
        body = await request.json()
        ep_id = str(body.get("endpoint_id", "")).strip()
        base, key, _ = _resolve_endpoint(ep_id)
        if not base:
            raise HTTPException(400, "请选择一个有效端点")
        model = str(body.get("model", "")).strip()
        vlm_model = str(body.get("vlm_model", "")).strip() or model
        try:
            dim = int(body.get("dimension", 1024))
        except Exception:
            dim = 1024
        try:
            ovc = json.loads(_ovconf_path.read_text(encoding="utf-8"))
        except Exception:
            ovc = {}
        ovc.setdefault("storage", {"workspace": os.path.expanduser("~/.openviking/workspace")})
        emb = ovc.setdefault("embedding", {}); emb.setdefault("max_concurrent", 10)
        dense = emb.setdefault("dense", {})
        dense.update({"provider": "openai", "api_base": base, "api_key": key,
                      "model": model, "dimension": dim})
        vlm = ovc.setdefault("vlm", {}); vlm.setdefault("max_concurrent", 16)
        vlm.update({"provider": "openai", "api_base": base, "api_key": key, "model": vlm_model})
        try:
            _ovconf_path.parent.mkdir(parents=True, exist_ok=True)
            _ovconf_path.write_text(json.dumps(ovc, ensure_ascii=False, indent=2), encoding="utf-8")
        except Exception as exc:
            raise HTTPException(500, f"write failed: {exc}")
        _mo_config_dir.mkdir(parents=True, exist_ok=True)
        _write_json(_embedding_sel_file, {"endpoint_id": ep_id, "model": model,
                                          "vlm_model": vlm_model, "dimension": dim})
        out = models_get_embedding()
        out["note"] = "已保存。重启应用让 OpenViking 重新加载 embedding。"
        return out

    # ---- evolve: pick {endpoint, optimizer, eval} ----
    @router.get("/models/evolve")
    def models_get_evolve():
        c = _read_evolve_model_cfg()
        opt, ev = _evolve_models()
        # Pre-select the endpoint by matching the effective eval base_url.
        ep_id = c.get("endpoint_id") or _endpoint_id_for_base(_evolve_eval_creds()[0])
        return {
            "endpoint_id": ep_id,
            "optimizer_model": (c.get("optimizer_model") or opt).replace("openai/", ""),
            "eval_model": (c.get("eval_model") or ev).replace("openai/", ""),
            # A critic sharing the optimizer's weights shares its blind spots,
            # so this has to be settable — the diff modal tells users to come
            # here when it detects that.
            "critic_model": (c.get("critic_model") or _critic_model()).replace("openai/", ""),
            "reflect_model": (c.get("reflect_model") or _reflect_model()).replace("openai/", ""),
            "endpoints": _endpoints_public(),
        }

    @router.put("/models/evolve")
    async def models_put_evolve(request: Request):
        body = await request.json()
        c = _read_evolve_model_cfg()
        if "endpoint_id" in body:
            c["endpoint_id"] = str(body["endpoint_id"]).strip()
            base, key, _ = _resolve_endpoint(c["endpoint_id"])
            c["api_base"], c["api_key"] = base, key
        for k in ("optimizer_model", "eval_model", "critic_model", "reflect_model"):
            if k in body:
                m = str(body[k]).strip()
                c[k] = ("openai/" + m) if (m and not m.startswith("openai/")) else m
        _evolve_model_cfg_file.parent.mkdir(parents=True, exist_ok=True)
        _write_json(_evolve_model_cfg_file, c)
        return models_get_evolve()

    app.include_router(router)

    # The dashboard registers a catch-all GET /{path} route at import time,
    # which would shadow our routes (FastAPI matches in registration order).
    # Re-order so /api/mo/* is matched first.
    #
    # Two shapes to recognise. Up to FastAPI 0.11x, include_router() spliced the
    # router's own Route objects into app.router.routes, each with a full
    # /api/mo/... path. From 0.140 it appends a single lazy `_IncludedRouter`
    # wrapper whose `path` is "" — so matching on path alone silently found
    # nothing here, the re-order became a no-op, and every /api/mo/* request
    # fell through to the dashboard's catch-all as "No such API endpoint".
    def _is_mo(route) -> bool:
        if getattr(route, "path", "").startswith("/api/mo"):
            return True
        inner = getattr(route, "original_router", None)
        return bool(inner is not None and getattr(inner, "prefix", "").startswith("/api/mo"))

    mo_routes = [r for r in app.router.routes if _is_mo(r)]
    if not mo_routes:
        logging.getLogger("hermes.desktop").warning(
            "No /api/mo routes found after include_router — the desktop API will "
            "be shadowed by the dashboard catch-all (FastAPI %s)",
            getattr(__import__("fastapi"), "__version__", "?"),
        )
    other_routes = [r for r in app.router.routes if r not in mo_routes]
    app.router.routes = mo_routes + other_routes


def _start_dashboard_in_thread(port: int) -> None:
    """Run the Hermes web dashboard (FastAPI/uvicorn) in a daemon thread."""
    import uvicorn

    try:
        from hermes_cli.web_server import WEB_DIST, app as dashboard_app
    except ImportError:
        logging.getLogger("hermes.desktop").warning(
            "hermes_cli.web_server not available — dashboard will not start"
        )
        return

    try:
        _mount_mo_routes(dashboard_app)
    except Exception:
        logging.getLogger("hermes.desktop").warning(
            "Failed to mount /api/mo routes", exc_info=True
        )

    if not WEB_DIST.exists():
        # The dashboard hosts the Mo API routes (/api/mo/*, /api/model/*) AND
        # the SPA. The Electron app classifies its gateway ports by fetching
        # /health, which falls through to the SPA (index.html) — so the bundled
        # web frontend must be present for the renderer to find this port.
        logging.getLogger("hermes.desktop").warning(
            "Dashboard assets missing (%s) — dashboard will not start", WEB_DIST
        )
        return

    config = uvicorn.Config(
        dashboard_app,
        host="127.0.0.1",
        port=port,
        log_level="warning",
    )
    server = uvicorn.Server(config)

    original_startup = server.startup

    async def _startup_with_port(*args, **kwargs):
        await original_startup(*args, **kwargs)
        print(f"HERMES_DASHBOARD_PORT:{port}", flush=True)

    server.startup = _startup_with_port

    def _run():
        server.run()

    t = threading.Thread(target=_run, daemon=True, name="hermes-dashboard")
    t.start()


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        stream=sys.stderr,
    )
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)

    _load_env()

    gateway_port = _find_free_port()
    dashboard_port = _find_free_port()

    os.environ["API_SERVER_ENABLED"] = "true"
    os.environ["API_SERVER_PORT"] = str(gateway_port)
    os.environ["API_SERVER_HOST"] = "127.0.0.1"
    os.environ["HERMES_DESKTOP_MODE"] = "1"

    # Announce the API port to Electron main process (read by python-bridge.ts)
    print(f"HERMES_PORT:{gateway_port}", flush=True)

    _start_dashboard_in_thread(dashboard_port)

    from gateway.run import start_gateway

    # Importing gateway.run re-runs load_hermes_dotenv, which *deliberately*
    # overrides already-set variables with whatever is in ~/.hermes-mo/.env.
    # Anything Mo owns therefore has to be re-asserted here, after the import —
    # setting it above is silently undone. (That is also why API_SERVER_PORT=0
    # in a user's .env wins and python-bridge.ts discovers the real port with
    # lsof instead of trusting stdout.)
    #
    # Both values below are security-relevant:
    #   HOST — a stale API_SERVER_HOST=0.0.0.0 would expose the agent gateway
    #          to the local network.
    #   CORS — the renderer is a file:// page, so "Origin: null" is the only
    #          origin that ever needs allowing. "*" would let any website the
    #          user visits read the two unauthenticated endpoints (/health,
    #          /health/detailed); the rest is gated by API_SERVER_KEY. The list
    #          is exact-match, so a normal https:// origin gets no CORS headers
    #          and the browser refuses the read.
    os.environ["API_SERVER_HOST"] = "127.0.0.1"
    os.environ["API_SERVER_CORS_ORIGINS"] = "null"

    success = asyncio.run(start_gateway(replace=True, verbosity=0))
    if not success:
        sys.exit(1)


if __name__ == "__main__":
    main()
