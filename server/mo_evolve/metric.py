"""Tiered fitness: cheap heuristic first, LLM judge where it actually matters.

The vendored engine ships a fully-written ``LLMJudge`` — three scored
dimensions plus textual feedback — imports it, and then never instantiates it.
Every score the pipeline produces, and every "+0.083 improvement" the UI shows,
comes from ``skill_fitness_metric``::

    score = 0.3 + 0.7 * |expected_words ∩ output_words| / |expected_words|

That is a bag-of-words overlap. It cannot tell a correct answer from one that
merely reuses the rubric's vocabulary, and the "feedback" it hands GEPA is a
formatted float — which throws away the single thing GEPA has over MIPROv2.

**Escalate on failure, not on success.** GEPA's reflective mutation reads
feedback for the candidates it wants to *improve* — the low scorers. Judging a
candidate that already scored 0.9 buys nothing. So:

    heuristic >= judge_escalate_below  →  return it, no LLM call
    otherwise                          →  judge, and hand GEPA real feedback

This puts essentially the whole judge budget on the examples GEPA learns from,
at roughly a third of an always-judge run's cost.

The holdout is a separate matter: ``score_pair`` always judges, because that is
the number the acceptance gate rests on and it must not be a proxy.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, asdict
from pathlib import Path


@dataclass
class MetricStats:
    heuristic_calls: int = 0
    judge_calls: int = 0
    judge_failures: int = 0
    cache_hits: int = 0
    capped: bool = False
    #: Times a *holdout* score fell back to the heuristic. Any value above zero
    #: means the gate's baseline-vs-evolved comparison mixes two scales.
    holdout_fallbacks: int = 0

    @property
    def degraded(self) -> bool:
        """True when the run's scores can't be trusted by the gate.

        Two ways to get here:

        * The judge failed on a large fraction of calls, so the search signal
          is noise.
        * A holdout score fell back to the heuristic. This one matters even at
          n=1: the gate compares baseline against evolved per example, and a
          keyword score on one side of that subtraction manufactures a delta
          out of nothing.
        """
        if self.holdout_fallbacks > 0:
            return True
        attempted = self.judge_calls + self.judge_failures
        if attempted < 3:
            return False  # too few attempts to call it a pattern
        return (self.judge_failures / attempted) > 0.3

    @property
    def degraded_reason(self) -> str:
        """Why the scores can't be trusted — the two causes need different
        wording, or the UI tells the user to check a judge that was fine."""
        if self.holdout_fallbacks > 0:
            return (f"holdout 中有 {self.holdout_fallbacks} 次评审失败并退回启发式打分，"
                    "基线与候选不在同一个尺度上，差值不可信")
        if self.degraded:
            return "评审器故障率过高，本次分数不可信"
        return ""

    def to_dict(self) -> dict:
        d = asdict(self)
        d["degraded"] = self.degraded
        d["degraded_reason"] = self.degraded_reason
        return d


class TieredMetric:
    """A DSPy-compatible metric that escalates from heuristic to LLM judge.

    Callable with GEPA's 5-argument signature; returns a ``dspy.Prediction``
    carrying ``score`` and ``feedback`` so GEPA's reflector gets real prose.
    """

    def __init__(self, config, judge=None, cache_path: Path | None = None,
                 max_metric_calls: int = 0):
        self.config = config
        self.mode = getattr(config, "metric_mode", "tiered")
        self.threshold = getattr(config, "judge_escalate_below", 0.85)
        self.max_size = getattr(config, "max_skill_size", 15_000)

        cap = getattr(config, "judge_max_calls", 0)
        self.judge_max_calls = cap if cap > 0 else max(60, 4 * max(1, max_metric_calls))

        self.cache_path = Path(cache_path) if cache_path else None
        self.use_cache = getattr(config, "judge_cache", True)
        self._cache: dict = {}
        if self.cache_path and self.cache_path.exists():
            try:
                self._cache = json.loads(self.cache_path.read_text(encoding="utf-8"))
            except Exception:
                self._cache = {}

        self.stats = MetricStats()
        self._judge = judge
        self._judge_init_failed = False

    # ---- judge plumbing ----

    @property
    def judge(self):
        """Lazily build the LLMJudge so a heuristic-only run never imports dspy
        machinery it doesn't need, and a judge that can't be constructed
        degrades instead of crashing the run."""
        if self._judge is None and not self._judge_init_failed:
            try:
                from evolution.core.fitness import LLMJudge
                self._judge = LLMJudge(self.config)
            except Exception:
                self._judge_init_failed = True
        return self._judge

    def _cache_key(self, task_input: str, output: str, skill_text: str) -> str:
        h = hashlib.sha256()
        for part in (task_input, output, skill_text):
            h.update((part or "").encode("utf-8"))
            h.update(b"\x00")
        return h.hexdigest()

    def flush_cache(self) -> None:
        if not (self.cache_path and self.use_cache):
            return
        try:
            self.cache_path.parent.mkdir(parents=True, exist_ok=True)
            self.cache_path.write_text(
                json.dumps(self._cache, ensure_ascii=False), encoding="utf-8")
        except Exception:
            pass

    # ---- scoring ----

    def _heuristic(self, gold, pred) -> float:
        from evolution.core.fitness import skill_fitness_metric
        return skill_fitness_metric(gold, pred)

    def _judge_score(self, gold, pred, ignore_cap: bool = False):
        """Returns a FitnessScore, or None if the judge is unavailable/failed.

        ``ignore_cap`` is set for holdout scoring: the cap exists to bound the
        *search*, which makes thousands of calls. The holdout is a handful of
        examples and is the only thing the acceptance gate reads, so capping it
        would trade a few cents for a meaningless verdict.
        """
        judge = self.judge
        if judge is None:
            return None

        task_input = getattr(gold, "task_input", "") or ""
        expected = getattr(gold, "expected_behavior", "") or ""
        output = getattr(pred, "output", "") or ""
        skill_text = getattr(pred, "skill_text", "") or ""

        key = self._cache_key(task_input, output, skill_text)

        # Cache lookup precedes the cap: a hit costs nothing, and refusing it
        # would push an already-judged example onto the heuristic scale.
        if self.use_cache and key in self._cache:
            self.stats.cache_hits += 1
            c = self._cache[key]
            from evolution.core.fitness import FitnessScore
            return FitnessScore(
                correctness=c.get("correctness", 0.0),
                procedure_following=c.get("procedure_following", 0.0),
                conciseness=c.get("conciseness", 0.0),
                length_penalty=c.get("length_penalty", 0.0),
                feedback=c.get("feedback", ""),
            )

        if not ignore_cap and self.stats.judge_calls >= self.judge_max_calls:
            self.stats.capped = True
            return None

        try:
            fs = judge.score(
                task_input=task_input,
                expected_behavior=expected,
                agent_output=output,
                skill_text=skill_text,
                artifact_size=len(skill_text) or None,
                max_size=self.max_size,
            )
        except Exception:
            self.stats.judge_failures += 1
            return None

        self.stats.judge_calls += 1
        if self.use_cache:
            self._cache[key] = {
                "correctness": fs.correctness,
                "procedure_following": fs.procedure_following,
                "conciseness": fs.conciseness,
                "length_penalty": fs.length_penalty,
                "feedback": fs.feedback,
            }
        return fs

    def score_pair(self, gold, pred):
        """Always-judge path, used for the holdout the gate depends on.

        The danger here is subtle and silent. The gate compares a baseline and
        an evolved score for the *same* example; the two scales are not
        interchangeable (a keyword-overlap 1.0 next to a judged 0.9 reads as a
        +0.10 improvement that never happened). So if the judge is unavailable
        for even one score, the fallback is recorded and the whole run is marked
        degraded — the gate then refuses rather than trusting a mixed comparison.
        """
        from evolution.core.fitness import FitnessScore

        if self.mode != "heuristic":
            fs = self._judge_score(gold, pred, ignore_cap=True)
            if fs is not None:
                return fs
            # Judge unavailable on a holdout example: every number from this run
            # is now suspect, not just this one.
            self.stats.holdout_fallbacks += 1

        h = self._heuristic(gold, pred)
        self.stats.heuristic_calls += 1
        return FitnessScore(correctness=h, procedure_following=h, conciseness=h,
                            feedback=f"heuristic score={h:.2f}")

    def __call__(self, gold, pred, trace=None, pred_name=None, pred_trace=None):
        """GEPA-shaped metric: returns Prediction(score=..., feedback=...)."""
        import dspy

        output = (getattr(pred, "output", "") or "").strip()
        if not output:
            return dspy.Prediction(
                score=0.0,
                feedback="Output was empty — the skill must produce a concrete response.",
            )

        heuristic = self._heuristic(gold, pred)
        self.stats.heuristic_calls += 1

        if self.mode == "heuristic":
            return dspy.Prediction(score=heuristic, feedback=self._terse(heuristic, gold))

        # Escalate only when the candidate looks weak — that is where GEPA's
        # reflector will actually read the feedback.
        if self.mode == "tiered" and heuristic >= self.threshold:
            return dspy.Prediction(score=heuristic, feedback=self._terse(heuristic, gold))

        fs = self._judge_score(gold, pred)
        if fs is None:
            return dspy.Prediction(score=heuristic, feedback=self._terse(heuristic, gold))

        return dspy.Prediction(score=fs.composite, feedback=fs.feedback or self._terse(fs.composite, gold))

    @staticmethod
    def _terse(score: float, gold) -> str:
        if score < 0.6:
            exp = getattr(gold, "expected_behavior", "") or ""
            return f"score={score:.2f}. Only partially matched expected behavior: {exp[:200]}"
        return f"score={score:.2f}. Good — matched the expected behavior."


def dimensions_of(scores: list) -> dict:
    """Average each FitnessScore dimension — the per-dimension holdout summary.

    Phase 4 verifies 夜貘's falsifiable predictions against exactly this shape
    ("conciseness up ≥ 0.10, correctness not down more than 0.02").
    """
    if not scores:
        return {}
    n = len(scores)
    return {
        "correctness": sum(s.correctness for s in scores) / n,
        "procedure_following": sum(s.procedure_following for s in scores) / n,
        "conciseness": sum(s.conciseness for s in scores) / n,
        "composite": sum(s.composite for s in scores) / n,
    }
