"""The accept path — every guard between a bad candidate and the live skill."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from mo_evolve import skill_archive as archive
from mo_evolve.accept import AcceptRefused, apply_run, is_stale
from mo_evolve.gate import read_pins
from mo_evolve.store import read_json

ORIGINAL = "---\nname: arxiv\ndescription: d\n---\n\nHand-written body.\n"
EVOLVED = "---\nname: arxiv\ndescription: d\n---\n\nEvolved body with a length cap.\n"


@pytest.fixture
def run_dir(tmp_hermes_home) -> Path:
    d = tmp_hermes_home / "profiles" / "ye-mao-evolve" / "evolve" / "runs" / "r1" / "out"
    d.mkdir(parents=True)
    (d / "baseline_skill.md").write_text(ORIGINAL, encoding="utf-8")
    (d / "evolved_skill.md").write_text(EVOLVED, encoding="utf-8")
    (d / "metrics.json").write_text(json.dumps({
        # `holdout_examples` is an int count in the same file (it predates the
        # pin set); the pin payload deliberately uses a distinct key.
        "holdout_examples": 2,
        "holdout_pin_examples": [
            {"task_input": "summarize 2401.00001", "expected_behavior": "three bullets"},
            {"task_input": "summarize 2401.00002", "expected_behavior": "three bullets"},
        ],
    }), encoding="utf-8")
    return d


def _gate_file(run_dir: Path, passed: bool, reason: str = "r") -> None:
    (run_dir / "gate.json").write_text(json.dumps({
        "passed": passed, "reason": reason, "delta": 0.08,
        "ci_low": 0.03, "ci_high": 0.13, "n": 8,
    }), encoding="utf-8")


def _run(run_dir: Path) -> dict:
    return {"id": "r1", "skill": "arxiv", "output_dir": str(run_dir), "status": "done"}


@pytest.fixture
def target(store, make_skill):
    p = make_skill("arxiv")
    p.write_text(ORIGINAL, encoding="utf-8")
    return p


# ---- happy path ----

def test_a_passing_run_applies_and_archives(store, run_dir, target):
    _gate_file(run_dir, True)
    store.insert_run(_run(run_dir))

    res = apply_run(store, _run(run_dir), target)

    assert target.read_text(encoding="utf-8") == EVOLVED
    assert res.archive_version == 1
    assert res.gate_passed is True
    assert res.forced is False
    # The previous contents must be recoverable.
    assert archive.read_version(store.archive_dir, "arxiv", 1) == ORIGINAL


def test_accept_records_fields_not_new_statuses(store, run_dir, target):
    """HarnessEvolve.tsx maps status → label/colour; an unknown status renders
    blank. New information has to arrive as fields."""
    _gate_file(run_dir, True)
    store.insert_run(_run(run_dir))
    apply_run(store, _run(run_dir), target)

    saved = store.get_run("r1")
    assert saved["status"] == "accepted"          # an existing, mapped value
    assert saved["archive_version"] == 1
    assert saved["gate_passed"] is True
    assert saved["forced"] is False
    assert saved["pins"] == 2


def test_holdout_becomes_the_regression_ratchet(store, run_dir, target):
    _gate_file(run_dir, True)
    store.insert_run(_run(run_dir))
    res = apply_run(store, _run(run_dir), target)

    assert res.pins == 2
    pins = read_pins(store.pins_dir, "arxiv")
    assert {p["task_input"] for p in pins} == {
        "summarize 2401.00001", "summarize 2401.00002"}
    assert all(p.get("added_at") for p in pins)


def test_accept_does_not_hot_swap(store, run_dir, target):
    """An in-flight session already built its prompt prefix; the UI must be able
    to say 「下次新会话生效」 rather than implying the live turn just changed."""
    _gate_file(run_dir, True)
    store.insert_run(_run(run_dir))
    res = apply_run(store, _run(run_dir), target)

    assert res.activation == "next_session"
    pending = read_json(store.pending_file, {})
    assert pending["skill"] == "arxiv" and pending["version"] == 1


def test_head_tracks_the_applied_text(store, run_dir, target):
    _gate_file(run_dir, True)
    store.insert_run(_run(run_dir))
    apply_run(store, _run(run_dir), target)
    assert archive.head_matches(store.archive_dir, "arxiv", target)


# ---- the gate ----

def test_a_failing_gate_refuses(store, run_dir, target):
    _gate_file(run_dir, False, reason="未达显著性门槛")
    store.insert_run(_run(run_dir))

    with pytest.raises(AcceptRefused) as e:
        apply_run(store, _run(run_dir), target)

    assert e.value.error == "gate_failed"
    assert "显著性" in e.value.message
    assert target.read_text(encoding="utf-8") == ORIGINAL, "the live skill is untouched"


def test_force_overrides_a_failing_gate_and_is_recorded(store, run_dir, target):
    _gate_file(run_dir, False)
    store.insert_run(_run(run_dir))

    res = apply_run(store, _run(run_dir), target, force=True)

    assert res.forced is True
    assert res.gate_passed is False
    assert target.read_text(encoding="utf-8") == EVOLVED
    assert store.get_run("r1")["forced"] is True
    # Forced or not, it must still be revertible.
    assert archive.read_version(store.archive_dir, "arxiv", 1) == ORIGINAL


def test_a_missing_gate_file_does_not_block(store, run_dir, target):
    """Runs produced before the gate existed must remain acceptable."""
    store.insert_run(_run(run_dir))
    res = apply_run(store, _run(run_dir), target)
    assert res.gate_passed is None
    assert target.read_text(encoding="utf-8") == EVOLVED


def test_refusal_detail_serializes_for_the_api(store, run_dir, target):
    _gate_file(run_dir, False)
    store.insert_run(_run(run_dir))
    with pytest.raises(AcceptRefused) as e:
        apply_run(store, _run(run_dir), target)
    detail = e.value.to_detail()
    json.dumps(detail)
    assert detail["verdict"]["ci_low"] == 0.03


# ---- staleness ----

def test_a_hand_edit_since_the_run_started_refuses(store, run_dir, target):
    _gate_file(run_dir, True)
    store.insert_run(_run(run_dir))
    target.write_text(ORIGINAL + "\nThe user added this line at noon.\n", encoding="utf-8")

    with pytest.raises(AcceptRefused) as e:
        apply_run(store, _run(run_dir), target)

    assert e.value.error == "stale_baseline"
    assert "The user added this line" in target.read_text(encoding="utf-8")


def test_force_overrides_staleness(store, run_dir, target):
    _gate_file(run_dir, True)
    store.insert_run(_run(run_dir))
    edited = ORIGINAL + "\nhand edit\n"
    target.write_text(edited, encoding="utf-8")

    apply_run(store, _run(run_dir), target, force=True)

    assert target.read_text(encoding="utf-8") == EVOLVED
    # The clobbered edit is still recoverable — that is the whole point.
    assert archive.read_version(store.archive_dir, "arxiv", 1) == edited


def test_staleness_is_checked_before_the_gate(store, run_dir, target):
    """Both are wrong; the user's own work is the more urgent thing to report."""
    _gate_file(run_dir, False)
    store.insert_run(_run(run_dir))
    target.write_text("hand edited", encoding="utf-8")

    with pytest.raises(AcceptRefused) as e:
        apply_run(store, _run(run_dir), target)
    assert e.value.error == "stale_baseline"


def test_is_stale_without_a_baseline_file(tmp_path):
    t = tmp_path / "SKILL.md"
    t.write_text("x", encoding="utf-8")
    assert not is_stale(t, tmp_path / "absent.md")


# ---- missing candidate ----

def test_a_run_with_no_evolved_file_refuses(store, tmp_hermes_home, target):
    d = tmp_hermes_home / "empty-run"
    d.mkdir()
    with pytest.raises(AcceptRefused) as e:
        apply_run(store, {"id": "r9", "skill": "arxiv", "output_dir": str(d)}, target)
    assert e.value.error == "no_candidate"


# ---- end-to-end: the scenario the plan calls out ----

def test_forced_regression_can_be_reverted_byte_for_byte(store, run_dir, target):
    """Force-accept a candidate the gate rejected, then undo it completely."""
    _gate_file(run_dir, False, reason="回归")
    store.insert_run(_run(run_dir))

    apply_run(store, _run(run_dir), target, force=True)
    assert target.read_text(encoding="utf-8") == EVOLVED

    ok, msg = archive.revert(store.archive_dir, target, "arxiv")
    assert ok, msg
    assert target.read_text(encoding="utf-8") == ORIGINAL


# ---- regressions ----

def test_a_legacy_run_with_an_int_holdout_count_does_not_half_apply(store, run_dir, target):
    """Runs written before the pin set existed store `holdout_examples` as an
    integer count. Iterating it raised *after* the file had been overwritten,
    leaving the skill replaced but the run ledger and pending marker unwritten
    — the button looked dead while the skill had silently changed."""
    _gate_file(run_dir, True)
    (run_dir / "metrics.json").write_text(json.dumps({"holdout_examples": 5}), encoding="utf-8")
    store.insert_run(_run(run_dir))

    res = apply_run(store, _run(run_dir), target)

    assert res.pins == 0
    assert target.read_text(encoding="utf-8") == EVOLVED
    assert store.get_run("r1")["status"] == "accepted"
    assert read_json(store.pending_file, {}).get("skill") == "arxiv"


def test_malformed_pin_examples_are_skipped_not_fatal(store, run_dir, target):
    _gate_file(run_dir, True)
    (run_dir / "metrics.json").write_text(json.dumps({
        "holdout_pin_examples": ["not a dict", {"no_task_input": 1},
                                 {"task_input": "good", "expected_behavior": "x"}],
    }), encoding="utf-8")
    store.insert_run(_run(run_dir))

    res = apply_run(store, _run(run_dir), target)
    assert res.pins == 1
    assert [p["task_input"] for p in read_pins(store.pins_dir, "arxiv")] == ["good"]


def test_a_missing_metrics_file_still_applies(store, run_dir, target):
    _gate_file(run_dir, True)
    (run_dir / "metrics.json").unlink()
    store.insert_run(_run(run_dir))
    res = apply_run(store, _run(run_dir), target)
    assert res.pins == 0
    assert target.read_text(encoding="utf-8") == EVOLVED
