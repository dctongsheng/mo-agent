"""Tiered metric — is the LLM judge consulted exactly where it earns its cost?

The failure this suite guards against is subtle and expensive in both
directions: judge everything and a nightly loop burns real money; judge nothing
(today's behaviour) and every score in the product is a bag-of-words proxy
wearing an "LLM-as-judge" label.
"""

from __future__ import annotations

import pytest

from mo_evolve.metric import MetricStats, TieredMetric, dimensions_of


class Cfg:
    metric_mode = "tiered"
    judge_escalate_below = 0.85
    judge_max_calls = 0
    judge_cache = True
    max_skill_size = 15_000
    eval_model = "openai/small"
    optimizer_model = "openai/big"


def _metric(judge=None, tmp_path=None, **over):
    cfg = Cfg()
    for k, v in over.items():
        setattr(cfg, k, v)
    return TieredMetric(cfg, judge=judge,
                        cache_path=(tmp_path / "judge_cache.json") if tmp_path else None,
                        max_metric_calls=20)


# ---- escalation ----

def test_high_heuristic_score_does_not_call_the_judge(fake_judge, gold, pred):
    j = fake_judge()
    m = _metric(judge=j)
    # Output reproduces the rubric exactly → heuristic 1.0.
    out = m(gold(expected_behavior="alpha beta"), pred(output="alpha beta"))
    assert out.score == pytest.approx(1.0)
    assert j.call_count == 0, "judging a winner buys nothing and costs a call"


def test_low_heuristic_score_escalates_to_the_judge(fake_judge, gold, pred):
    j = fake_judge(score=0.42, feedback="the procedure was skipped entirely")
    m = _metric(judge=j)
    out = m(gold(expected_behavior="alpha beta gamma delta"), pred(output="zzz"))
    assert j.call_count == 1
    assert out.score == pytest.approx(0.42)
    assert out.feedback == "the procedure was skipped entirely", (
        "GEPA's reflector must receive the judge's prose, not a formatted float"
    )


def test_judge_receives_the_candidate_skill_text(fake_judge, gold, pred):
    """Guards the skill_module.py patch: without skill_text on the prediction
    the judge cannot score procedure-following at all."""
    j = fake_judge(score=0.3)
    m = _metric(judge=j)
    m(gold(), pred(output="zzz", skill_text="THE EVOLVED BODY"))
    assert j.calls[0]["skill_text"] == "THE EVOLVED BODY"
    assert j.calls[0]["max_size"] == 15_000
    assert j.calls[0]["artifact_size"] == len("THE EVOLVED BODY")


def test_empty_output_short_circuits_to_zero(fake_judge, gold, pred):
    j = fake_judge()
    m = _metric(judge=j)
    out = m(gold(), pred(output="   "))
    assert out.score == 0.0
    assert j.call_count == 0
    assert "empty" in out.feedback.lower()


def test_heuristic_mode_never_judges(fake_judge, gold, pred):
    j = fake_judge()
    m = _metric(judge=j, metric_mode="heuristic")
    m(gold(), pred(output="zzz"))
    assert j.call_count == 0


def test_judge_mode_always_judges(fake_judge, gold, pred):
    j = fake_judge(score=0.7)
    m = _metric(judge=j, metric_mode="judge")
    out = m(gold(expected_behavior="alpha"), pred(output="alpha"))
    assert j.call_count == 1
    assert out.score == pytest.approx(0.7)


# ---- cache ----

def test_identical_calls_hit_the_cache(fake_judge, gold, pred, tmp_path):
    j = fake_judge(score=0.3)
    m = _metric(judge=j, tmp_path=tmp_path)
    g, p = gold(), pred(output="zzz")
    m(g, p)
    m(g, p)
    assert j.call_count == 1, "GEPA re-evaluates the same candidate repeatedly"
    assert m.stats.cache_hits == 1


def test_a_different_skill_text_is_a_different_cache_entry(fake_judge, gold, pred):
    j = fake_judge(score=0.3)
    m = _metric(judge=j)
    m(gold(), pred(output="zzz", skill_text="BODY A"))
    m(gold(), pred(output="zzz", skill_text="BODY B"))
    assert j.call_count == 2


def test_cache_persists_across_instances(fake_judge, gold, pred, tmp_path):
    j1 = fake_judge(score=0.3)
    m1 = _metric(judge=j1, tmp_path=tmp_path)
    m1(gold(), pred(output="zzz"))
    m1.flush_cache()

    j2 = fake_judge(score=0.9)   # would give a different answer if consulted
    m2 = _metric(judge=j2, tmp_path=tmp_path)
    out = m2(gold(), pred(output="zzz"))
    assert j2.call_count == 0
    assert out.score == pytest.approx(0.3)


def test_cache_can_be_disabled(fake_judge, gold, pred, tmp_path):
    j = fake_judge(score=0.3)
    m = _metric(judge=j, tmp_path=tmp_path, judge_cache=False)
    g, p = gold(), pred(output="zzz")
    m(g, p)
    m(g, p)
    assert j.call_count == 2


# ---- failure containment ----

def test_a_raising_judge_falls_back_to_the_heuristic(fake_judge, gold, pred):
    j = fake_judge(raises=RuntimeError("502 from the gateway"))
    m = _metric(judge=j)
    out = m(gold(expected_behavior="alpha beta"), pred(output="alpha"))
    assert m.stats.judge_failures == 1
    assert m.stats.judge_calls == 0
    assert 0.0 <= out.score <= 1.0, "the run continues on the proxy score"


def test_a_mostly_broken_judge_marks_the_run_degraded(fake_judge, gold, pred):
    j = fake_judge(raises=RuntimeError("down"))
    m = _metric(judge=j)
    for i in range(5):
        m(gold(), pred(output=f"zzz{i}"))
    assert m.stats.judge_failures == 5
    assert m.stats.degraded, "the gate must refuse a run scored by a broken judge"


def test_one_flake_does_not_mark_the_run_degraded():
    s = MetricStats(judge_calls=20, judge_failures=1)
    assert not s.degraded


def test_too_few_attempts_is_not_a_pattern():
    assert not MetricStats(judge_calls=0, judge_failures=2).degraded


def test_missing_judge_degrades_instead_of_crashing(gold, pred):
    m = _metric(judge=None)
    m._judge_init_failed = True          # simulate an unconstructable judge
    out = m(gold(), pred(output="zzz"))
    assert 0.0 <= out.score <= 1.0


# ---- cap ----

def test_the_judge_call_cap_is_enforced(fake_judge, gold, pred):
    j = fake_judge(score=0.3)
    m = _metric(judge=j, judge_max_calls=2)
    for i in range(6):
        m(gold(), pred(output=f"zzz{i}"))
    assert j.call_count == 2
    assert m.stats.capped


def test_cap_defaults_to_a_multiple_of_the_metric_budget():
    m = TieredMetric(Cfg(), judge=None, max_metric_calls=100)
    assert m.judge_max_calls == 400


# ---- holdout path ----

def test_score_pair_always_judges_even_on_a_perfect_heuristic(fake_judge, gold, pred):
    """The holdout is what the acceptance gate rests on — it must not be a proxy."""
    j = fake_judge(score=0.55)
    m = _metric(judge=j)
    fs = m.score_pair(gold(expected_behavior="alpha"), pred(output="alpha"))
    assert j.call_count == 1
    assert fs.composite == pytest.approx(0.55)


def test_score_pair_falls_back_when_the_judge_is_down(fake_judge, gold, pred):
    j = fake_judge(raises=RuntimeError("down"))
    m = _metric(judge=j)
    fs = m.score_pair(gold(expected_behavior="alpha beta"), pred(output="alpha"))
    assert 0.0 <= fs.composite <= 1.0
    assert m.stats.judge_failures == 1


def test_score_pair_in_heuristic_mode_skips_the_judge(fake_judge, gold, pred):
    j = fake_judge()
    m = _metric(judge=j, metric_mode="heuristic")
    m.score_pair(gold(), pred(output="alpha"))
    assert j.call_count == 0


# ---- reporting ----

def test_stats_serialize_with_the_degraded_flag():
    d = MetricStats(judge_calls=10, judge_failures=6).to_dict()
    assert d["degraded"] is True
    import json
    json.dumps(d)


def test_dimensions_of_averages_each_axis():
    from evolution.core.fitness import FitnessScore
    scores = [
        FitnessScore(correctness=0.6, procedure_following=0.4, conciseness=0.8),
        FitnessScore(correctness=0.8, procedure_following=0.6, conciseness=0.6),
    ]
    d = dimensions_of(scores)
    assert d["correctness"] == pytest.approx(0.7)
    assert d["procedure_following"] == pytest.approx(0.5)
    assert d["conciseness"] == pytest.approx(0.7)
    assert "composite" in d


def test_dimensions_of_empty():
    assert dimensions_of([]) == {}


# ---- regressions: the holdout must never mix scales ----

def test_a_holdout_fallback_marks_the_run_degraded(fake_judge, gold, pred):
    """The gate subtracts baseline from evolved per example. A keyword score on
    one side of that subtraction manufactures a delta out of nothing — measured
    at +0.10 between a judged 0.9 and a heuristic 1.0 on identical text."""
    j = fake_judge(raises=RuntimeError("judge down"))
    m = _metric(judge=j)
    m.score_pair(gold(expected_behavior="alpha"), pred(output="alpha"))
    assert m.stats.holdout_fallbacks == 1
    assert m.stats.degraded, "one mixed holdout pair is enough to void the verdict"


def test_a_clean_holdout_is_not_degraded(fake_judge, gold, pred):
    m = _metric(judge=fake_judge(score=0.7))
    for i in range(4):
        m.score_pair(gold(), pred(output=f"out{i}"))
    assert m.stats.holdout_fallbacks == 0
    assert not m.stats.degraded


def test_the_search_cap_does_not_starve_the_holdout(fake_judge, gold, pred):
    """The cap bounds the search, which makes thousands of calls. The holdout is
    a handful of examples and is the only thing the gate reads — capping it
    would trade a few cents for a meaningless verdict."""
    j = fake_judge(score=0.55)
    m = _metric(judge=j, judge_max_calls=2)
    for i in range(4):
        m(gold(), pred(output=f"search{i}"))       # exhausts the cap
    assert m.stats.capped

    for i in range(4):
        fs = m.score_pair(gold(), pred(output=f"holdout{i}"))
        assert fs.composite == pytest.approx(0.55), "holdout still judged"
    assert m.stats.holdout_fallbacks == 0
    assert not m.stats.degraded


def test_a_cached_score_is_returned_even_past_the_cap(fake_judge, gold, pred):
    """Refusing a cache hit costs nothing and would push an already-judged
    example onto the heuristic scale."""
    j = fake_judge(score=0.4)
    m = _metric(judge=j, judge_max_calls=1)
    g, p = gold(), pred(output="zzz")
    first = m(g, p)
    assert j.call_count == 1

    m(gold(), pred(output="other"))                # hits the cap
    assert m.stats.capped

    again = m(g, p)
    assert again.score == pytest.approx(first.score)
    assert m.stats.cache_hits == 1
