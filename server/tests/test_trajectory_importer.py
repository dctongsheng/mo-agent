"""Mining trajectories — mostly a test about what a 差评 actually means."""

from __future__ import annotations

import json

from mo_evolve.trajectory_importer import MoTrajectoryImporter, label_counts


def _episode(**kw) -> dict:
    ep = {
        "id": "abc123", "session_id": "s1", "label": None,
        "created_at": 1000.0, "updated_at": 1000.0,
        "turns_log": [{"prompt": "summarize this paper for me", "reply": "here you go", "at": 1000.0}],
    }
    ep.update(kw)
    ep.setdefault("prompt", ep["turns_log"][-1]["prompt"])
    ep.setdefault("reply", ep["turns_log"][-1]["reply"])
    return ep


def _write(tmp_path, *episodes):
    p = tmp_path / "trajectories.jsonl"
    p.write_text("".join(json.dumps(e, ensure_ascii=False) + "\n" for e in episodes),
                 encoding="utf-8")
    return p


def _turns(n: int) -> list:
    return [{"prompt": f"question number {i} about the paper", "reply": f"answer {i}", "at": 1000.0 + i}
            for i in range(n)]


# ---- unfolding ----

def test_an_episode_unfolds_into_one_message_per_turn(tmp_path):
    f = _write(tmp_path, _episode(turns_log=_turns(3)))
    msgs = MoTrajectoryImporter.extract_messages(f)
    assert len(msgs) == 3
    assert [m["turn_index"] for m in msgs] == [0, 1, 2]
    assert [m["is_last_turn"] for m in msgs] == [False, False, True]


def test_fields_match_what_relevance_filter_requires(tmp_path):
    f = _write(tmp_path, _episode())
    m = MoTrajectoryImporter.extract_messages(f)[0]
    assert m["source"] == "mo-trajectory"
    assert m["task_input"] and m["assistant_response"]
    assert m["traj_id"] == "abc123"


def test_newest_episodes_come_first(tmp_path):
    old = _episode(id="old", turns_log=[{"prompt": "the older question here", "reply": "a"}])
    new = _episode(id="new", turns_log=[{"prompt": "the newer question here", "reply": "b"}])
    f = _write(tmp_path, old, new)         # appended in chronological order
    assert [m["traj_id"] for m in MoTrajectoryImporter.extract_messages(f)] == ["new", "old"]


def test_a_pre_fold_trajectory_without_a_turns_log_still_imports(tmp_path):
    ep = _episode()
    del ep["turns_log"]
    f = _write(tmp_path, ep)
    msgs = MoTrajectoryImporter.extract_messages(f)
    assert len(msgs) == 1 and msgs[0]["is_last_turn"]


# ---- label semantics: the whole point ----

def test_a_negative_label_attaches_only_to_the_turn_the_user_reacted_to(tmp_path):
    """A 差评 on turn 5 of a 12-turn session doesn't mean turns 1-4 were bad —
    the user was reacting to the answer in front of them.

    Carrying the label onto earlier turns would send eleven perfectly good
    answers through DeriveCorrectiveRubric, which is prompted with "the user
    marked this exchange as unsatisfactory" — fabricating eleven failure modes
    and eleven rubrics that "correct" answers that were fine.
    """
    f = _write(tmp_path, _episode(label="neg", turns_log=_turns(5)))
    msgs = MoTrajectoryImporter.extract_messages(f)

    assert [m["label"] for m in msgs] == [None, None, None, None, "neg"]
    # The context is still marked, so a future change could weight it — it just
    # isn't treated as evidence of failure.
    assert [m["label_strength"] for m in msgs] == ["weak"] * 4 + ["strong"]


def test_a_positive_label_does_not_bless_earlier_turns(tmp_path):
    f = _write(tmp_path, _episode(label="pos", turns_log=_turns(3)))
    msgs = MoTrajectoryImporter.extract_messages(f)
    assert [m["label"] for m in msgs] == [None, None, "pos"]


def test_an_unlabelled_episode_carries_no_label(tmp_path):
    f = _write(tmp_path, _episode(turns_log=_turns(2)))
    assert all(m["label"] is None for m in MoTrajectoryImporter.extract_messages(f))


def test_a_single_turn_negative_episode_is_strong(tmp_path):
    f = _write(tmp_path, _episode(label="neg"))
    assert MoTrajectoryImporter.extract_messages(f)[0]["label_strength"] == "strong"


def test_label_counts_summarizes_for_the_ui(tmp_path):
    f = _write(tmp_path,
               _episode(id="a", label="neg", turns_log=_turns(3)),
               _episode(id="b", label="pos", turns_log=_turns(2)),
               _episode(id="c", turns_log=_turns(1)))
    c = label_counts(MoTrajectoryImporter.extract_messages(f))

    assert c["neg"] == 1             # only a's final turn
    assert c["pos"] == 1             # only b's final turn
    assert c["unlabelled"] == 4      # a's first two, b's first, and c
    assert c["neg_context"] == 2     # a's first two, reported but not as failures


def test_neg_context_is_never_counted_as_a_failure(tmp_path):
    """The UI says "读了 N 条差评轨迹" from this number. It must not include
    turns the user never rejected."""
    f = _write(tmp_path, _episode(label="neg", turns_log=_turns(12)))
    c = label_counts(MoTrajectoryImporter.extract_messages(f))
    assert c["neg"] == 1
    assert c["neg_context"] == 11


# ---- hygiene ----

def test_short_prompts_are_dropped(tmp_path):
    f = _write(tmp_path, _episode(turns_log=[
        {"prompt": "hi", "reply": "hello"},
        {"prompt": "a properly substantive question", "reply": "sure"},
    ]))
    msgs = MoTrajectoryImporter.extract_messages(f)
    assert len(msgs) == 1


def test_turns_containing_secrets_are_dropped(tmp_path):
    f = _write(tmp_path, _episode(turns_log=[
        {"prompt": "use my key sk-abc123def456ghi789jkl012mno345pqr678stu", "reply": "ok"},
        {"prompt": "a clean question about the paper", "reply": "fine"},
    ]))
    msgs = MoTrajectoryImporter.extract_messages(f)
    assert len(msgs) == 1
    assert "sk-" not in msgs[0]["task_input"]


def test_a_torn_line_does_not_sink_the_import(tmp_path):
    p = _write(tmp_path, _episode(id="good"))
    p.write_text(p.read_text() + '{"id": "half-writ\n', encoding="utf-8")
    assert [m["traj_id"] for m in MoTrajectoryImporter.extract_messages(p)] == ["good"]


def test_since_filters_old_episodes(tmp_path):
    f = _write(tmp_path,
               _episode(id="old", updated_at=100.0),
               _episode(id="new", updated_at=9000.0))
    msgs = MoTrajectoryImporter.extract_messages(f, since=5000.0)
    assert [m["traj_id"] for m in msgs] == ["new"]


def test_limit_caps_the_result(tmp_path):
    f = _write(tmp_path, _episode(turns_log=_turns(10)))
    assert len(MoTrajectoryImporter.extract_messages(f, limit=4)) == 4


def test_a_missing_file_is_empty_not_an_error(tmp_path):
    assert MoTrajectoryImporter.extract_messages(tmp_path / "nope.jsonl") == []


def test_long_turns_are_truncated(tmp_path):
    f = _write(tmp_path, _episode(turns_log=[{"prompt": "q" * 5000, "reply": "r" * 9000}]))
    m = MoTrajectoryImporter.extract_messages(f)[0]
    assert len(m["task_input"]) == 2000
    assert len(m["assistant_response"]) == 4000
