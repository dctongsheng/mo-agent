"""Run/schedule state for the 夜貘 evolution loop.

Lifted verbatim out of the ``_mount_mo_routes`` closure in ``mo-gateway.py`` so
the behaviour can be unit-tested without FastAPI or a live HERMES_HOME. The
gateway now constructs one ``EvolveStore`` and delegates to it; the route
handlers are thin.
"""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path

EVOLVER_PROFILE = "ye-mao-evolve"


def read_json(p: Path, default):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return default


def write_json(p: Path, data) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")


class EvolveStore:
    """Owns everything under ``<hermes_root>/profiles/ye-mao-evolve/evolve/``.

    The evolver *profile* is where run bookkeeping lives, but evolution itself
    operates on the user's real skills dir (``<hermes_root>/skills``) — a newly
    authored skill is immediately evolvable, and accept writes back to the file
    the user owns. The profile's seeded skills clone is not used for runs.
    """

    def __init__(self, hermes_root: Path):
        self.hermes_root = Path(hermes_root)
        self.evolver_home = self.hermes_root / "profiles" / EVOLVER_PROFILE
        self.evolve_dir = self.evolver_home / "evolve"
        self.runs_file = self.evolve_dir / "runs.json"
        self.schedule_file = self.evolve_dir / "schedule.json"
        self.auto_cursor_file = self.evolve_dir / "auto_cursor.json"
        self.pending_file = self.evolve_dir / "pending.json"
        self.archive_dir = self.evolve_dir / "archive"
        self.pins_dir = self.evolve_dir / "pins"
        self.skills_dir = self.hermes_root / "skills"
        self.lock = threading.Lock()
        self._bundled_cache: dict = {}

    # ---- runs ----

    def read_runs(self) -> list:
        return read_json(self.runs_file, [])

    def write_runs(self, runs: list) -> None:
        self.evolve_dir.mkdir(parents=True, exist_ok=True)
        write_json(self.runs_file, runs)

    def insert_run(self, entry: dict) -> None:
        with self.lock:
            runs = self.read_runs()
            runs.insert(0, entry)
            self.write_runs(runs)

    def update_run(self, run_id: str, **fields) -> None:
        with self.lock:
            runs = self.read_runs()
            for r in runs:
                if r["id"] == run_id:
                    r.update(fields)
                    break
            self.write_runs(runs)

    def get_run(self, run_id: str) -> dict | None:
        return next((r for r in self.read_runs() if r["id"] == run_id), None)

    # ---- pending activation ----
    # Skill writes land on disk immediately but the running gateway keeps
    # serving its cached skills index, so nothing takes effect until the next
    # process start. This list is what lets every surface say how many changes
    # are waiting rather than each one guessing.

    def read_pending(self) -> list:
        data = read_json(self.pending_file, [])
        if isinstance(data, dict):
            return [data]            # pre-list format: a single entry
        return data if isinstance(data, list) else []

    def add_pending(self, entry: dict) -> int:
        with self.lock:
            items = [i for i in self.read_pending()
                     if i.get("skill") != entry.get("skill")]
            items.append(entry)
            write_json(self.pending_file, items)
            return len(items)

    def clear_pending(self) -> None:
        write_json(self.pending_file, [])

    # ---- schedule ----

    def read_schedule(self) -> dict:
        return read_json(
            self.schedule_file,
            {"enabled": False, "hour": 3, "minute": 0, "skill": "auto", "iterations": 4},
        )

    def write_schedule(self, sched: dict) -> None:
        self.evolve_dir.mkdir(parents=True, exist_ok=True)
        write_json(self.schedule_file, sched)

    # ---- skills ----

    def bundled_skill_names(self) -> set:
        """Names of skills that ship with Hermes (vs. user/self-authored).

        Union of (a) the per-profile bundled manifest written at seed time and
        (b) a full scan of the installed agent's bundle skills dir — recording
        BOTH directory names and frontmatter names, since they often differ
        (dir "audiocraft" vs name "audiocraft-audio-generation"). A stale
        manifest alone misses a few skills, so we union both for recall.
        Cached for the process lifetime.
        """
        if "names" in self._bundled_cache:
            return self._bundled_cache["names"]
        names: set = set()
        manifest = self.skills_dir / ".bundled_manifest"
        try:
            for line in manifest.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if line and not line.startswith("#"):
                    names.add(line.split(":", 1)[0].strip())
        except Exception:
            pass
        # Hermes ships skills under both skills/ and optional-skills/.
        agent_root = os.environ.get("HERMES_AGENT_ROOT", "")
        roots = [
            Path(os.path.expanduser("~/.hermes/hermes-agent/skills")),
            Path(os.path.expanduser("~/.hermes/hermes-agent/optional-skills")),
        ]
        if agent_root:
            roots += [Path(agent_root) / "skills", Path(agent_root) / "optional-skills"]
        for root in roots:
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
        self._bundled_cache["names"] = names
        return names

    def list_skills(self) -> list:
        out = []
        if not self.skills_dir.exists():
            return out
        bundled = self.bundled_skill_names()
        for md in self.skills_dir.rglob("SKILL.md"):
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
            # scan yields directory names. A skill is built-in if either matches.
            out.append({
                "name": name,
                "description": desc,
                "size": len(raw),
                "path": str(md.relative_to(self.hermes_root)),
                "builtin": (name in bundled) or (md.parent.name in bundled),
            })
        out.sort(key=lambda x: x["name"])
        return out

    def find_skill_file(self, skill: str) -> Path | None:
        """Locate a skill's SKILL.md by directory name or frontmatter name."""
        if not self.skills_dir.exists():
            return None
        for md in self.skills_dir.rglob("SKILL.md"):
            if md.parent.name == skill:
                return md
        for md in self.skills_dir.rglob("SKILL.md"):
            try:
                head = md.read_text(encoding="utf-8")[:400]
            except Exception:
                continue
            wanted = (f"name: {skill}", f'name: "{skill}"', f"name: '{skill}'")
            if any(line.strip() in wanted for line in head.splitlines()):
                return md
        return None

    # ---- auto-rotation cursor ----

    def next_auto_skill(self) -> str:
        """Round-robin over NON-built-in skills, one per scheduled run.

        Phase 4 replaces this with 夜貘's own reasoned selection; this stays as
        the fallback for when reflection is unavailable or abstains.
        """
        custom = sorted(s["name"] for s in self.list_skills() if not s.get("builtin"))
        if not custom:
            return ""
        last = read_json(self.auto_cursor_file, {}).get("last", "")
        try:
            nxt = custom[(custom.index(last) + 1) % len(custom)]
        except ValueError:
            nxt = custom[0]  # last not in current list → start from the first
        self.evolve_dir.mkdir(parents=True, exist_ok=True)
        write_json(self.auto_cursor_file, {"last": nxt})
        return nxt
