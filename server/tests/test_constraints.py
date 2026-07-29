"""Coverage for ConstraintValidator's two baseline-aware rules.

Both are Mo-adjacent subtleties that a naive re-vendor would flatten:

* ``_check_size`` raises its cap to ``len(baseline) * (1 + max_prompt_growth)``
  so an already-oversized skill isn't rejected for its *existing* size — growth
  is bounded separately, and without this the two constraints contradict each
  other and nothing ever passes.
* ``_check_growth`` lets a small skill grow to an absolute grace size, because
  +20% of a 1.9KB skill is ~385 chars — far too little for GEPA to restructure
  anything.
"""

from __future__ import annotations

import pytest

from evolution.core.config import EvolutionConfig
from evolution.core.constraints import ConstraintValidator


def _cfg(tmp_path, **kw) -> EvolutionConfig:
    return EvolutionConfig(hermes_agent_path=tmp_path, **kw)


def _by_name(results) -> dict:
    return {r.constraint_name: r for r in results}


def _skill(body: str, name: str = "x", description: str = "d") -> str:
    return f"---\nname: {name}\ndescription: {description}\n---\n\n{body}\n"


# ---- size ----

def test_oversized_baseline_is_not_rejected_for_its_existing_size(tmp_path):
    cfg = _cfg(tmp_path, max_skill_size=15_000, max_prompt_growth=0.2)
    v = ConstraintValidator(cfg)
    baseline = _skill("x" * 20_000)          # already over the 15KB cap
    evolved = _skill("x" * 20_500)           # +2.5%, well within growth

    res = _by_name(v.validate_all(evolved, "skill", baseline_text=baseline))
    assert res["size_limit"].passed, res["size_limit"].message
    assert res["growth_limit"].passed, res["growth_limit"].message


def test_size_limit_applies_when_no_baseline_given(tmp_path):
    cfg = _cfg(tmp_path, max_skill_size=1_000)
    v = ConstraintValidator(cfg)
    res = _by_name(v.validate_all(_skill("x" * 5_000), "skill"))
    assert not res["size_limit"].passed


def test_growth_cannot_push_past_the_baseline_aware_ceiling(tmp_path):
    """The raised cap is baseline + growth margin, not unlimited."""
    cfg = _cfg(tmp_path, max_skill_size=15_000, max_prompt_growth=0.2)
    v = ConstraintValidator(cfg)
    baseline = _skill("x" * 20_000)
    evolved = _skill("x" * 30_000)           # +50%

    res = _by_name(v.validate_all(evolved, "skill", baseline_text=baseline))
    assert not res["size_limit"].passed
    assert not res["growth_limit"].passed


# ---- growth / grace ----

def test_small_skill_may_grow_to_the_grace_size(tmp_path):
    cfg = _cfg(tmp_path, max_skill_size=15_000, max_prompt_growth=0.2,
               small_skill_grace_size=8_000)
    v = ConstraintValidator(cfg)
    baseline = _skill("x" * 1_900)           # +20% would be only ~+380 chars
    evolved = _skill("x" * 7_000)            # way over percentage, under grace

    res = _by_name(v.validate_all(evolved, "skill", baseline_text=baseline))
    assert res["growth_limit"].passed, res["growth_limit"].message
    assert "grace" in res["growth_limit"].message


def test_grace_never_exceeds_the_absolute_cap(tmp_path):
    """Grace relaxes the *percentage*; the absolute size_limit still bites."""
    cfg = _cfg(tmp_path, max_skill_size=5_000, max_prompt_growth=0.2,
               small_skill_grace_size=8_000)
    v = ConstraintValidator(cfg)
    baseline = _skill("x" * 1_000)
    evolved = _skill("x" * 7_500)            # under grace, over max_skill_size

    res = _by_name(v.validate_all(evolved, "skill", baseline_text=baseline))
    assert res["growth_limit"].passed
    assert not res["size_limit"].passed, (
        "grace must not become an escape hatch around the absolute cap"
    )


def test_grace_does_not_apply_to_non_skill_artifacts(tmp_path):
    cfg = _cfg(tmp_path, max_prompt_growth=0.2, small_skill_grace_size=8_000)
    v = ConstraintValidator(cfg)
    res = _by_name(v.validate_all("y" * 400, "tool_description", baseline_text="y" * 100))
    assert not res["growth_limit"].passed


# ---- structure ----

def test_structure_requires_frontmatter_name_and_description(tmp_path):
    v = ConstraintValidator(_cfg(tmp_path))
    ok = _by_name(v.validate_all(_skill("body"), "skill"))["skill_structure"]
    assert ok.passed

    no_desc = "---\nname: x\n---\n\nbody\n"
    bad = _by_name(v.validate_all(no_desc, "skill"))["skill_structure"]
    assert not bad.passed
    assert "description" in bad.message


def test_structure_fails_on_a_bare_body(tmp_path):
    """Guards the second Mo patch: validate the *reassembled* skill, not the
    bare body. The body alone never has YAML, so validating it made the
    structure check fail 100% of the time and nothing could ever deploy."""
    v = ConstraintValidator(_cfg(tmp_path))
    res = _by_name(v.validate_all("# Just a heading\n\nSome prose.", "skill"))
    assert not res["skill_structure"].passed


def test_non_empty(tmp_path):
    v = ConstraintValidator(_cfg(tmp_path))
    assert not _by_name(v.validate_all("   \n  ", "skill"))["non_empty"].passed
    assert _by_name(v.validate_all(_skill("b"), "skill"))["non_empty"].passed


def test_growth_check_absent_without_baseline(tmp_path):
    v = ConstraintValidator(_cfg(tmp_path))
    assert "growth_limit" not in _by_name(v.validate_all(_skill("b"), "skill"))
