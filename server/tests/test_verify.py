"""Scoring 夜貘's predictions — the defence against bookkeeping theatre.

An agent that reports its own activity can always look busy. An agent whose
stated expectations are checked against numbers it didn't choose, and counted,
cannot. These tests pin the truth table so the tally means what it claims.
"""

from __future__ import annotations

import pytest

from mo_evolve.verify import (
    accuracy,
    check_one,
    read_calibration,
    record,
    verify_plan,
    verify_run,
)


def _dims(baseline: dict, evolved: dict) -> dict:
    return {"fitness": {"holdout_dimensions": {"baseline": baseline, "evolved": evolved}}}


def _plan(checks, skill="arxiv"):
    return {"id": "p_1", "skill": skill, "prediction": {"statement": "s", "checks": checks}}


# ---- check_one truth table ----

@pytest.mark.parametrize("direction,delta,threshold,expected", [
    ("up",        0.15, 0.10, True),
    ("up",        0.10, 0.10, True),      # boundary counts as met
    ("up",        0.05, 0.10, False),
    ("up",       -0.20, 0.10, False),
    ("down",     -0.15, 0.10, True),
    ("down",     -0.05, 0.10, False),
    ("not_down", -0.01, 0.02, True),
    ("not_down", -0.02, 0.02, True),      # boundary
    ("not_down", -0.05, 0.02, False),
    ("not_down",  0.30, 0.02, True),      # going up satisfies "not down"
    ("not_up",    0.01, 0.02, True),
    ("not_up",    0.30, 0.02, False),
])
def test_check_directions(direction, delta, threshold, expected):
    c = {"dimension": "conciseness", "direction": direction, "threshold": threshold}
    assert check_one(c, {"conciseness": 0.50}, {"conciseness": 0.50 + delta}) is expected


def test_a_missing_dimension_is_unverifiable_not_false():
    """Punishing 夜貘 for the pipeline's gaps would corrupt the tally."""
    c = {"dimension": "conciseness", "direction": "up", "threshold": 0.1}
    assert check_one(c, {}, {}) is None
    assert check_one(c, {"conciseness": 0.5}, {}) is None


def test_a_non_numeric_score_is_unverifiable():
    c = {"dimension": "conciseness", "direction": "up", "threshold": 0.1}
    assert check_one(c, {"conciseness": "high"}, {"conciseness": "higher"}) is None


def test_an_unknown_direction_is_unverifiable():
    c = {"dimension": "conciseness", "direction": "sideways", "threshold": 0.1}
    assert check_one(c, {"conciseness": 0.1}, {"conciseness": 0.9}) is None


# ---- verify_plan ----

def test_all_checks_must_hold():
    """A prediction with an escape hatch isn't falsifiable."""
    plan = _plan([
        {"dimension": "conciseness", "direction": "up", "threshold": 0.10},
        {"dimension": "correctness", "direction": "not_down", "threshold": 0.02},
    ])
    metrics = _dims({"conciseness": 0.50, "correctness": 0.70},
                    {"conciseness": 0.65, "correctness": 0.69})
    assert verify_plan(plan, metrics)["prediction"]["verified"] is True


def test_one_failed_check_fails_the_prediction():
    plan = _plan([
        {"dimension": "conciseness", "direction": "up", "threshold": 0.10},
        {"dimension": "correctness", "direction": "not_down", "threshold": 0.02},
    ])
    metrics = _dims({"conciseness": 0.50, "correctness": 0.70},
                    {"conciseness": 0.65, "correctness": 0.50})   # correctness tanked
    assert verify_plan(plan, metrics)["prediction"]["verified"] is False


def test_a_prediction_with_no_checks_is_unverifiable_not_correct():
    """"I predict something good will happen" earns no credit."""
    assert verify_plan(_plan([]), _dims({"a": 1}, {"a": 2}))["prediction"]["verified"] is None


def test_missing_metrics_make_it_unverifiable():
    plan = _plan([{"dimension": "conciseness", "direction": "up", "threshold": 0.1}])
    assert verify_plan(plan, {})["prediction"]["verified"] is None


def test_partially_decidable_checks_use_what_is_available():
    plan = _plan([
        {"dimension": "conciseness", "direction": "up", "threshold": 0.10},
        {"dimension": "procedure_following", "direction": "up", "threshold": 0.10},
    ])
    metrics = _dims({"conciseness": 0.5}, {"conciseness": 0.7})   # no procedure_following
    out = verify_plan(plan, metrics)
    assert out["prediction"]["verified"] is True
    assert [r["outcome"] for r in out["prediction"]["check_results"]] == [True, None]


def test_verify_stamps_a_timestamp():
    out = verify_plan(_plan([]), {}, now=lambda: 12345.0)
    assert out["prediction"]["verified_at"] == 12345.0


# ---- calibration ----

def test_the_tally_counts_hits_and_misses(store):
    record(store, verify_plan(_plan([{"dimension": "c", "direction": "up", "threshold": 0.1}]),
                              _dims({"c": 0.1}, {"c": 0.9})))
    record(store, verify_plan(_plan([{"dimension": "c", "direction": "up", "threshold": 0.1}]),
                              _dims({"c": 0.9}, {"c": 0.1})))
    cal = read_calibration(store)
    assert cal["total"] == 2 and cal["verified"] == 1
    assert accuracy(cal) == pytest.approx(0.5)


def test_the_tally_can_go_down(store):
    """A metric that only ever rises is not evidence of anything."""
    good = {"dimension": "c", "direction": "up", "threshold": 0.1}
    record(store, verify_plan(_plan([good]), _dims({"c": 0.1}, {"c": 0.9})))
    assert accuracy(read_calibration(store)) == pytest.approx(1.0)

    record(store, verify_plan(_plan([good]), _dims({"c": 0.9}, {"c": 0.1})))
    assert accuracy(read_calibration(store)) == pytest.approx(0.5)


def test_unverifiable_plans_are_counted_separately(store):
    """A 夜貘 that keeps making unfalsifiable predictions is telling you
    something too — but it must not dilute the hit rate."""
    record(store, verify_plan(_plan([]), {}))
    cal = read_calibration(store)
    assert cal["total"] == 0 and cal["unverifiable"] == 1
    assert accuracy(cal) is None


def test_per_skill_breakdown(store):
    good = {"dimension": "c", "direction": "up", "threshold": 0.1}
    record(store, verify_plan(_plan([good], skill="arxiv"), _dims({"c": 0.1}, {"c": 0.9})))
    record(store, verify_plan(_plan([good], skill="arxiv"), _dims({"c": 0.9}, {"c": 0.1})))
    record(store, verify_plan(_plan([good], skill="other"), _dims({"c": 0.1}, {"c": 0.9})))
    by = read_calibration(store)["by_skill"]
    assert by["arxiv"] == {"total": 2, "verified": 1, "unverifiable": 0}
    assert by["other"]["verified"] == 1


def test_accuracy_of_an_empty_tally(store):
    assert accuracy(read_calibration(store)) is None


# ---- verify_run ----

def _write_run(store, tmp_path, plan, baseline, evolved):
    from mo_evolve.reflect import save_plan
    from mo_evolve.store import write_json

    save_plan(store, plan)
    out = tmp_path / "out"
    out.mkdir(exist_ok=True)
    write_json(out / "metrics.json", _dims(baseline, evolved))
    return {"id": "r1", "skill": plan["skill"], "plan_id": plan["id"],
            "output_dir": str(out), "status": "done"}


def test_verify_run_scores_and_records(store, tmp_path):
    plan = _plan([{"dimension": "conciseness", "direction": "up", "threshold": 0.10}])
    run = _write_run(store, tmp_path, plan, {"conciseness": 0.5}, {"conciseness": 0.7})

    out = verify_run(store, run)
    assert out["prediction"]["verified"] is True
    assert out["run_id"] == "r1"
    assert read_calibration(store)["verified"] == 1


def test_verify_run_is_idempotent(store, tmp_path):
    """The scheduler and a manual refresh could both reach this; scoring twice
    would inflate the tally."""
    plan = _plan([{"dimension": "conciseness", "direction": "up", "threshold": 0.10}])
    run = _write_run(store, tmp_path, plan, {"conciseness": 0.5}, {"conciseness": 0.7})

    verify_run(store, run)
    verify_run(store, run)
    assert read_calibration(store)["total"] == 1


def test_a_run_without_a_plan_is_skipped(store):
    assert verify_run(store, {"id": "r1", "skill": "x"}) is None


def test_a_run_whose_plan_vanished_is_skipped(store):
    assert verify_run(store, {"id": "r1", "skill": "x", "plan_id": "p_gone"}) is None


# ---- regressions ----

def test_a_failed_run_still_stamps_its_plan(store, tmp_path):
    """verify.py documents that unverifiable plans are 'counted separately
    rather than dropped'. Failed runs used to skip verification entirely, so
    their plans were dropped — the 「另有 N 次无法核验」 line under-reported."""
    plan = _plan([{"dimension": "conciseness", "direction": "up", "threshold": 0.10}])
    from mo_evolve.reflect import save_plan
    save_plan(store, plan)
    run = {"id": "r1", "skill": plan["skill"], "plan_id": plan["id"],
           "output_dir": "", "status": "failed"}

    out = verify_run(store, run)
    assert out["prediction"]["verified"] is None
    cal = read_calibration(store)
    assert cal["unverifiable"] == 1
    assert cal["total"] == 0, "a failed run must not count as a wrong prediction"
