"""The acceptance gate — the thing standing between a regression and a deploy."""

from __future__ import annotations

import pytest

from mo_evolve.gate import (
    GateVerdict,
    append_pins,
    evaluate_gate,
    paired_bootstrap,
    read_pins,
    MAX_PINS,
)


class Cfg:
    min_holdout = 5
    min_effect = 0.02
    regression_tolerance = 0.02


# ---- paired_bootstrap ----

def test_identical_scores_give_zero_delta_and_a_degenerate_ci():
    xs = [0.5, 0.6, 0.7, 0.4, 0.8]
    delta, lo, hi = paired_bootstrap(xs, xs)
    assert delta == 0.0
    assert lo == 0.0 and hi == 0.0


def test_uniform_improvement_gives_a_ci_strictly_above_zero():
    base = [0.5] * 20
    evo = [0.7] * 20
    delta, lo, hi = paired_bootstrap(base, evo)
    assert delta == pytest.approx(0.2)
    assert lo > 0.0


def test_bootstrap_is_deterministic():
    base = [0.1, 0.5, 0.3, 0.9, 0.2, 0.4]
    evo = [0.4, 0.5, 0.6, 0.7, 0.5, 0.5]
    assert paired_bootstrap(base, evo) == paired_bootstrap(base, evo)


def test_bootstrap_rejects_unpaired_input():
    with pytest.raises(ValueError):
        paired_bootstrap([0.1, 0.2], [0.3])


def test_single_pair_has_an_unbounded_ci():
    delta, lo, hi = paired_bootstrap([0.2], [0.9])
    assert delta == pytest.approx(0.7)
    assert lo == float("-inf") and hi == float("inf")


def test_empty_input():
    assert paired_bootstrap([], []) == (0.0, 0.0, 0.0)


# ---- evaluate_gate ----

def test_no_change_is_rejected():
    xs = [0.5, 0.6, 0.7, 0.4, 0.8]
    v = evaluate_gate(xs, xs, None, Cfg())
    assert not v.passed
    assert "显著性" in v.reason


def test_consistent_improvement_passes():
    v = evaluate_gate([0.5] * 20, [0.7] * 20, None, Cfg())
    assert v.passed, v.reason
    assert v.delta == pytest.approx(0.2)
    assert v.n == 20


def test_too_few_holdout_examples_is_rejected_even_with_a_big_delta():
    v = evaluate_gate([0.2, 0.2], [0.9, 0.9], None, Cfg())
    assert not v.passed
    assert "样本太少" in v.reason


def test_a_single_outlier_widening_the_ci_across_zero_is_rejected():
    """One example carrying the whole gain is not evidence the skill improved."""
    base = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]
    evo = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5 + 0.9]
    v = evaluate_gate(base, evo, None, Cfg())
    assert not v.passed
    assert v.delta > 0, "the mean did rise — that is exactly the trap being caught"
    assert v.ci_low <= Cfg.min_effect


def test_improvement_below_the_minimum_effect_is_rejected():
    base = [0.500] * 30
    evo = [0.505] * 30          # +0.005: real but trivial
    v = evaluate_gate(base, evo, None, Cfg())
    assert not v.passed
    assert "最小效应" in v.reason


def test_regression_is_rejected():
    v = evaluate_gate([0.7] * 10, [0.5] * 10, None, Cfg())
    assert not v.passed


def test_pin_regression_blocks_an_otherwise_passing_run():
    pins = {"n": 3, "regressions": [
        {"task_input": "old task", "baseline": 0.8, "evolved": 0.6, "delta": -0.2},
    ]}
    v = evaluate_gate([0.5] * 20, [0.7] * 20, pins, Cfg())
    assert not v.passed
    assert "钉集" in v.reason
    assert v.pin_regressions


def test_pin_movement_within_tolerance_is_fine():
    pins = {"n": 3, "regressions": [
        {"task_input": "old", "baseline": 0.80, "evolved": 0.79, "delta": -0.01},
    ]}
    v = evaluate_gate([0.5] * 20, [0.7] * 20, pins, Cfg())
    assert v.passed, v.reason


def test_a_degraded_judge_blocks_regardless_of_the_numbers():
    v = evaluate_gate([0.1] * 20, [0.9] * 20, None, Cfg(), degraded=True)
    assert not v.passed
    assert v.degraded
    assert "评审器" in v.reason


def test_degraded_outranks_every_other_failure():
    """The user should be told the scores are junk, not that n was too small."""
    v = evaluate_gate([0.1], [0.9], None, Cfg(), degraded=True)
    assert "评审器" in v.reason


def test_verdict_serializes_for_the_api():
    v = evaluate_gate([0.5] * 20, [0.7] * 20, None, Cfg())
    d = v.to_dict()
    assert set(d) >= {"passed", "reason", "delta", "ci_low", "ci_high", "n"}
    import json
    json.dumps(d)  # must survive the API boundary


# ---- pins ----

def test_pins_roundtrip_and_dedupe(tmp_path):
    ex = [{"task_input": "a", "expected_behavior": "A"},
          {"task_input": "b", "expected_behavior": "B"}]
    assert append_pins(tmp_path, "arxiv", ex) == 2
    assert append_pins(tmp_path, "arxiv", ex) == 2, "same examples must not duplicate"
    assert append_pins(tmp_path, "arxiv", [{"task_input": "c"}]) == 3
    assert {p["task_input"] for p in read_pins(tmp_path, "arxiv")} == {"a", "b", "c"}


def test_pins_are_capped_and_evict_oldest(tmp_path):
    append_pins(tmp_path, "s", [{"task_input": f"t{i}"} for i in range(MAX_PINS + 10)])
    pins = read_pins(tmp_path, "s")
    assert len(pins) == MAX_PINS
    assert pins[-1]["task_input"] == f"t{MAX_PINS + 9}"


def test_pins_survive_a_torn_line(tmp_path):
    append_pins(tmp_path, "s", [{"task_input": "a"}])
    p = tmp_path / "s.jsonl"
    p.write_text(p.read_text() + '{"task_input": "hal\n', encoding="utf-8")
    assert [x["task_input"] for x in read_pins(tmp_path, "s")] == ["a"]


def test_pin_filename_is_sanitized(tmp_path):
    append_pins(tmp_path, "../../etc/passwd", [{"task_input": "a"}])
    assert not (tmp_path.parent.parent / "etc").exists()
    assert list(tmp_path.glob("*.jsonl"))


def test_pins_for_an_unknown_skill_are_empty(tmp_path):
    assert read_pins(tmp_path, "never-seen") == []


def test_examples_without_task_input_are_skipped(tmp_path):
    assert append_pins(tmp_path, "s", [{"expected_behavior": "x"}, {"task_input": "a"}]) == 1


def test_the_degraded_reason_is_specific():
    """A fallback and a high failure rate are different problems; telling the
    user to check a judge that was fine sends them the wrong way."""
    from mo_evolve.metric import MetricStats

    fallback = MetricStats(judge_calls=8, holdout_fallbacks=1)
    v = evaluate_gate([0.5] * 20, [0.7] * 20, None, Cfg(),
                      degraded=True, degraded_reason=fallback.degraded_reason)
    assert not v.passed
    assert "尺度" in v.reason

    broken = MetricStats(judge_calls=2, judge_failures=8)
    v2 = evaluate_gate([0.5] * 20, [0.7] * 20, None, Cfg(),
                       degraded=True, degraded_reason=broken.degraded_reason)
    assert "故障率" in v2.reason


def test_degraded_without_a_reason_still_explains_itself():
    v = evaluate_gate([0.5] * 20, [0.7] * 20, None, Cfg(), degraded=True)
    assert not v.passed and v.reason
