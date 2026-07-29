"""夜貘's plan parser — the gate between an LLM's prose and a real run."""

from __future__ import annotations

import json

import pytest

from mo_evolve.reflect import (
    DEFAULT_CONSTITUTION,
    describe_prior_runs,
    describe_skills,
    describe_trajectories,
    get_plan,
    list_plans,
    parse_plan,
    read_constitution,
    save_plan,
    _salvage_json,
)

ALLOWED = ["arxiv-digest", "code-review"]


def _plan(**over) -> str:
    d = {
        "skill": "arxiv-digest",
        "why": "过去 7 天有 4 条负标记轨迹落在这条技艺上",
        "hypothesis": "SKILL.md 缺少输出长度的硬约束",
        "prediction": {
            "statement": "conciseness 会明显上升,correctness 基本不变",
            "checks": [
                {"dimension": "conciseness", "direction": "up", "threshold": 0.10},
                {"dimension": "correctness", "direction": "not_down", "threshold": 0.02},
            ],
        },
        "eval_source": "mixed",
        "iterations": 6,
    }
    d.update(over)
    return json.dumps(d, ensure_ascii=False)


# ---- happy path ----

def test_a_well_formed_plan_parses():
    p = parse_plan(_plan(), ALLOWED)
    assert p["skill"] == "arxiv-digest"
    assert p["iterations"] == 6
    assert p["eval_source"] == "mixed"
    assert len(p["prediction"]["checks"]) == 2
    assert p["prediction"]["verified"] is None


def test_fenced_json_is_salvaged():
    raw = "Sure, here's my plan:\n```json\n" + _plan() + "\n```\nHope that helps!"
    assert parse_plan(raw, ALLOWED)["skill"] == "arxiv-digest"


def test_bare_braces_in_prose_are_salvaged():
    assert parse_plan("我想了想。" + _plan(), ALLOWED) is not None


# ---- abstention ----

def test_abstention_returns_none():
    """Abstaining is a valid answer — better than inventing a target."""
    raw = json.dumps({"abstain": True, "why": "没有任何标记过的轨迹"})
    assert parse_plan(raw, ALLOWED) is None


def test_unparseable_output_returns_none():
    assert parse_plan("I don't feel like producing JSON today.", ALLOWED) is None
    assert parse_plan("", ALLOWED) is None


# ---- validation ----

def test_a_hallucinated_skill_is_rejected():
    """The model must choose from what exists, or the run fails at find_skill."""
    assert parse_plan(_plan(skill="a-skill-that-does-not-exist"), ALLOWED) is None


def test_a_choice_without_a_reason_is_rejected():
    """A pick with no rationale is round-robin with extra API cost."""
    assert parse_plan(_plan(why=""), ALLOWED) is None


def test_iterations_are_clamped():
    assert parse_plan(_plan(iterations=999), ALLOWED)["iterations"] == 20
    assert parse_plan(_plan(iterations=0), ALLOWED)["iterations"] == 1
    assert parse_plan(_plan(iterations="not a number"), ALLOWED)["iterations"] == 4


def test_an_unknown_eval_source_falls_back():
    assert parse_plan(_plan(eval_source="telepathy"), ALLOWED)["eval_source"] == "mixed"


def test_invalid_checks_are_dropped_not_fatal():
    p = parse_plan(_plan(prediction={"statement": "s", "checks": [
        {"dimension": "vibes", "direction": "up", "threshold": 0.1},        # bad dim
        {"dimension": "correctness", "direction": "sideways"},              # bad direction
        "not even a dict",
        {"dimension": "conciseness", "direction": "up", "threshold": 0.1},  # good
    ]}), ALLOWED)
    assert [c["dimension"] for c in p["prediction"]["checks"]] == ["conciseness"]


def test_a_plan_with_no_valid_checks_still_parses():
    """It runs; it just can't earn calibration credit. verify_plan scores it
    unverifiable rather than correct."""
    p = parse_plan(_plan(prediction={"statement": "会变好", "checks": []}), ALLOWED)
    assert p is not None and p["prediction"]["checks"] == []


def test_a_negative_threshold_is_normalized():
    p = parse_plan(_plan(prediction={"statement": "s", "checks": [
        {"dimension": "conciseness", "direction": "up", "threshold": -0.2}]}), ALLOWED)
    assert p["prediction"]["checks"][0]["threshold"] == pytest.approx(0.2)


def test_long_fields_are_truncated():
    p = parse_plan(_plan(why="x" * 5000, hypothesis="y" * 5000), ALLOWED)
    assert len(p["why"]) == 1000 and len(p["hypothesis"]) == 1000


def test_a_non_object_payload_is_rejected():
    assert parse_plan(json.dumps(["arxiv-digest"]), ALLOWED) is None


# ---- salvage ----

def test_salvage_handles_the_usual_llm_wrappers():
    assert _salvage_json('{"a": 1}') == {"a": 1}
    assert _salvage_json('```json\n{"a": 1}\n```') == {"a": 1}
    assert _salvage_json('here you go: {"a": 1} ok?') == {"a": 1}
    assert _salvage_json("no json here") is None
    assert _salvage_json("") is None


# ---- constitution ----

def test_a_missing_soul_falls_back_to_the_default(tmp_path):
    assert read_constitution(tmp_path / "nope.md") == DEFAULT_CONSTITUTION


def test_an_empty_soul_falls_back(tmp_path):
    p = tmp_path / "SOUL.md"
    p.write_text("   \n\n", encoding="utf-8")
    assert read_constitution(p) == DEFAULT_CONSTITUTION


def test_a_user_edited_soul_is_actually_used(tmp_path):
    """The whole point of making SOUL.md load-bearing: editing it changes
    behaviour, rather than being decoration written once and never read."""
    p = tmp_path / "SOUL.md"
    p.write_text("# 夜貘\n\n只打磨用得最多的技艺。", encoding="utf-8")
    assert "用得最多" in read_constitution(p)


# ---- input assembly ----

def test_describe_skills_excludes_builtins_and_returns_choices(store, make_skill):
    make_skill("mine")
    make_skill("arxiv")
    (store.skills_dir / ".bundled_manifest").write_text("arxiv: x\n", encoding="utf-8")
    desc, names = describe_skills(store)
    assert names == ["mine"]
    assert "mine" in desc and "arxiv" not in desc


def test_describe_skills_on_an_empty_install(store):
    desc, names = describe_skills(store)
    assert names == []
    assert "没有自定义技艺" in desc


def test_describe_trajectories_selects_by_label(tmp_hermes_home):
    f = tmp_hermes_home / "trajectories" / "trajectories.jsonl"
    f.write_text("\n".join(json.dumps(e) for e in [
        {"id": "a", "label": "neg", "turns_log": [{"prompt": "the bad one here", "reply": "oops"}]},
        {"id": "b", "label": "pos", "turns_log": [{"prompt": "the good one here", "reply": "nice"}]},
    ]) + "\n", encoding="utf-8")

    assert "the bad one" in describe_trajectories(f, "neg")
    assert "the good one" not in describe_trajectories(f, "neg")
    assert describe_trajectories(f, "neg", limit=0) == "(无)"


def test_describe_trajectories_with_no_log(tmp_path):
    assert describe_trajectories(tmp_path / "none.jsonl", "neg") == "(无)"


def test_describe_prior_runs_includes_the_gate_outcome(store):
    store.insert_run({"id": "r1", "skill": "arxiv", "status": "accepted",
                      "gate_passed": False, "forced": True})
    out = describe_prior_runs(store)
    assert "arxiv" in out and "未过门槛" in out and "强制采纳" in out


def test_describe_prior_runs_when_empty(store):
    assert "还没有" in describe_prior_runs(store)


# ---- persistence ----

def test_plans_roundtrip(store):
    plan = parse_plan(_plan(), ALLOWED)
    plan["at"] = 1000.0
    pid = save_plan(store, plan)

    assert get_plan(store, pid)["skill"] == "arxiv-digest"
    assert [p["id"] for p in list_plans(store)] == [pid]


def test_plans_are_listed_newest_first(store):
    for i, at in enumerate([100.0, 300.0, 200.0]):
        p = parse_plan(_plan(), ALLOWED)
        p["at"] = at
        p["id"] = f"p_{i}"
        save_plan(store, p)
    assert [p["at"] for p in list_plans(store)] == [300.0, 200.0, 100.0]


def test_get_plan_rejects_a_traversal_id(store):
    assert get_plan(store, "../../../etc/passwd") is None
    assert get_plan(store, "") is None


def test_get_plan_on_a_missing_id(store):
    assert get_plan(store, "p_nothere") is None
