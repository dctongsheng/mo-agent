"""The cross-model critic — mostly a test that it refuses to rubber-stamp."""

from __future__ import annotations

import json

import pytest

from mo_evolve.critic import Critique, critique

BASE = "Summarize the paper."
EVO = "Summarize the paper in exactly three bullets, never exceeding 80 words."
DIFF = "--- baseline\n+++ evolved\n-Summarize the paper.\n+Summarize the paper in three bullets.\n"


class _FakeCoT:
    """Replays one canned critic response."""
    payload = "{}"
    raises = None

    def __init__(self, *a, **kw):
        pass

    def __call__(self, **kw):
        if type(self).raises:
            raise type(self).raises
        class R:
            verdict = type(self).payload
        return R()


@pytest.fixture
def fake_lm(monkeypatch):
    import dspy
    import contextlib
    monkeypatch.setattr(dspy, "LM", lambda *a, **kw: object())
    monkeypatch.setattr(dspy, "context", lambda **kw: contextlib.nullcontext())
    monkeypatch.setattr(dspy, "ChainOfThought", _FakeCoT)
    _FakeCoT.payload = "{}"
    _FakeCoT.raises = None
    return _FakeCoT


def _run(critic_model="openai/critic", optimizer_model="openai/author"):
    return critique(DIFF, BASE, EVO, "缺少长度约束", critic_model, optimizer_model)


# ---- anti-collusion: the reason this exists ----

def test_the_same_model_on_both_sides_is_refused(fake_lm):
    """The same weights have the same blind spots — a critique from the author
    is a rubber stamp, and a rubber stamp is worse than nothing because it
    looks like review."""
    fake_lm.payload = json.dumps({"verdict": "reject", "risks": [], "rationale": "bad"})

    c = _run(critic_model="openai/same", optimizer_model="openai/same")

    assert c.collusion is True
    assert c.skipped
    assert c.verdict == "accept", "must not pass off a same-model verdict as review"
    assert not c.downgrades


def test_no_critic_model_configured_is_a_clean_skip(fake_lm):
    c = _run(critic_model="")
    assert c.skipped and not c.downgrades


# ---- verdicts ----

def test_a_reject_downgrades_the_run(fake_lm):
    fake_lm.payload = json.dumps({
        "verdict": "reject",
        "risks": ["丢掉了原本对引用格式的要求"],
        "rationale": "更长但没有解决假设里的问题",
    })
    c = _run()
    assert c.verdict == "reject"
    assert c.downgrades, "accepting this should need the same confirm as a failed gate"
    assert c.risks == ["丢掉了原本对引用格式的要求"]


def test_an_accept_does_not_downgrade(fake_lm):
    fake_lm.payload = json.dumps({"verdict": "accept", "risks": [], "rationale": "ok"})
    c = _run()
    assert c.verdict == "accept" and not c.downgrades


def test_revise_is_advisory_only(fake_lm):
    fake_lm.payload = json.dumps({"verdict": "revise", "risks": [], "rationale": "close"})
    c = _run()
    assert c.verdict == "revise" and not c.downgrades


def test_an_unknown_verdict_falls_back_to_accept(fake_lm):
    """An opinion the parser can't read must not silently block a good run."""
    fake_lm.payload = json.dumps({"verdict": "maybe?", "risks": [], "rationale": ""})
    assert _run().verdict == "accept"


# ---- robustness: a critique is advisory, so it must never fail a run ----

def test_a_raising_critic_degrades_cleanly(fake_lm):
    fake_lm.raises = RuntimeError("502 from the gateway")
    c = _run()
    assert c.verdict == "accept" and c.skipped and not c.downgrades


def test_unparseable_output_degrades_cleanly(fake_lm):
    fake_lm.payload = "I have thoughts but no JSON."
    c = _run()
    assert c.verdict == "accept" and c.skipped


def test_fenced_json_is_salvaged(fake_lm):
    fake_lm.payload = '```json\n{"verdict": "reject", "risks": [], "rationale": "no"}\n```'
    assert _run().verdict == "reject"


def test_a_string_risks_field_is_normalized(fake_lm):
    fake_lm.payload = json.dumps({"verdict": "revise", "risks": "just the one", "rationale": ""})
    assert _run().risks == ["just the one"]


def test_risks_are_capped_and_truncated(fake_lm):
    fake_lm.payload = json.dumps({"verdict": "revise", "risks": ["x" * 500] * 20, "rationale": ""})
    c = _run()
    assert len(c.risks) == 6
    assert len(c.risks[0]) == 300


def test_long_inputs_are_truncated_not_rejected(fake_lm):
    fake_lm.payload = json.dumps({"verdict": "accept", "risks": [], "rationale": "ok"})
    c = critique("d" * 50_000, "b" * 50_000, "e" * 50_000, "h",
                 "openai/critic", "openai/author")
    assert c.verdict == "accept"


# ---- serialization ----

def test_critique_serializes_for_the_api(fake_lm):
    fake_lm.payload = json.dumps({"verdict": "reject", "risks": ["r"], "rationale": "why"})
    d = _run().to_dict()
    json.dumps(d)
    assert d["downgrades"] is True
    assert set(d) >= {"verdict", "rationale", "risks", "model", "collusion", "skipped"}


def test_a_skipped_critique_never_downgrades():
    c = Critique("reject", "", [], skipped="whatever went wrong")
    assert not c.downgrades
