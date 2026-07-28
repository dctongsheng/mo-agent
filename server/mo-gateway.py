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
    _runs_file = _evolve_dir / "runs.json"
    _schedule_file = _evolve_dir / "schedule.json"
    _vendor_dir = Path(__file__).resolve().parent / "vendor"
    _evolve_lock = threading.Lock()

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

    _bundled_cache: dict = {}

    def _bundled_skill_names() -> set:
        """Names of skills that ship with Hermes (vs. user/self-authored).
        Union of (a) the per-profile bundled manifest written at seed time and
        (b) a full scan of the installed agent's bundle skills dir — recording
        BOTH directory names and frontmatter names, since they often differ
        (dir "audiocraft" vs name "audiocraft-audio-generation"). A stale
        manifest alone misses a few skills, so we union both for recall.
        Cached for the process lifetime."""
        if "names" in _bundled_cache:
            return _bundled_cache["names"]
        names: set = set()
        manifest = _hermes_root / "skills" / ".bundled_manifest"
        try:
            for line in manifest.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if line and not line.startswith("#"):
                    names.add(line.split(":", 1)[0].strip())
        except Exception:
            pass
        # Hermes ships skills under both skills/ and optional-skills/.
        for root in (
            Path(os.path.expanduser("~/.hermes/hermes-agent/skills")),
            Path(os.path.expanduser("~/.hermes/hermes-agent/optional-skills")),
            Path(os.environ.get("HERMES_AGENT_ROOT", "")) / "skills",
            Path(os.environ.get("HERMES_AGENT_ROOT", "")) / "optional-skills",
        ):
            if not root.exists():
                continue
            for md in root.rglob("SKILL.md"):
                names.add(md.parent.name)
                try:
                    for ln in md.read_text(encoding="utf-8")[:400].splitlines():
                        s = ln.strip()
                        if s.startswith("name:"):
                            names.add(s.split(":", 1)[1].strip().strip("'\""))
                            break
                except Exception:
                    pass
        _bundled_cache["names"] = names
        return names

    # Evolution operates on the user's real skills dir (~/.hermes-mo/skills),
    # where skills they author show up — not the evolver-profile clone. So a
    # newly-created skill is immediately evolvable; accept writes back to the
    # same file the user owns.
    _skills_dir = _hermes_root / "skills"

    def _list_evolver_skills() -> list:
        out = []
        sk = _skills_dir
        if not sk.exists():
            return out
        bundled = _bundled_skill_names()
        for md in sk.rglob("SKILL.md"):
            try:
                raw = md.read_text(encoding="utf-8")
            except Exception:
                continue
            name = md.parent.name
            desc = ""
            for line in raw[:800].splitlines():
                s = line.strip()
                if s.startswith("name:"):
                    name = s.split(":", 1)[1].strip().strip("'\"") or name
                elif s.startswith("description:"):
                    desc = s.split(":", 1)[1].strip().strip("'\"")
            # Manifest keys are frontmatter skill names; the fallback bundle
            # scan yields directory names. A skill is built-in if either matches
            # (dir name often differs from the declared name, e.g. dir
            # "audiocraft" vs name "audiocraft-audio-generation").
            out.append({"name": name, "description": desc, "size": len(raw),
                        "path": str(md.relative_to(_hermes_root)),
                        "builtin": (name in bundled) or (md.parent.name in bundled)})
        out.sort(key=lambda x: x["name"])
        return out

    def _read_runs() -> list:
        return _read_json(_runs_file, [])

    def _write_runs(runs: list) -> None:
        _evolve_dir.mkdir(parents=True, exist_ok=True)
        _write_json(_runs_file, runs)

    def _update_run(run_id: str, **fields) -> None:
        with _evolve_lock:
            runs = _read_runs()
            for r in runs:
                if r["id"] == run_id:
                    r.update(fields)
                    break
            _write_runs(runs)

    def _spawn_evolution(skill: str, iterations: int, eval_source: str) -> dict:
        ok, why = _engine_ready()
        if not ok:
            return {"ok": False, "reason": why}
        run_id = uuid.uuid4().hex[:12]
        run_cwd = _evolve_dir / "runs" / run_id
        run_cwd.mkdir(parents=True, exist_ok=True)
        opt_model, eval_model = _evolve_models()
        env = dict(os.environ)
        env["PYTHONPATH"] = str(_vendor_dir) + os.pathsep + env.get("PYTHONPATH", "")
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
        log_path = run_cwd / "run.log"
        entry = {
            "id": run_id, "skill": skill, "iterations": iterations,
            "eval_source": eval_source, "status": "running",
            "created_at": time.time(), "cwd": str(run_cwd),
            "opt_model": opt_model, "eval_model": eval_model,
        }
        with _evolve_lock:
            runs = _read_runs()
            runs.insert(0, entry)
            _write_runs(runs)

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
            else:
                # pipeline may have written a FAILED variant or produced nothing
                failed = out_root / "evolved_FAILED.md" if out_root.exists() else None
                _update_run(run_id, status="failed",
                            output_dir=str(latest) if latest else "",
                            error="未产出 evolved_skill（见 run.log）",
                            finished_at=time.time(), rc=rc)

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
        eval_source = str(body.get("eval_source", "synthetic"))
        if eval_source not in ("synthetic", "sessiondb"):
            eval_source = "synthetic"
        return _spawn_evolution(skill, iterations, eval_source)

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
        out = run.get("output_dir")
        if out:
            od = Path(out)
            base = (od / "baseline_skill.md")
            evo = (od / "evolved_skill.md")
            met = (od / "metrics.json")
            base_txt = base.read_text(encoding="utf-8") if base.exists() else ""
            evo_txt = evo.read_text(encoding="utf-8") if evo.exists() else ""
            result["baseline"] = base_txt
            result["evolved"] = evo_txt
            result["metrics"] = _read_json(met, {}) if met.exists() else {}
            result["diff"] = "".join(difflib.unified_diff(
                base_txt.splitlines(keepends=True),
                evo_txt.splitlines(keepends=True),
                fromfile="baseline", tofile="evolved",
            ))
        return result

    @router.post("/evolve/runs/{run_id}/accept")
    def evolve_accept(run_id: str):
        runs = _read_runs()
        run = next((r for r in runs if r["id"] == run_id), None)
        if not run or not run.get("output_dir"):
            raise HTTPException(404, "run or output not found")
        evolved = Path(run["output_dir"]) / "evolved_skill.md"
        if not evolved.exists():
            raise HTTPException(400, "no evolved skill to apply")
        # Find the target SKILL.md in the user's skills dir by skill name
        # (matching either the directory name or the frontmatter name).
        target = None
        for md in _skills_dir.rglob("SKILL.md"):
            if md.parent.name == run["skill"]:
                target = md
                break
            try:
                head = md.read_text(encoding="utf-8")[:400]
                if any(line.strip() in (f"name: {run['skill']}", f"name: \"{run['skill']}\"", f"name: '{run['skill']}'") for line in head.splitlines()):
                    target = md
                    break
            except Exception:
                pass
        if target is None:
            raise HTTPException(404, "target skill not found")
        target.write_text(evolved.read_text(encoding="utf-8"), encoding="utf-8")
        _update_run(run_id, status="accepted", applied_at=time.time(),
                    applied_to=str(target.relative_to(_hermes_root)))
        return {"ok": True, "applied_to": str(target)}

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
        return _read_json(_schedule_file, {"enabled": False, "hour": 3, "minute": 0,
                                           "skill": "auto", "iterations": 4})

    @router.put("/evolve/schedule")
    async def evolve_set_schedule(request: Request):
        body = await request.json()
        sched = {
            "enabled": bool(body.get("enabled", False)),
            "hour": max(0, min(23, int(body.get("hour", 3)))),
            "minute": max(0, min(59, int(body.get("minute", 0)))),
            "skill": str(body.get("skill", "auto")) or "auto",
            "iterations": max(1, min(20, int(body.get("iterations", 4)))),
        }
        _evolve_dir.mkdir(parents=True, exist_ok=True)
        _write_json(_schedule_file, sched)
        return {"ok": True, "data": sched}

    def _ensure_evolver_profile() -> None:
        """Make sure the permanent 夜貘（进化）profile exists with seeded skills.
        Runs once on startup; recreates it if the user/anything deleted it."""
        if _evolver_home.exists() and (_evolver_home / "skills").exists():
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
            # Give it an identity
            soul = Path(path) / "SOUL.md"
            if not soul.exists():
                soul.write_text(
                    "# 夜貘 · 进化分身\n\n"
                    "我是夜行的那一只。白天的小貘陪你做事,我在夜里把它的技艺一遍遍打磨得更趁手。\n"
                    "我读它走过的轨迹,找出钝处,重写技能,再交回给它。\n",
                    encoding="utf-8",
                )
        except Exception as exc:
            logging.getLogger("hermes.desktop").warning("ensure evolver profile failed: %s", exc)

    threading.Thread(target=_ensure_evolver_profile, daemon=True, name="ensure-evolver").start()

    # Nightly scheduler thread: at the configured local time, trigger one run
    # (best-effort). When skill == "auto", rotate through the NON-built-in
    # (user/custom) skills in name order, one per scheduled run — so every
    # custom skill gets evolved in turn instead of always picking the biggest.
    _auto_cursor_file = _evolve_dir / "auto_cursor.json"

    def _next_auto_skill() -> str:
        custom = sorted(s["name"] for s in _list_evolver_skills() if not s.get("builtin"))
        if not custom:
            return ""
        last = _read_json(_auto_cursor_file, {}).get("last", "")
        try:
            nxt = custom[(custom.index(last) + 1) % len(custom)]
        except ValueError:
            nxt = custom[0]  # last not in current list → start from the first
        _evolve_dir.mkdir(parents=True, exist_ok=True)
        _write_json(_auto_cursor_file, {"last": nxt})
        return nxt

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
                        skill = sched.get("skill", "auto")
                        if skill == "auto":
                            skill = _next_auto_skill()
                        # don't double-fire if a run is already in flight
                        running = any(r.get("status") == "running" for r in _read_runs())
                        if skill and not running:
                            _spawn_evolution(skill, int(sched.get("iterations", 4)), "synthetic")
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
        for k in ("optimizer_model", "eval_model"):
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
    mo_routes = [r for r in app.router.routes if getattr(r, "path", "").startswith("/api/mo")]
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
