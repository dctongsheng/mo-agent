"""待办 — everything the agent wants to change about itself, waiting on you.

Four things turn out to be the same object, and Mo had them in four places or
nowhere at all:

* **Skill writes** and **memory writes** staged by Hermes' write-approval gate.
  The file-backed model in ``tools/write_approval.py`` is complete — staging,
  listing, discarding, even a rendered diff — and has no HTTP surface at all.
* **Retirement proposals** from the curator guard.
* **Learn drafts** from a sandboxed ``/learn`` turn.

The one that matters most is the background review. ``agent/background_review.py``
forks a second AIAgent every ~10 turns and writes memories and skills straight
to disk. There is no history, no endpoint, and no ``enabled`` flag anywhere —
the actions are printed once and discarded. By Mo's standards that is a larger
unconsented-write surface than the 90-day timer this effort started with,
because it fires every ten turns rather than every ninety days.

**On "background only".** The upstream gate is one boolean per subsystem:
``evaluate_gate`` returns ``allow`` immediately when the flag is off, for
foreground and background alike. There is no per-origin setting. So Mo turns
both flags on and shims ``evaluate_gate`` to let foreground writes through —
telling 小貘 「记住我用 pnpm」 still works instantly — while background-fork
writes stage into this inbox. The shim only applies when Mo set the flags
itself (marked in config), so a user who deliberately enables full approval
keeps it.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

SKILLS = "skills"
MEMORY = "memory"

#: Marks that Mo enabled write_approval for the background-only policy, rather
#: than the user asking for full approval. Without it the shim would silently
#: undo a deliberate setting.
MARKER = "_mo_background_only"

_GATE_MARKER = "_mo_gate_shim"
REVIEW_LOG = "background_review.jsonl"


def _wa():
    from tools import write_approval
    return write_approval


# ---- the background-only shim --------------------------------------------

def background_only_enabled() -> bool:
    try:
        from hermes_cli.config import load_config
        cfg = load_config() or {}
        return bool((cfg.get(SKILLS) or {}).get(MARKER))
    except Exception:
        return False


def enable_background_only() -> tuple[bool, str]:
    """Turn on write_approval for both subsystems, marked as Mo's doing."""
    try:
        from hermes_cli.config import load_config, save_config
        cfg = load_config() or {}
        for sub in (SKILLS, MEMORY):
            block = dict(cfg.get(sub) or {})
            block["write_approval"] = True
            block[MARKER] = True
            cfg[sub] = block
        save_config(cfg)
        return True, "enabled"
    except Exception as exc:
        return False, str(exc)


def disable_background_only() -> tuple[bool, str]:
    try:
        from hermes_cli.config import load_config, save_config
        cfg = load_config() or {}
        for sub in (SKILLS, MEMORY):
            block = dict(cfg.get(sub) or {})
            if block.pop(MARKER, None):
                block["write_approval"] = False
            cfg[sub] = block
        save_config(cfg)
        return True, "disabled"
    except Exception as exc:
        return False, str(exc)


def shim_installed() -> bool:
    try:
        return bool(getattr(_wa().evaluate_gate, _GATE_MARKER, False))
    except Exception:
        return False


def install_gate_shim() -> tuple[bool, str]:
    """Let foreground writes through; stage background ones.

    All three call sites (`memory_tool.py:959,1012`, `skill_manager_tool.py:1351`)
    do `wa.evaluate_gate(...)` — module attribute access — so one swap covers
    every write.
    """
    try:
        wa = _wa()
    except Exception as exc:
        return False, f"write_approval 不可用：{exc}"

    original = wa.evaluate_gate
    if getattr(original, _GATE_MARKER, False):
        return True, "already installed"

    def shimmed(subsystem, **kw):
        # Only reshape the policy when Mo turned the flags on. If the user
        # asked for full approval, honour it.
        if background_only_enabled() and not wa.is_background():
            return wa.GateDecision(allow=True)
        return original(subsystem, **kw)

    setattr(shimmed, _GATE_MARKER, True)
    shimmed._mo_original = original      # noqa: SLF001
    wa.evaluate_gate = shimmed
    return True, "installed"


def uninstall_gate_shim() -> bool:
    try:
        wa = _wa()
        original = getattr(wa.evaluate_gate, "_mo_original", None)
        if original is None:
            return False
        wa.evaluate_gate = original
        return True
    except Exception:
        return False


# ---- the unified list -----------------------------------------------------

def _staged_items() -> list[dict]:
    out = []
    try:
        wa = _wa()
    except Exception:
        return out
    for subsystem in (SKILLS, MEMORY):
        try:
            records = wa.list_pending(subsystem) or []
        except Exception:
            continue
        for rec in records:
            payload = rec.get("payload") or {}
            out.append({
                "kind": f"{subsystem}-write",
                "id": rec.get("id"),
                "subsystem": subsystem,
                "action": rec.get("action") or payload.get("action", ""),
                "title": payload.get("name") or rec.get("summary") or subsystem,
                "summary": rec.get("summary", ""),
                # foreground | background_review — the whole reason this list
                # is interesting.
                "origin": rec.get("origin", "foreground"),
                "at": rec.get("created_at", 0),
            })
    return out


def _retirement_items(store) -> list[dict]:
    try:
        from mo_evolve import curator
        return [{
            "kind": "retirement",
            "id": p["skill"],
            "title": p["skill"],
            "summary": p.get("description", ""),
            "origin": ("background_review" if p.get("reason") == "agent-delete"
                       else "curator"),
            "at": p.get("proposed_at", 0),
            "days_idle": p.get("days_idle"),
            "skill_md_chars": p.get("skill_md_chars", 0),
        } for p in curator.list_proposals(store, "proposed")]
    except Exception:
        return []


def _learn_items(store) -> list[dict]:
    out = []
    try:
        for d in store.read_learn_runs():
            if d.get("status") != "done":
                continue
            sk = d.get("skill") or {}
            out.append({
                "kind": "learn-draft",
                "id": d["id"],
                "title": sk.get("name") or d.get("request", "")[:40],
                "summary": sk.get("description", ""),
                "origin": "foreground",
                "at": d.get("created_at", 0),
            })
    except Exception:
        pass
    return out


def list_all(store) -> list[dict]:
    """Everything waiting on a decision, newest first."""
    items = _staged_items() + _retirement_items(store) + _learn_items(store)
    items.sort(key=lambda i: i.get("at") or 0, reverse=True)
    return items


def counts(store) -> dict:
    items = list_all(store)
    out = {"total": len(items), "background": 0}
    for i in items:
        out[i["kind"]] = out.get(i["kind"], 0) + 1
        if i.get("origin") == "background_review":
            out["background"] += 1
    return out


def detail(subsystem: str, pending_id: str) -> dict | None:
    """A staged record plus its rendered diff, where one exists."""
    try:
        wa = _wa()
        rec = wa.get_pending(subsystem, pending_id)
    except Exception:
        return None
    if not rec:
        return None
    out = dict(rec)
    if subsystem == SKILLS:
        try:
            out["diff"] = wa.skill_pending_diff(rec)
        except Exception:
            out["diff"] = ""
    return out


def approve(subsystem: str, pending_id: str) -> tuple[bool, str]:
    """Replay a staged write with the gate bypassed."""
    try:
        wa = _wa()
        rec = wa.get_pending(subsystem, pending_id)
    except Exception as exc:
        return False, str(exc)
    if not rec:
        return False, "这条已经不在了"

    payload = rec.get("payload") or {}
    try:
        if subsystem == SKILLS:
            from tools.skill_manager_tool import apply_skill_pending
            result = json.loads(apply_skill_pending(payload))
        else:
            from tools.memory_tool import apply_memory_pending
            from agent.memory_store import MemoryStore  # noqa: F401 - optional
            result = apply_memory_pending(payload, _memory_store())
    except Exception as exc:
        return False, f"应用失败：{exc}"

    ok = bool(result.get("success", True))
    if ok:
        try:
            wa.discard_pending(subsystem, pending_id)
        except Exception:
            pass
    return ok, str(result.get("message") or result.get("error") or "ok")


def _memory_store():
    from tools.memory_tool import MemoryStore
    return MemoryStore()


def reject(subsystem: str, pending_id: str) -> tuple[bool, str]:
    try:
        return bool(_wa().discard_pending(subsystem, pending_id)), "ok"
    except Exception as exc:
        return False, str(exc)


# ---- background review log ------------------------------------------------

def review_log_path(store) -> Path:
    return store.evolve_dir / REVIEW_LOG


def record_review(store, actions: list, model: str = "", now=None) -> None:
    """Persist one background-review pass.

    `summarize_background_review_actions` already produces exactly this list;
    upstream prints it once and drops it. Appending it is the whole difference
    between a loop you can audit and one you can only take on faith.
    """
    if not actions:
        return
    now = now or time.time
    line = json.dumps({"at": now(), "model": model,
                       "actions": [str(a) for a in actions]}, ensure_ascii=False)
    try:
        p = review_log_path(store)
        p.parent.mkdir(parents=True, exist_ok=True)
        with p.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


def read_review_log(store, limit: int = 50) -> list[dict]:
    p = review_log_path(store)
    if not p.exists():
        return []
    rows = []
    try:
        for line in p.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except Exception:
                continue
    except Exception:
        return []
    return list(reversed(rows))[:limit]


def install_review_recorder(store) -> tuple[bool, str]:
    """Wrap the summariser so its output is kept, not just printed."""
    try:
        from agent import background_review as br
    except Exception as exc:
        return False, f"background_review 不可用：{exc}"

    original = getattr(br, "summarize_background_review_actions", None)
    if original is None:
        return False, "summarize_background_review_actions 不存在"
    if getattr(original, "_mo_recorded", False):
        return True, "already installed"

    def wrapped(*a, **kw):
        actions = original(*a, **kw)
        try:
            record_review(store, actions or [])
        except Exception:
            pass
        return actions

    wrapped._mo_recorded = True          # noqa: SLF001
    wrapped._mo_original = original      # noqa: SLF001
    br.summarize_background_review_actions = wrapped
    return True, "installed"


def review_settings() -> dict:
    """The nudge intervals — the only way to turn background review down.

    There is no `background_review.enabled` flag anywhere in the core; setting
    both intervals very high is the off switch, and the UI should say so rather
    than implying a toggle exists.
    """
    out = {"memory_nudge_interval": None, "skill_nudge_interval": None}
    try:
        from hermes_cli.config import load_config
        cfg = load_config() or {}
        out["memory_nudge_interval"] = (cfg.get("memory") or {}).get("nudge_interval", 10)
        out["skill_nudge_interval"] = (cfg.get("skills") or {}).get(
            "creation_nudge_interval", 10)
    except Exception:
        pass
    return out


def set_review_intervals(memory: int | None = None, skills: int | None = None) -> tuple[bool, str]:
    try:
        from hermes_cli.config import load_config, save_config
        cfg = load_config() or {}
        if memory is not None:
            block = dict(cfg.get("memory") or {})
            block["nudge_interval"] = int(memory)
            cfg["memory"] = block
        if skills is not None:
            block = dict(cfg.get(SKILLS) or {})
            block["creation_nudge_interval"] = int(skills)
            cfg[SKILLS] = block
        save_config(cfg)
        return True, "ok"
    except Exception as exc:
        return False, str(exc)
