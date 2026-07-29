"""Regression lock on the fix for upstream issue #141.

Upstream NousResearch/hermes-agent-self-evolution stores the skill body as a
plain instance attribute and passes it as a DSPy *InputField value*. DSPy
optimizers only mutate a Predict submodule's ``signature.instructions`` and
``demos``, so a plain attribute is never registered as a parameter and
``compile()`` never touches it — the "evolved" SKILL.md comes out byte-identical
to the input. The whole pipeline is a no-op.

Mo's local patch makes the body the signature *instructions*. These tests fail
loudly if a future re-vendor drops that patch.
"""

from __future__ import annotations

import dspy

from evolution.skills.skill_module import (
    SkillModule,
    load_skill,
    reassemble_skill,
    _get_instructions,
)


def test_skill_body_is_the_optimizable_instruction():
    body = "Read the paper. Summarize in three bullets. Never exceed 80 words."
    mod = SkillModule(body)
    assert mod.skill_text == body
    # The body must live where an optimizer will actually find it.
    assert _get_instructions(mod.predictor) == body


def test_skill_text_reads_back_a_mutated_instruction():
    """Simulate what GEPA/MIPROv2 do: swap in a signature with new instructions."""
    mod = SkillModule("ORIGINAL BODY")
    evolved = "EVOLVED BODY — now with an explicit length constraint."

    inner = getattr(mod.predictor, "predict", mod.predictor)
    inner.signature = inner.signature.with_instructions(evolved)

    assert mod.skill_text == evolved, (
        "skill_text did not follow the mutated instructions — upstream #141 has "
        "regressed and evolution is silently a no-op"
    )


def test_predictor_is_a_registered_dspy_parameter():
    """A plain attribute is invisible to compile(); a Predict submodule is not."""
    mod = SkillModule("BODY")
    named = dict(mod.named_predictors())
    assert named, "SkillModule exposes no named predictors — nothing to optimize"
    assert any(_get_instructions(p) == "BODY" for p in named.values())


def test_signature_has_no_skill_instructions_input_field():
    """The upstream shape passed the skill in as an InputField. If that field
    comes back, the body is data again rather than a parameter."""
    fields = SkillModule.TaskWithSkill.model_fields
    assert "skill_instructions" not in fields
    assert "task_input" in fields
    assert "output" in fields


def test_load_reassemble_roundtrip(tmp_path):
    raw = (
        "---\n"
        "name: arxiv\n"
        "description: Search and digest arXiv papers.\n"
        "---\n"
        "\n"
        "# arXiv\n"
        "\n"
        "Step one. Step two.\n"
    )
    p = tmp_path / "SKILL.md"
    p.write_text(raw, encoding="utf-8")

    skill = load_skill(p)
    assert skill["name"] == "arxiv"
    assert skill["description"] == "Search and digest arXiv papers."
    assert skill["body"].startswith("# arXiv")

    rebuilt = reassemble_skill(skill["frontmatter"], skill["body"])
    # Byte-identical is too strong (whitespace is normalized); what must hold is
    # that a second round-trip is a fixed point and the frontmatter survives.
    again = load_skill_text(rebuilt)
    assert again["frontmatter"] == skill["frontmatter"]
    assert again["body"] == skill["body"]
    assert reassemble_skill(again["frontmatter"], again["body"]) == rebuilt


def test_reassemble_preserves_frontmatter_verbatim():
    """The skills *index* in the system prompt is built from frontmatter only
    (see vendor/hermes-agent/agent/system_prompt.py). If evolution could rewrite
    frontmatter it would be editing always-on prompt text. It must not."""
    fm = "name: x\ndescription: A very specific description.\nversion: 3"
    out = reassemble_skill(fm, "totally different body")
    assert f"---\n{fm}\n---" in out


def load_skill_text(raw: str) -> dict:
    """load_skill() operates on a path; this is the same parse over a string."""
    import tempfile
    from pathlib import Path

    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "SKILL.md"
        p.write_text(raw, encoding="utf-8")
        return load_skill(p)
