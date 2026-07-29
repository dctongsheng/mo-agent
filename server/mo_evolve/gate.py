"""The acceptance gate: does this candidate deserve to be deployed?

Before this module, the answer was ``improvement > 0`` — computed on a
bag-of-words proxy, printed to a log, and enforced nowhere. A candidate that
regressed on holdout could be deployed with one click.

Three things decide it now:

1. **A paired bootstrap CI on the holdout deltas.** Paired, because the pipeline
   already scores baseline and evolved on the *same* holdout examples; at n≈5-10
   a paired test has far more power than an unpaired one. The CI lower bound
   must clear a minimum effect, not merely zero — "it went up a bit" is what a
   greedy optimizer says right before it p-hacks itself.
2. **A regression pin set.** Every accepted run donates its holdout examples to
   a per-skill pin file. Future candidates are checked against the accumulated
   pins and may not regress on them. This is the "benchmarks are gates, not
   fitness functions" rule, implemented with no external benchmark: a rewrite
   that improves this week's rubric while breaking last month's is rejected.
3. **Judge health.** If the LLM judge failed on more than a third of its calls,
   the scores are noise and the gate refuses regardless of the numbers.

Nothing here auto-deploys. The gate decides whether the accept button is armed
or requires an explicit force-confirm; a human still presses it.
"""

from __future__ import annotations

import json
import random
from dataclasses import dataclass, field, asdict
from pathlib import Path

# Keep the pin set bounded: it is re-evaluated on every run, so an unbounded
# file would make each nightly run slower and pricier than the last.
MAX_PINS = 50


@dataclass
class GateVerdict:
    passed: bool
    reason: str
    delta: float = 0.0
    ci_low: float = 0.0
    ci_high: float = 0.0
    n: int = 0
    pin_regressions: list = field(default_factory=list)
    degraded: bool = False

    def to_dict(self) -> dict:
        return asdict(self)


def paired_bootstrap(
    base: list[float],
    evo: list[float],
    n_boot: int = 5000,
    seed: int = 0,
    alpha: float = 0.05,
) -> tuple[float, float, float]:
    """Bootstrap CI for the mean paired difference ``evo - base``.

    Returns ``(mean_delta, ci_low, ci_high)``. Resampling is over *pairs*, which
    is what makes this paired: the correlation between a baseline and evolved
    score on the same example is preserved rather than averaged away.

    Deterministic by default (fixed seed) so a verdict is reproducible from the
    stored scores — a user disputing a rejection can recompute it exactly.
    """
    if len(base) != len(evo):
        raise ValueError(f"unpaired inputs: {len(base)} baseline vs {len(evo)} evolved")
    n = len(base)
    if n == 0:
        return 0.0, 0.0, 0.0

    diffs = [e - b for b, e in zip(base, evo)]
    mean = sum(diffs) / n

    if n == 1:
        # A single pair carries no information about variance. Report the point
        # estimate with an infinitely wide CI so the min-n check is what speaks.
        return mean, float("-inf"), float("inf")

    rng = random.Random(seed)
    means = []
    for _ in range(n_boot):
        s = 0.0
        for _ in range(n):
            s += diffs[rng.randrange(n)]
        means.append(s / n)
    means.sort()

    lo_i = int((alpha / 2) * n_boot)
    hi_i = min(n_boot - 1, int((1 - alpha / 2) * n_boot))
    return mean, means[lo_i], means[hi_i]


def evaluate_gate(
    base_scores: list[float],
    evo_scores: list[float],
    pin_result: dict | None,
    config,
    degraded: bool = False,
    degraded_reason: str = "",
) -> GateVerdict:
    """Decide whether a candidate may be deployed without a force-confirm.

    ``pin_result`` is ``{"regressions": [{"example": ..., "baseline": float,
    "evolved": float, "delta": float}], "n": int}`` or None when the skill has
    no pins yet (first accepted run).
    """
    min_holdout = getattr(config, "min_holdout", 5)
    min_effect = getattr(config, "min_effect", 0.02)
    tolerance = getattr(config, "regression_tolerance", 0.02)

    n = len(base_scores)
    delta, ci_low, ci_high = paired_bootstrap(base_scores, evo_scores)

    regressions = list((pin_result or {}).get("regressions", []))
    bad_pins = [r for r in regressions if r.get("delta", 0.0) < -tolerance]

    # Order matters: report the most fundamental problem first, so the UI
    # message tells the user what to actually fix.
    if degraded:
        return GateVerdict(
            passed=False,
            reason=degraded_reason or "评审器异常，本次分数不可信",
            delta=delta, ci_low=ci_low, ci_high=ci_high, n=n,
            pin_regressions=bad_pins, degraded=True,
        )

    if n < min_holdout:
        return GateVerdict(
            passed=False,
            reason=f"holdout 样本太少（{n} < {min_holdout}），无法判断是否真的改进",
            delta=delta, ci_low=ci_low, ci_high=ci_high, n=n,
            pin_regressions=bad_pins,
        )

    if bad_pins:
        worst = min(r["delta"] for r in bad_pins)
        return GateVerdict(
            passed=False,
            reason=f"在 {len(bad_pins)} 条历史钉集样本上回归（最差 {worst:+.3f}，容忍 {-tolerance:+.3f}）",
            delta=delta, ci_low=ci_low, ci_high=ci_high, n=n,
            pin_regressions=bad_pins,
        )

    if ci_low <= min_effect:
        return GateVerdict(
            passed=False,
            reason=(f"未达显著性门槛：Δ {delta:+.3f}，95% CI 下界 {ci_low:+.3f} "
                    f"未超过最小效应 {min_effect:+.3f}"),
            delta=delta, ci_low=ci_low, ci_high=ci_high, n=n,
            pin_regressions=bad_pins,
        )

    return GateVerdict(
        passed=True,
        reason=f"统计上确有改进：Δ {delta:+.3f}，95% CI [{ci_low:+.3f}, {ci_high:+.3f}]，n={n}",
        delta=delta, ci_low=ci_low, ci_high=ci_high, n=n,
        pin_regressions=bad_pins,
    )


# ---- pin set persistence ----

def pins_path(pins_dir: Path, skill: str) -> Path:
    return Path(pins_dir) / f"{_safe(skill)}.jsonl"


def read_pins(pins_dir: Path, skill: str) -> list[dict]:
    p = pins_path(pins_dir, skill)
    if not p.exists():
        return []
    out = []
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except Exception:
            continue  # a torn line must not sink the whole gate
    return out


def append_pins(pins_dir: Path, skill: str, examples: list[dict]) -> int:
    """Add this run's holdout examples to the skill's regression ratchet.

    Deduplicates on ``task_input`` and keeps the newest ``MAX_PINS``. Returns
    the resulting pin count.
    """
    existing = read_pins(pins_dir, skill)
    seen = {e.get("task_input") for e in existing}
    for ex in examples:
        ti = ex.get("task_input")
        if not ti or ti in seen:
            continue
        seen.add(ti)
        existing.append({
            "task_input": ti,
            "expected_behavior": ex.get("expected_behavior", ""),
            "added_at": ex.get("added_at"),
        })
    if len(existing) > MAX_PINS:
        existing = existing[-MAX_PINS:]  # evict oldest

    p = pins_path(pins_dir, skill)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(
        "".join(json.dumps(e, ensure_ascii=False) + "\n" for e in existing),
        encoding="utf-8",
    )
    return len(existing)


def _safe(name: str) -> str:
    """Skill names come from user-authored frontmatter — keep them in-directory."""
    return "".join(c if (c.isalnum() or c in "-_.") else "_" for c in name).strip("._") or "skill"
