"""Check whether 夜貘's predictions came true, and keep score.

A plan says "adding a length constraint will raise conciseness by ≥0.10 without
costing more than 0.02 of correctness". After the run completes, that claim is
checked against ``metrics.fitness.holdout_dimensions`` — numbers produced by the
LLM judge on held-out examples, which the prediction had no hand in choosing.

The running tally is the deliverable. An agent that reports its own activity can
always look busy; an agent whose stated expectations are checked and counted
cannot. If 夜貘's hit rate sits at chance, its "reasoning" is decoration and the
UI will say so — which is the point. A metric that can only go up is not
evidence of anything.
"""

from __future__ import annotations

import time
from pathlib import Path

from mo_evolve.store import read_json, write_json


def check_one(check: dict, baseline: dict, evolved: dict) -> bool | None:
    """Evaluate a single prediction check.

    Returns True/False, or **None when it cannot be evaluated** — a missing
    dimension means "no evidence either way", and scoring that as a miss would
    punish 夜貘 for the pipeline's gaps rather than its own judgement.
    """
    dim = check.get("dimension")
    if dim not in baseline or dim not in evolved:
        return None
    try:
        b = float(baseline[dim])
        e = float(evolved[dim])
        threshold = abs(float(check.get("threshold", 0.05)))
    except (TypeError, ValueError):
        return None

    delta = e - b
    direction = check.get("direction")

    # Compare with a tolerance: `0.6 - 0.5` is 0.09999999999999998, so a
    # prediction of "up by 0.10" that lands exactly on 0.10 would otherwise be
    # scored as a miss. Being wrong about 夜貘 by a float artefact is worse than
    # being generous at the boundary.
    eps = 1e-9
    if direction == "up":
        return delta >= threshold - eps
    if direction == "down":
        return delta <= -threshold + eps
    if direction == "not_down":
        return delta >= -threshold - eps
    if direction == "not_up":
        return delta <= threshold + eps
    return None


def verify_plan(plan: dict, metrics: dict, now=None) -> dict:
    """Verify every check in a plan against a completed run's metrics.

    Mutates and returns the plan with ``prediction.verified`` set to True,
    False, or None (unverifiable). A plan with no checks is unverifiable, not
    correct — "I predict something good will happen" earns no credit.
    """
    now = now or time.time
    pred = plan.setdefault("prediction", {})
    checks = pred.get("checks") or []

    dims = ((metrics or {}).get("fitness") or {}).get("holdout_dimensions") or {}
    baseline = dims.get("baseline") or {}
    evolved = dims.get("evolved") or {}

    results = []
    for c in checks:
        outcome = check_one(c, baseline, evolved)
        results.append({**c, "outcome": outcome})
    pred["check_results"] = results

    decided = [r["outcome"] for r in results if r["outcome"] is not None]
    if not decided:
        pred["verified"] = None
    else:
        # Every decidable check must hold. A prediction with an escape hatch
        # isn't falsifiable.
        pred["verified"] = all(decided)
    pred["verified_at"] = now()
    return plan


# ---- calibration tally ----

def calibration_path(store) -> Path:
    return store.evolve_dir / "calibration.json"


def read_calibration(store) -> dict:
    return read_json(calibration_path(store), {"total": 0, "verified": 0, "by_skill": {}})


def record(store, plan: dict) -> dict:
    """Fold a verified plan into the running tally.

    Unverifiable plans are counted separately rather than dropped: a 夜貘 that
    keeps making unfalsifiable predictions is telling you something too.
    """
    cal = read_calibration(store)
    cal.setdefault("unverifiable", 0)
    cal.setdefault("by_skill", {})

    verified = (plan.get("prediction") or {}).get("verified")
    skill = plan.get("skill", "?")
    entry = cal["by_skill"].setdefault(skill, {"total": 0, "verified": 0, "unverifiable": 0})

    if verified is None:
        cal["unverifiable"] += 1
        entry["unverifiable"] += 1
    else:
        cal["total"] += 1
        entry["total"] += 1
        if verified:
            cal["verified"] += 1
            entry["verified"] += 1

    cal["updated_at"] = time.time()
    write_json(calibration_path(store), cal)
    return cal


def accuracy(cal: dict) -> float | None:
    total = cal.get("total", 0)
    if not total:
        return None
    return cal.get("verified", 0) / total


def verify_run(store, run: dict, now=None) -> dict | None:
    """Verify the plan attached to a completed run, if it has one.

    Called when a run finishes, not when it is accepted: the prediction is about
    whether the rewrite *worked*, which is independent of whether the user chose
    to keep it.
    """
    plan_id = run.get("plan_id")
    if not plan_id:
        return None

    from mo_evolve.reflect import get_plan, save_plan

    plan = get_plan(store, plan_id)
    if not plan:
        return None
    if (plan.get("prediction") or {}).get("verified_at"):
        return plan            # already scored; don't double-count

    out_dir = run.get("output_dir")
    metrics = read_json(Path(out_dir) / "metrics.json", {}) if out_dir else {}

    plan = verify_plan(plan, metrics, now=now)
    plan["run_id"] = run.get("id")
    save_plan(store, plan)
    record(store, plan)
    return plan
