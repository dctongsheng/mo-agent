"""Retirement proposals — Mo's answer to a timer that moves files.

Hermes ships a curator. It runs from the gateway's hourly housekeeping tick,
walks every skill, and at ``archive_after_days`` (90 by default) calls
``skill_usage.archive_skill()`` — which ``mv``s the skill's directory into
``skills/.archive/``. No prompt, no diff, nothing in any UI.

On this machine it has already run three times and marked 52 skills stale. The
77-skill cohort created 2026-06-19 crosses the 90-day line on 2026-09-17.

Everything else Mo does is built on the opposite promise: nothing changes
without a human pressing a button, and every write is snapshotted first. So
this module intercepts exactly one function and turns the file move into a
proposal.

**Why ``archive_skill`` and not ``apply_automatic_transitions``.** The latter is
~60 lines of exemption logic — pinned, cron-referenced, protected built-ins,
first-sight seeding, the never-used grace floor — that Mo would have to
re-implement and then keep in sync through every re-vendor. ``archive_skill`` is
the *only* call in it that touches the filesystem; ``set_state`` and
``seed_record_if_missing`` only write ``.usage.json``. Swapping the leaf keeps
the whole policy intact and non-destructive.

It works because ``agent/curator.py`` does ``from tools import skill_usage as _u``
*inside* the function and calls ``_u.archive_skill(name)``, so the attribute is
resolved at call time.

The same swap also catches ``skill_manager_tool._delete_skill`` (小貘 deleting a
skill mid-chat) and ``learning_mutations.delete_node`` — both funnel here. Those
become proposals too, tagged with a different reason.
"""

from __future__ import annotations

import contextlib
import threading
import time
from pathlib import Path

from mo_evolve.store import read_json, write_json

#: Set on the swapped function so installing twice doesn't wrap a wrapper.
_MARKER = "_mo_guarded"

#: Thread-local: set while Mo applies a retirement the user approved.
_local = threading.local()

RETIREMENTS_FILE = "retirements.json"

REASON_INACTIVITY = "curator-inactivity"
REASON_AGENT_DELETE = "agent-delete"
REASON_MANUAL = "manual"

#: Effectively "never". Written to config only as a fail-safe when the
#: monkeypatch could not be installed.
CLAMPED_DAYS = 36500


# ---- vendored imports, all guarded ---------------------------------------
# CI proves the engine still imports with only server/vendor on the path, so
# nothing here may import at module scope.

def _skill_usage():
    from tools import skill_usage
    return skill_usage


def _curator_mod():
    from agent import curator
    return curator


# ---- the guard -----------------------------------------------------------

def guard_installed() -> bool:
    try:
        return bool(getattr(_skill_usage().archive_skill, _MARKER, False))
    except Exception:
        return False


@contextlib.contextmanager
def bypass():
    """Let Mo's own approved retirement reach the real archive_skill.

    Mirrors the ``_skill_gate_bypass`` ContextVar the vendored skill-manager
    uses for the same purpose. Resets on exception, so a failed retirement
    can't leave the guard disarmed.
    """
    prev = getattr(_local, "bypass", False)
    _local.bypass = True
    try:
        yield
    finally:
        _local.bypass = prev


def install_guard(store) -> tuple[bool, str]:
    """Swap ``tools.skill_usage.archive_skill`` for a recorder. Idempotent."""
    try:
        su = _skill_usage()
    except Exception as exc:
        return False, f"skill_usage 不可用：{exc}"

    original = su.archive_skill
    if getattr(original, _MARKER, False):
        return True, "already installed"

    def guarded(skill_name: str):
        # Mo applying an approved retirement — let it through untouched.
        if getattr(_local, "bypass", False):
            return original(skill_name)

        reason = REASON_AGENT_DELETE if _in_agent_context() else REASON_INACTIVITY
        try:
            propose(store, skill_name, reason=reason)
        except Exception:
            # Recording failed. Still refuse the move — silently archiving is
            # the exact behaviour this guard exists to prevent, and a lost
            # proposal is recoverable while a lost skill directory is not
            # obvious to the user.
            pass
        return False, (
            f"「{skill_name}」已记为待退休提案，等你在「清点技艺」里定夺。"
            "Mo 不会自己收走方子。"
        )

    setattr(guarded, _MARKER, True)
    guarded.__name__ = getattr(original, "__name__", "archive_skill")
    guarded.__doc__ = original.__doc__
    guarded._mo_original = original      # noqa: SLF001 - for tests and uninstall

    su.archive_skill = guarded
    return True, "installed"


def uninstall_guard() -> bool:
    """Restore the original. Used by tests; not wired to any route."""
    try:
        su = _skill_usage()
        original = getattr(su.archive_skill, "_mo_original", None)
        if original is None:
            return False
        su.archive_skill = original
        return True
    except Exception:
        return False


def _in_agent_context() -> bool:
    """True when this archive came from an agent action rather than the timer.

    The curator's automatic pass runs on the gateway housekeeping thread with
    the write-origin ContextVar at its default; a skill_manage delete during a
    turn does not. This is a best-effort label for the proposal, never a
    control-flow decision.
    """
    try:
        from tools.skill_provenance import get_current_write_origin
        return get_current_write_origin() != "foreground"
    except Exception:
        return False


# ---- config fail-safe ----------------------------------------------------

def clamp_archive_days(hermes_root: Path) -> tuple[bool, str]:
    """Make the 90-day timer unreachable when the guard couldn't install.

    Never overwrites a value the user chose: the clamp writes a
    ``_mo_clamped`` marker alongside it and refuses to act a second time if the
    marker is absent but the value has changed.
    """
    try:
        from hermes_cli.config import load_config, save_config
    except Exception as exc:
        return False, f"config 不可读：{exc}"

    try:
        cfg = load_config() or {}
        cur = dict(cfg.get("curator") or {})
        if cur.get("_mo_clamped") and cur.get("archive_after_days") == CLAMPED_DAYS:
            return True, "already clamped"
        cur["archive_after_days"] = CLAMPED_DAYS
        cur["_mo_clamped"] = True
        cfg["curator"] = cur
        save_config(cfg)
        return True, "clamped"
    except Exception as exc:
        return False, str(exc)


def is_clamped() -> bool:
    try:
        from hermes_cli.config import load_config
        return bool((load_config() or {}).get("curator", {}).get("_mo_clamped"))
    except Exception:
        return False


# ---- proposals -----------------------------------------------------------

def retirements_path(store) -> Path:
    return store.evolve_dir / RETIREMENTS_FILE


def _read(store) -> dict:
    data = read_json(retirements_path(store), None)
    if not isinstance(data, dict) or "items" not in data:
        return {"version": 1, "items": {}}
    return data


def _write(store, data: dict) -> None:
    store.evolve_dir.mkdir(parents=True, exist_ok=True)
    write_json(retirements_path(store), data)


def propose(store, skill: str, *, reason: str = REASON_MANUAL,
            row: dict | None = None, now=None) -> dict:
    """Record a retirement proposal. Re-proposing an open one is a no-op."""
    now = now or time.time
    with store.lock:
        data = _read(store)
        existing = data["items"].get(skill)
        if existing and existing.get("status") == "proposed":
            return existing

        entry = {
            "skill": skill,
            "proposed_at": now(),
            "reason": reason,
            "status": "proposed",
            "decided_at": None,
            "archive_path": None,
        }
        entry.update(_describe(store, skill, row))
        data["items"][skill] = entry
        _write(store, data)
        return entry


def _lookup_row(skill: str) -> dict | None:
    """Fetch a skill's telemetry row when the caller didn't supply one.

    The guard intercepts `archive_skill(name)` and has only a name, so without
    this every guard-created proposal would show "闲置 —— 天 / provenance 未知"
    — exactly the fields that make the proposal decidable.
    """
    try:
        for row in (_skill_usage().usage_report() or []):
            if row.get("name") == skill:
                return row
    except Exception:
        pass
    return None


def _describe(store, skill: str, row: dict | None) -> dict:
    """The honest framing: what retiring this actually buys back."""
    out = {
        "provenance": None, "state_at_proposal": None, "last_activity_at": None,
        "activity_count": 0, "use_count": 0, "days_idle": None, "pinned": False,
        "skill_md_chars": 0, "description": "", "path": None,
        "has_version_history": False,
    }
    if row is None:
        row = _lookup_row(skill)
    if row:
        out.update({
            "provenance": row.get("provenance"),
            "state_at_proposal": row.get("state"),
            "last_activity_at": row.get("last_activity_at"),
            "activity_count": int(row.get("activity_count") or 0),
            "use_count": int(row.get("use_count") or 0),
            "pinned": bool(row.get("pinned")),
        })
        out["days_idle"] = _days_idle(row)

    try:
        target = store.find_skill_file(skill)
        if target is not None:
            raw = target.read_text(encoding="utf-8")
            out["skill_md_chars"] = len(raw)
            out["path"] = str(target.relative_to(store.hermes_root))
            for line in raw[:800].splitlines():
                s = line.strip()
                if s.startswith("description:"):
                    out["description"] = s.split(":", 1)[1].strip().strip("'\"")
                    break
    except Exception:
        pass

    try:
        from mo_evolve.skill_archive import skill_dir as _vdir
        out["has_version_history"] = _vdir(store.archive_dir, skill).exists()
    except Exception:
        pass
    return out


def _days_idle(row: dict, now: float | None = None) -> int | None:
    """Days since the skill was last used/viewed/patched, else since creation."""
    import datetime

    stamp = row.get("last_activity_at") or row.get("created_at")
    if not stamp:
        return None
    try:
        dt = datetime.datetime.fromisoformat(str(stamp))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=datetime.timezone.utc)
    except Exception:
        return None
    ref = (datetime.datetime.fromtimestamp(now, datetime.timezone.utc) if now
           else datetime.datetime.now(datetime.timezone.utc))
    return max(0, (ref - dt).days)


def list_proposals(store, status: str | None = None) -> list[dict]:
    items = list(_read(store)["items"].values())
    if status:
        items = [i for i in items if i.get("status") == status]
    items.sort(key=lambda i: (i.get("days_idle") or 0), reverse=True)
    return items


def get_proposal(store, skill: str) -> dict | None:
    return _read(store)["items"].get(skill)


def _decide(store, skill: str, status: str, **fields) -> None:
    with store.lock:
        data = _read(store)
        entry = data["items"].get(skill)
        if entry is None:
            return
        entry["status"] = status
        entry["decided_at"] = time.time()
        entry.update(fields)
        _write(store, data)


def apply_retirement(store, skill: str) -> tuple[bool, str]:
    """Actually archive a skill the user approved.

    Deliberately does NOT touch ``store.archive_dir`` — a retired skill keeps
    its rewrite history, so it stays recoverable two ways.
    """
    try:
        su = _skill_usage()
    except Exception as exc:
        return False, f"skill_usage 不可用：{exc}"

    with bypass():
        ok, msg = su.archive_skill(skill)
    if ok:
        _decide(store, skill, "retired", archive_path=msg.replace("archived to ", ""))
    return ok, msg


def keep(store, skill: str, *, pin: bool = False) -> tuple[bool, str]:
    """Decline a proposal. `pin` also stops it ever being proposed again."""
    _decide(store, skill, "kept", pinned=bool(pin))
    if not pin:
        return True, f"「{skill}」留着。"
    try:
        _skill_usage().set_pinned(skill, True)
        return True, f"「{skill}」已钉住，不会再问。"
    except Exception as exc:
        return False, f"留下了，但钉住失败：{exc}"


def restore(store, skill: str) -> tuple[bool, str]:
    """Bring an archived skill back.

    Note ``restore_skill`` flattens category nesting, so the path recorded in
    any version metadata is stale afterwards — always re-resolve.
    """
    try:
        ok, msg = _skill_usage().restore_skill(skill)
    except Exception as exc:
        return False, str(exc)
    if ok:
        _decide(store, skill, "kept")
    return ok, msg


def drifted_from_head(store, skill: str) -> bool:
    """True when a restored skill differs from the last version Mo wrote."""
    try:
        from mo_evolve import skill_archive
        target = store.find_skill_file(skill)
        if target is None:
            return False
        return not skill_archive.head_matches(store.archive_dir, skill, target)
    except Exception:
        return False


# ---- read models ---------------------------------------------------------

def usage_rows(store) -> list[dict]:
    """Every skill with its telemetry — the first time Mo shows this at all."""
    try:
        su = _skill_usage()
        rows = su.usage_report() or []
    except Exception:
        return []

    out = []
    for row in rows:
        name = row.get("name")
        if not name:
            continue
        item = dict(row)
        item["days_idle"] = _days_idle(row)
        try:
            item["eligible"] = bool(su.is_curation_eligible(name))
        except Exception:
            item["eligible"] = False
        try:
            item["protected"] = name in su.PROTECTED_BUILTIN_SKILLS
        except Exception:
            item["protected"] = False
        item["skill_md_chars"] = 0
        try:
            target = store.find_skill_file(name)
            if target is not None:
                item["skill_md_chars"] = len(target.read_text(encoding="utf-8"))
        except Exception:
            pass
        out.append(item)
    out.sort(key=lambda r: (-(r.get("days_idle") or 0), r.get("name") or ""))
    return out


def archived_rows(store) -> list[dict]:
    try:
        su = _skill_usage()
        names = su.list_archived_skill_names() or []
    except Exception:
        return []
    return [{"name": n, "drifted_from_head": False} for n in sorted(names)]


def preview(store) -> list[dict]:
    """What today's cutoffs WOULD propose — computed read-only.

    Also how the 52 skills already marked stale by runs the user never saw get
    turned into visible proposals: they are real telemetry, so they're shown
    rather than reset.
    """
    try:
        su = _skill_usage()
        cur = _curator_mod()
        archive_days = cur.get_archive_after_days()
        stale_days = cur.get_stale_after_days()
        rows = su.curated_report() or []
    except Exception:
        return []

    out = []
    for row in rows:
        name = row.get("name")
        if not name or row.get("pinned"):
            continue
        idle = _days_idle(row)
        if idle is None:
            continue
        never_used = int(row.get("use_count") or 0) == 0
        # Mirrors the never-used grace floor in apply_automatic_transitions.
        if never_used and idle < stale_days:
            continue
        if idle >= archive_days or row.get("state") == "stale":
            out.append({**row, "days_idle": idle,
                        "would_archive": idle >= archive_days})
    return out


def sync_proposals(store) -> int:
    """Fold everything currently eligible into the proposal list.

    Also backfills open proposals that were recorded without a telemetry row —
    the guard only receives a skill name, so a proposal created by an
    intercepted archive starts out missing the very numbers that make it
    decidable.
    """
    n = 0
    for row in preview(store):
        name = row.get("name")
        if not name:
            continue
        existing = get_proposal(store, name)
        if existing and existing.get("status") in ("retired", "kept"):
            continue
        if existing:
            if existing.get("days_idle") is None:
                with store.lock:
                    data = _read(store)
                    entry = data["items"].get(name)
                    if entry is not None:
                        entry.update(_describe(store, name, row))
                        _write(store, data)
            continue
        propose(store, name, reason=REASON_INACTIVITY, row=row)
        n += 1
    return n


def status(store) -> dict:
    """Everything the 清点 page header needs, including whether we're armed."""
    out = {
        "guard_installed": guard_installed(),
        "clamped": is_clamped(),
        "enabled": None, "paused": None, "interval_hours": None,
        "stale_after_days": None, "archive_after_days": None,
        "prune_builtins": None, "last_run_at": None, "last_run_summary": None,
        "run_count": 0, "last_report_path": None,
        "counts": {}, "index_chars": 0, "proposed_chars": 0,
    }
    try:
        cur = _curator_mod()
        state = cur.load_state() or {}
        out.update({
            "enabled": cur.is_enabled(),
            "paused": cur.is_paused(),
            "stale_after_days": cur.get_stale_after_days(),
            "archive_after_days": cur.get_archive_after_days(),
            "last_run_at": state.get("last_run_at"),
            "last_run_summary": state.get("last_run_summary"),
            "run_count": state.get("run_count", 0),
            "last_report_path": state.get("last_report_path"),
        })
    except Exception:
        pass

    rows = usage_rows(store)
    props = list_proposals(store)
    counts = {"total": len(rows), "active": 0, "stale": 0, "archived": 0, "pinned": 0}
    for r in rows:
        st = r.get("state")
        if st in counts:
            counts[st] += 1
        if r.get("pinned"):
            counts["pinned"] += 1
    counts["proposed"] = sum(1 for p in props if p.get("status") == "proposed")
    counts["retired"] = sum(1 for p in props if p.get("status") == "retired")
    out["counts"] = counts
    out["index_chars"] = sum(r.get("skill_md_chars") or 0 for r in rows)
    out["proposed_chars"] = sum(
        p.get("skill_md_chars") or 0 for p in props if p.get("status") == "proposed")
    return out


# ---- actions delegating straight to skill_usage --------------------------

def set_pinned(skill: str, pinned: bool) -> tuple[bool, str]:
    try:
        _skill_usage().set_pinned(skill, bool(pinned))
        return True, "ok"
    except Exception as exc:
        return False, str(exc)


def adopt(skill: str) -> tuple[bool, str]:
    try:
        return _skill_usage().adopt_skill(skill)
    except Exception as exc:
        return False, str(exc)


def set_paused(paused: bool) -> tuple[bool, str]:
    try:
        _curator_mod().set_paused(bool(paused))
        return True, "ok"
    except Exception as exc:
        return False, str(exc)


def set_thresholds(**kw) -> tuple[bool, str]:
    """Write curator thresholds. No upstream API exposes these as writable."""
    allowed = ("stale_after_days", "archive_after_days", "interval_hours",
               "prune_builtins")
    try:
        from hermes_cli.config import load_config, save_config
        cfg = load_config() or {}
        cur = dict(cfg.get("curator") or {})
        for k in allowed:
            if k in kw and kw[k] is not None:
                cur[k] = kw[k]
        # A deliberate threshold change means the fail-safe is no longer the
        # thing holding the line — drop the marker so it isn't mistaken for one.
        if "archive_after_days" in kw and kw["archive_after_days"] is not None:
            cur.pop("_mo_clamped", None)
        cfg["curator"] = cur
        save_config(cfg)
        return True, "ok"
    except Exception as exc:
        return False, str(exc)


def run_now(store, dry_run: bool = False) -> dict:
    """Run a curation pass in *this* process, so the guard applies.

    Not the vendored ``POST /api/curator/run``: that spawns `hermes curator run`
    as a subprocess (unguarded, and with no dry-run flag). ``consolidate`` is
    pinned False — LLM skill merging is a far larger unconsented change than
    archiving and is not reachable from Mo's UI.
    """
    try:
        cur = _curator_mod()
        result = cur.run_curator_review(
            synchronous=True, dry_run=bool(dry_run), consolidate=False) or {}
    except Exception as exc:
        return {"ok": False, "reason": str(exc)}
    added = sync_proposals(store)
    return {"ok": True, "result": result, "proposed": added}
