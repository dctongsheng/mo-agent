"""Applying an evolved skill — the guarded replacement for a bare write_text.

Kept out of the gateway closure so the decision logic is unit-testable. The
route handler is a thin wrapper that turns ``AcceptRefused`` into a 409.

Order of checks matters, and it is not arbitrary:

1. **Staleness** before anything else, because it's about the *user's* work.
   A nightly run started at 03:00 and accepted at 18:00 would otherwise
   silently discard every hand edit made in between.
2. **The gate**, because a candidate that didn't provably improve shouldn't be
   one click away from deployment.
3. Only then do we touch the file — and we snapshot first, so there is a way
   back.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path

from mo_evolve import gate as _gate
from mo_evolve import skill_archive as _archive
from mo_evolve.store import read_json, write_json


@dataclass
class AcceptRefused(Exception):
    """A refusal the user can override with an explicit force-confirm."""
    error: str
    message: str
    verdict: dict | None = None

    def to_detail(self) -> dict:
        d = {"error": self.error, "message": self.message}
        if self.verdict is not None:
            d["verdict"] = self.verdict
        return d


@dataclass
class AcceptResult:
    applied_to: str
    archive_version: int
    pins: int
    forced: bool
    gate_passed: bool | None
    activation: str = "next_session"

    def to_dict(self) -> dict:
        return {
            "ok": True,
            "applied_to": self.applied_to,
            "archive_version": self.archive_version,
            "pins": self.pins,
            "forced": self.forced,
            "gate_passed": self.gate_passed,
            "activation": self.activation,
        }


def is_stale(target: Path, baseline_file: Path) -> bool:
    """True when the live skill no longer matches what the run started against."""
    if not baseline_file.exists():
        return False  # nothing to compare — don't invent a conflict
    return _archive.sha256_file(target) != _archive.sha256_file(baseline_file)


def apply_run(
    store,
    run: dict,
    target: Path,
    force: bool = False,
    now=None,
) -> AcceptResult:
    """Apply a completed run's evolved skill to ``target``.

    Raises ``AcceptRefused`` when a guard trips and ``force`` is False.
    """
    now = now or time.time
    out_dir = Path(run["output_dir"])
    evolved_file = out_dir / "evolved_skill.md"
    baseline_file = out_dir / "baseline_skill.md"
    skill = run["skill"]

    if not evolved_file.exists():
        raise AcceptRefused("no_candidate", "该次进化没有产出可用的技艺文本。")

    evolved_text = evolved_file.read_text(encoding="utf-8")

    if not force and is_stale(target, baseline_file):
        raise AcceptRefused(
            "stale_baseline",
            "这条技艺在本次进化开始后被改动过，采纳会覆盖那些改动。",
        )

    verdict = read_json(out_dir / "gate.json", None)
    if not force and verdict is not None and not verdict.get("passed", False):
        raise AcceptRefused(
            "gate_failed",
            verdict.get("reason", "未通过采纳门槛"),
            verdict=verdict,
        )

    # Read the pin examples BEFORE touching the file. A run written by an older
    # build stores `holdout_examples` as an integer count, and anything that
    # raises after apply_atomic leaves the skill replaced but the run ledger and
    # pending marker unwritten — a half-applied state the UI can't show.
    metrics = read_json(out_dir / "metrics.json", {})
    raw_examples = metrics.get("holdout_pin_examples")
    stamped = []
    if isinstance(raw_examples, list):
        stamped = [dict(ex, added_at=now()) for ex in raw_examples
                   if isinstance(ex, dict) and ex.get("task_input")]

    version = _archive.snapshot(
        store.archive_dir, target, skill, run_id=run.get("id", ""),
        meta={"kind": "pre-accept", "gate": verdict, "forced": force},
    )
    _archive.apply_atomic(target, evolved_text)
    _archive.set_head(store.archive_dir, skill, version, evolved_text)

    # Donate the holdout to the skill's regression ratchet.
    pins = _gate.append_pins(store.pins_dir, skill, stamped) if stamped else 0

    # No hot-swap: an in-flight session already built its prompt prefix. This
    # marker is what lets the UI say 「下次新会话生效」 rather than implying the
    # running conversation just changed under the user.
    write_json(store.pending_file, {"skill": skill, "version": version, "at": now()})

    try:
        applied_to = str(Path(target).relative_to(store.hermes_root))
    except ValueError:
        applied_to = str(target)

    store.update_run(
        run["id"],
        status="accepted",
        applied_at=now(),
        applied_to=applied_to,
        archive_version=version,
        forced=force,
        gate_passed=bool(verdict.get("passed")) if verdict else None,
        pins=pins,
    )

    return AcceptResult(
        applied_to=applied_to,
        archive_version=version,
        pins=pins,
        forced=force,
        gate_passed=bool(verdict.get("passed")) if verdict else None,
    )
