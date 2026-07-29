"""Building an eval set from trajectories.

The load-bearing behaviour: a 差评 turn's rubric must describe the *correction*,
never the response the user rejected. RelevanceFilter derives its rubric partly
from the assistant's actual answer — for a negative turn that answer is the bug,
so an unmodified rubric would teach the optimizer to reproduce it.
"""

from __future__ import annotations

import json

import pytest

from mo_evolve.trajectory_dataset import (
    _stratified_split,
    _stratum,
    build_dataset_from_trajectories,
    min_mined_for,
)


class Cfg:
    train_ratio = 0.5
    val_ratio = 0.25
    holdout_ratio = 0.25
    eval_dataset_size = 20
    min_holdout = 5


def _ex(source="mo-trajectory", task="t", rubric="r"):
    from evolution.core.dataset_builder import EvalExample
    return EvalExample(task_input=task, expected_behavior=rubric, source=source)


# ---- stratification ----

def test_stratum_classification():
    assert _stratum(_ex("mo-trajectory:neg")) == "neg"
    assert _stratum(_ex("mo-trajectory:pos")) == "pos"
    assert _stratum(_ex("mo-trajectory")) == "unlabelled"
    assert _stratum(_ex("synthetic")) == "synthetic"


def test_holdout_is_never_all_negatives():
    """The holdout is what the gate measures. Drawn only from failures it
    measures recovery from failure, not overall quality."""
    examples = ([_ex("mo-trajectory:neg", f"n{i}") for i in range(8)]
                + [_ex("synthetic", f"s{i}") for i in range(8)])
    _, _, holdout = _stratified_split(examples, Cfg())

    strata = {_stratum(e) for e in holdout}
    assert "neg" in strata and "synthetic" in strata, (
        f"holdout drawn from one stratum only: {strata}")


def test_every_stratum_reaches_the_train_split():
    examples = ([_ex("mo-trajectory:neg", f"n{i}") for i in range(4)]
                + [_ex("mo-trajectory:pos", f"p{i}") for i in range(4)])
    train, _, _ = _stratified_split(examples, Cfg())
    assert {_stratum(e) for e in train} == {"neg", "pos"}


def test_a_tiny_stratum_is_not_lost():
    examples = [_ex("mo-trajectory:neg", "only-neg")] + [_ex("synthetic", f"s{i}") for i in range(8)]
    train, val, holdout = _stratified_split(examples, Cfg())
    assert len(train) + len(val) + len(holdout) == 9


def test_split_of_an_empty_set():
    assert _stratified_split([], Cfg()) == ([], [], [])


# ---- end to end, with the LLM faked ----

class _FakeRelevanceFilter:
    """Stands in for the vendored RelevanceFilter — no network."""
    def __init__(self, model): pass

    def filter_and_score(self, messages, skill_name, skill_text, max_examples=50):
        from evolution.core.dataset_builder import EvalExample
        # Mirrors the real behaviour that makes the corrective step necessary:
        # the rubric is derived from the assistant's actual response.
        return [EvalExample(task_input=m["task_input"],
                            expected_behavior=f"should answer like: {m['assistant_response']}",
                            source=m["source"])
                for m in messages]


class _FakeCorrective:
    def __init__(self, *a, **kw): pass

    def __call__(self, skill_name, skill_text, task_input, actual_response):
        class R:
            expected_behavior = "should have kept it to three bullets"
            failure_mode = "ignored-length-constraint"
        return R()


@pytest.fixture
def patched(monkeypatch):
    import dspy
    from evolution.core import external_importers
    monkeypatch.setattr(external_importers, "RelevanceFilter", _FakeRelevanceFilter)
    monkeypatch.setattr(dspy, "ChainOfThought", _FakeCorrective)
    monkeypatch.setattr(dspy, "LM", lambda *a, **kw: object())
    monkeypatch.setattr(dspy, "context", lambda **kw: __import__("contextlib").nullcontext())


def _traj_file(tmp_path, episodes):
    p = tmp_path / "trajectories.jsonl"
    p.write_text("".join(json.dumps(e) + "\n" for e in episodes), encoding="utf-8")
    return p


def _ep(eid, label, n_turns=1):
    return {"id": eid, "session_id": eid, "label": label, "created_at": 1.0, "updated_at": 1.0,
            "turns_log": [{"prompt": f"{eid} question about the paper {i}",
                           "reply": f"{eid} bad answer {i}", "at": 1.0}
                          for i in range(n_turns)]}


def test_a_negative_rubric_describes_the_correction_not_the_bad_answer(patched, tmp_path):
    f = _traj_file(tmp_path, [_ep(f"neg{i}", "neg") for i in range(10)])
    dataset, prov = build_dataset_from_trajectories(
        "demo", "---\nname: demo\n---\nbody", f, "fake/model", Cfg(), blend_synthetic=False)

    negs = [e for e in dataset.all_examples if _stratum(e) == "neg"]
    assert negs
    for e in negs:
        assert e.expected_behavior == "should have kept it to three bullets"
        assert "bad answer" not in e.expected_behavior, (
            "the rejected response leaked into the rubric — the optimizer would "
            "be trained to reproduce the failure")
        assert e.category == "ignored-length-constraint"


def test_provenance_records_the_evidence(patched, tmp_path):
    f = _traj_file(tmp_path, [_ep("a", "neg"), _ep("b", "pos"), _ep("c", None)] * 4)
    _, prov = build_dataset_from_trajectories(
        "demo", "body", f, "fake/model", Cfg(), blend_synthetic=False)

    assert prov["source"] == "trajectory"
    assert prov["counts"]["trajectory_neg"] > 0
    assert prov["failure_modes"]["ignored-length-constraint"] > 0
    assert set(prov["trajectory_ids"]) <= {"a", "b", "c"}
    assert "holdout_strata" in prov


def test_a_thin_mined_set_is_topped_up_with_synthetic(patched, tmp_path, monkeypatch):
    """A 3-example holdout can never clear the gate's min_holdout, so a thin
    trajectory-only run would silently never be acceptable."""
    from evolution.core import dataset_builder

    class _FakeSynth:
        def __init__(self, config): pass
        def generate(self, artifact_text, artifact_type):
            from evolution.core.dataset_builder import EvalDataset, EvalExample
            return EvalDataset(train=[EvalExample(task_input=f"syn{i}", expected_behavior="r")
                                      for i in range(12)])
    monkeypatch.setattr(dataset_builder, "SyntheticDatasetBuilder", _FakeSynth)

    f = _traj_file(tmp_path, [_ep("a", "neg")])          # 1 mined, well under MIN_MINED
    dataset, prov = build_dataset_from_trajectories(
        "demo", "body", f, "fake/model", Cfg(), blend_synthetic=True)

    assert prov["source"] == "mixed"
    assert prov["counts"]["synthetic"] == 12
    assert len(dataset.all_examples) == 13


def test_blending_is_skipped_when_enough_was_mined(patched, tmp_path):
    f = _traj_file(tmp_path, [_ep(f"e{i}", "neg") for i in range(min_mined_for(Cfg()) + 2)])
    _, prov = build_dataset_from_trajectories(
        "demo", "body", f, "fake/model", Cfg(), blend_synthetic=True)
    assert prov["counts"]["synthetic"] == 0
    assert prov["source"] == "trajectory"


def test_an_empty_log_yields_an_empty_dataset(patched, tmp_path):
    f = _traj_file(tmp_path, [])
    dataset, prov = build_dataset_from_trajectories(
        "demo", "body", f, "fake/model", Cfg(), blend_synthetic=False)
    assert dataset.all_examples == []
    assert prov["turns_mined"] == 0


def test_a_failing_corrective_call_keeps_the_example(patched, tmp_path, monkeypatch):
    """Losing the rubric rewrite is bad; losing the example entirely is worse."""
    import dspy

    class _Boom:
        def __init__(self, *a, **kw): pass
        def __call__(self, **kw): raise RuntimeError("judge down")
    monkeypatch.setattr(dspy, "ChainOfThought", _Boom)

    f = _traj_file(tmp_path, [_ep("a", "neg")])
    dataset, prov = build_dataset_from_trajectories(
        "demo", "body", f, "fake/model", Cfg(), blend_synthetic=False)

    assert len(dataset.all_examples) == 1
    assert prov["failure_modes"] == {}, "an unrewritten rubric must not be tagged"


# ---- regressions ----

def test_the_newest_duplicate_wins(patched, tmp_path):
    """Same prompt Monday (fine) and Friday (差评). `messages` is newest-first
    and a dict comprehension lets the LAST write win, so the naive mapping
    handed the newest example Monday's label and discarded the 差评."""
    same = "translate this paragraph into english please"
    monday = {"id": "mon", "session_id": "mon", "label": "pos", "created_at": 1.0,
              "updated_at": 1.0, "turns_log": [{"prompt": same, "reply": "a good answer"}]}
    friday = {"id": "fri", "session_id": "fri", "label": "neg", "created_at": 9.0,
              "updated_at": 9.0, "turns_log": [{"prompt": same, "reply": "a bad answer"}]}
    f = _traj_file(tmp_path, [monday, friday])

    dataset, prov = build_dataset_from_trajectories(
        "demo", "body", f, "fake/model", Cfg(), blend_synthetic=False)

    sources = {e.source for e in dataset.all_examples}
    assert "mo-trajectory:neg" in sources, f"the 差评 was discarded: {sources}"
    assert prov["counts"]["trajectory_neg"] >= 1


def test_an_unlabelled_duplicate_does_not_erase_a_label(patched, tmp_path):
    same = "explain the attention mechanism to me"
    labelled = {"id": "old", "session_id": "old", "label": "neg", "created_at": 1.0,
                "updated_at": 1.0, "turns_log": [{"prompt": same, "reply": "bad"}]}
    plain = {"id": "new", "session_id": "new", "label": None, "created_at": 9.0,
             "updated_at": 9.0, "turns_log": [{"prompt": same, "reply": "fine"}]}
    f = _traj_file(tmp_path, [labelled, plain])

    dataset, _ = build_dataset_from_trajectories(
        "demo", "body", f, "fake/model", Cfg(), blend_synthetic=False)
    assert {e.source for e in dataset.all_examples} == {"mo-trajectory:neg"}


def test_earlier_turns_of_a_negative_episode_get_no_corrective_rubric(patched, tmp_path):
    """The end-to-end version of the importer's label fix: eleven good answers
    must not each produce a fabricated failure mode."""
    f = _traj_file(tmp_path, [_ep("long", "neg", n_turns=12)])
    dataset, prov = build_dataset_from_trajectories(
        "demo", "body", f, "fake/model", Cfg(), blend_synthetic=False)

    assert prov["counts"]["trajectory_neg"] == 1
    assert prov["counts"]["trajectory_unlabelled"] == 11
    assert sum(prov["failure_modes"].values()) == 1, (
        "a failure mode was invented for a turn the user never rejected")


def test_the_split_reaches_the_gate_floor_at_the_blend_threshold():
    """min_mined_for exists to guarantee this. It previously did not: at the old
    MIN_MINED=8 the best achievable holdout was 4, against a min_holdout of 5,
    so every run burned its full budget and was then refused for sample size."""
    n = min_mined_for(Cfg())
    for mix in ([("mo-trajectory:neg", n)],
                [("mo-trajectory:neg", n // 2), ("synthetic", n - n // 2)],
                [("mo-trajectory:neg", 2), ("mo-trajectory:pos", 2),
                 ("mo-trajectory", 2), ("synthetic", n - 6)]):
        examples = [_ex(src, f"{src}{i}") for src, c in mix for i in range(c)]
        train, val, holdout = _stratified_split(examples, Cfg())
        assert len(holdout) >= Cfg.min_holdout, f"{mix} → holdout {len(holdout)}"
        assert train, f"{mix} → empty train"


def test_the_split_never_loses_or_duplicates_an_example():
    examples = [_ex("mo-trajectory:neg", f"n{i}") for i in range(7)] \
        + [_ex("synthetic", f"s{i}") for i in range(5)]
    train, val, holdout = _stratified_split(examples, Cfg())
    assert len(train) + len(val) + len(holdout) == 12
    assert len({id(e) for e in train + val + holdout}) == 12


def test_the_split_is_deterministic():
    """A verdict must be recomputable from the stored dataset."""
    examples = [_ex("mo-trajectory:neg", f"n{i}") for i in range(6)] \
        + [_ex("synthetic", f"s{i}") for i in range(6)]
    a = _stratified_split(list(examples), Cfg())
    b = _stratified_split(list(examples), Cfg())
    assert [[e.task_input for e in split] for split in a] == \
           [[e.task_input for e in split] for split in b]


def test_the_holdout_is_not_just_the_oldest_slice():
    """Unshuffled, the holdout was always the tail of each stratum — so the gate
    only ever measured the stalest examples."""
    examples = [_ex("mo-trajectory", f"t{i:02d}") for i in range(20)]
    _, _, holdout = _stratified_split(examples, Cfg())
    picked = sorted(e.task_input for e in holdout)
    assert picked != sorted(e.task_input for e in examples[-len(holdout):])
