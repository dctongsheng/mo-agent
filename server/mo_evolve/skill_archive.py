"""Versioned history for evolved skills, with revert.

``evolve_accept()`` used to be a bare ``target.write_text(evolved)``. Once a
rewrite landed, the previous SKILL.md was gone — no backup, no revert path. For
a desktop app whose whole pitch is that an agent improves itself overnight, an
irreversible write is the wrong default.

Layout, per skill::

    <evolve>/archive/<skill>/
        v0001.md     v0001.json      # the text as it was, plus why it was replaced
        v0002.md     v0002.json
        HEAD.json                    # what the live file should currently be

Each ``vNNNN.md`` is a snapshot taken *before* an accept — so ``v0001.md`` is
the hand-written original, and reverting to it undoes the first evolution.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
from pathlib import Path


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def sha256_file(p: Path) -> str:
    try:
        return sha256_text(Path(p).read_text(encoding="utf-8"))
    except Exception:
        return ""


def _safe(name: str) -> str:
    """Skill names come from user-authored frontmatter — keep them in-directory."""
    return "".join(c if (c.isalnum() or c in "-_.") else "_" for c in name).strip("._") or "skill"


def skill_dir(archive_dir: Path, skill: str) -> Path:
    return Path(archive_dir) / _safe(skill)


def apply_atomic(target: Path, text: str) -> None:
    """Write via a temp file in the same directory + ``os.replace``.

    A torn SKILL.md is worse than a stale one: the agent loads it at session
    start and a half-written frontmatter block breaks skill discovery entirely.
    """
    target = Path(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(target.suffix + ".tmp")
    try:
        tmp.write_text(text, encoding="utf-8")
        os.replace(tmp, target)
    finally:
        if tmp.exists():
            tmp.unlink()


def _next_version(d: Path) -> int:
    if not d.exists():
        return 1
    versions = []
    for p in d.glob("v*.json"):
        try:
            versions.append(int(p.stem[1:]))
        except ValueError:
            continue
    return (max(versions) + 1) if versions else 1


def snapshot(archive_dir: Path, target: Path, skill: str, run_id: str = "",
             meta: dict | None = None) -> int:
    """Record the target file's *current* contents as a new archive version.

    Returns the version number. Called immediately before an accept or a revert
    so every destructive write has a predecessor on disk.
    """
    d = skill_dir(archive_dir, skill)
    d.mkdir(parents=True, exist_ok=True)
    version = _next_version(d)

    target = Path(target)
    text = target.read_text(encoding="utf-8") if target.exists() else ""

    (d / f"v{version:04d}.md").write_text(text, encoding="utf-8")
    entry = {
        "version": version,
        "at": time.time(),
        "run_id": run_id,
        "kind": (meta or {}).get("kind", "pre-accept"),
        "path": str(target),
        "sha256": sha256_text(text),
        "size": len(text),
        "existed": target.exists(),
    }
    entry.update({k: v for k, v in (meta or {}).items() if k != "kind"})
    (d / f"v{version:04d}.json").write_text(
        json.dumps(entry, ensure_ascii=False, indent=1), encoding="utf-8")
    return version


def set_head(archive_dir: Path, skill: str, version: int, text: str) -> None:
    d = skill_dir(archive_dir, skill)
    d.mkdir(parents=True, exist_ok=True)
    (d / "HEAD.json").write_text(json.dumps({
        "current_version": version,
        "current_sha256": sha256_text(text),
        "updated_at": time.time(),
    }, ensure_ascii=False, indent=1), encoding="utf-8")


def read_head(archive_dir: Path, skill: str) -> dict:
    p = skill_dir(archive_dir, skill) / "HEAD.json"
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return {}


def head_matches(archive_dir: Path, skill: str, target: Path) -> bool:
    """True when the live file is what we last wrote.

    False means the user (or another tool) edited the skill by hand since the
    last accept — a signal that a stale evolved candidate would clobber their
    work.
    """
    head = read_head(archive_dir, skill)
    if not head:
        return True  # never managed by us; nothing to contradict
    return head.get("current_sha256") == sha256_file(target)


def list_versions(archive_dir: Path, skill: str) -> list[dict]:
    """Archive entries, newest first."""
    d = skill_dir(archive_dir, skill)
    if not d.exists():
        return []
    out = []
    for p in sorted(d.glob("v*.json")):
        try:
            out.append(json.loads(p.read_text(encoding="utf-8")))
        except Exception:
            continue
    out.sort(key=lambda e: e.get("version", 0), reverse=True)
    return out


def read_version(archive_dir: Path, skill: str, version: int) -> str | None:
    p = skill_dir(archive_dir, skill) / f"v{version:04d}.md"
    if not p.exists():
        return None
    return p.read_text(encoding="utf-8")


def revert(archive_dir: Path, target: Path, skill: str,
           version: int | None = None) -> tuple[bool, str]:
    """Restore a previous version of a skill.

    ``version=None`` restores the most recent snapshot — i.e. undoes the last
    accept. The current contents are snapshotted first, so a revert is itself
    revertible.
    """
    versions = list_versions(archive_dir, skill)
    if not versions:
        return False, "该技艺没有存档版本"

    if version is None:
        version = versions[0]["version"]

    text = read_version(archive_dir, skill, version)
    if text is None:
        return False, f"版本 v{version:04d} 不存在"

    # Snapshot what we're about to overwrite, so revert-of-revert works.
    new_version = snapshot(archive_dir, target, skill, meta={"kind": "pre-revert",
                                                            "reverted_to": version})

    # A version recorded with existed=False means the skill did not exist yet —
    # that's what a newly authored skill's v0001 looks like. Writing its (empty)
    # text back would leave a zero-byte SKILL.md, which is worse than the skill
    # being gone: the directory is still indexed, so the agent keeps offering a
    # skill with no content. Reverting to "it didn't exist" must remove it.
    meta = next((v for v in list_versions(archive_dir, skill)
                 if v.get("version") == version), {})
    if meta.get("existed") is False:
        import shutil
        target = Path(target)
        try:
            if target.parent.exists():
                shutil.rmtree(target.parent)
        except Exception as exc:
            return False, f"回退失败（无法移除技艺目录）：{exc}"
        set_head(archive_dir, skill, new_version, "")
        return True, f"已回退到「尚不存在」（当前内容已存为 v{new_version:04d}）"

    apply_atomic(Path(target), text)
    set_head(archive_dir, skill, new_version, text)
    return True, f"已回退到 v{version:04d}（当前内容已存为 v{new_version:04d}）"
