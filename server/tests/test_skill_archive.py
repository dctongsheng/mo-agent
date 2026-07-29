"""Versioned skill archive — the revert path that did not exist before."""

from __future__ import annotations

from pathlib import Path

from mo_evolve.skill_archive import (
    apply_atomic,
    head_matches,
    list_versions,
    read_head,
    read_version,
    revert,
    set_head,
    sha256_text,
    snapshot,
)


def _skill(tmp_path: Path, text: str = "ORIGINAL") -> Path:
    p = tmp_path / "skills" / "arxiv" / "SKILL.md"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")
    return p


def test_snapshot_records_current_contents(tmp_path):
    arch = tmp_path / "archive"
    target = _skill(tmp_path, "ORIGINAL")

    v = snapshot(arch, target, "arxiv", run_id="r1")
    assert v == 1
    assert read_version(arch, "arxiv", 1) == "ORIGINAL"

    entry = list_versions(arch, "arxiv")[0]
    assert entry["run_id"] == "r1"
    assert entry["sha256"] == sha256_text("ORIGINAL")
    assert entry["kind"] == "pre-accept"


def test_versions_increment_and_list_newest_first(tmp_path):
    arch = tmp_path / "archive"
    target = _skill(tmp_path, "V1")

    snapshot(arch, target, "arxiv")
    target.write_text("V2", encoding="utf-8")
    snapshot(arch, target, "arxiv")
    target.write_text("V3", encoding="utf-8")
    snapshot(arch, target, "arxiv")

    assert [e["version"] for e in list_versions(arch, "arxiv")] == [3, 2, 1]
    assert read_version(arch, "arxiv", 1) == "V1"
    assert read_version(arch, "arxiv", 3) == "V3"


def test_revert_restores_byte_identically(tmp_path):
    arch = tmp_path / "archive"
    original = "---\nname: arxiv\ndescription: d\n---\n\nHand-written body.\n"
    target = _skill(tmp_path, original)

    snapshot(arch, target, "arxiv", run_id="r1")
    apply_atomic(target, "EVOLVED — worse in every way")
    set_head(arch, "arxiv", 1, "EVOLVED — worse in every way")

    ok, msg = revert(arch, target, "arxiv")
    assert ok, msg
    assert target.read_text(encoding="utf-8") == original


def test_revert_of_revert(tmp_path):
    arch = tmp_path / "archive"
    target = _skill(tmp_path, "ORIGINAL")

    snapshot(arch, target, "arxiv")                 # v1 = ORIGINAL
    apply_atomic(target, "EVOLVED")
    set_head(arch, "arxiv", 1, "EVOLVED")

    revert(arch, target, "arxiv")                   # v2 = EVOLVED, file = ORIGINAL
    assert target.read_text(encoding="utf-8") == "ORIGINAL"

    ok, _ = revert(arch, target, "arxiv", version=2)
    assert ok
    assert target.read_text(encoding="utf-8") == "EVOLVED"


def test_revert_to_an_explicit_version(tmp_path):
    arch = tmp_path / "archive"
    target = _skill(tmp_path, "V1")
    snapshot(arch, target, "arxiv")
    target.write_text("V2", encoding="utf-8")
    snapshot(arch, target, "arxiv")
    target.write_text("V3-live", encoding="utf-8")

    ok, _ = revert(arch, target, "arxiv", version=1)
    assert ok
    assert target.read_text(encoding="utf-8") == "V1"


def test_revert_with_no_archive_fails_cleanly(tmp_path):
    ok, msg = revert(tmp_path / "archive", _skill(tmp_path), "arxiv")
    assert not ok and "存档" in msg


def test_revert_to_a_missing_version_fails_cleanly(tmp_path):
    arch = tmp_path / "archive"
    target = _skill(tmp_path)
    snapshot(arch, target, "arxiv")
    ok, msg = revert(arch, target, "arxiv", version=99)
    assert not ok and "不存在" in msg


# ---- HEAD tracking / drift ----

def test_head_matches_after_our_own_write(tmp_path):
    arch = tmp_path / "archive"
    target = _skill(tmp_path, "ORIGINAL")
    apply_atomic(target, "EVOLVED")
    set_head(arch, "arxiv", 1, "EVOLVED")
    assert head_matches(arch, "arxiv", target)


def test_head_detects_a_hand_edit(tmp_path):
    arch = tmp_path / "archive"
    target = _skill(tmp_path, "ORIGINAL")
    apply_atomic(target, "EVOLVED")
    set_head(arch, "arxiv", 1, "EVOLVED")

    target.write_text("the user edited this by hand", encoding="utf-8")
    assert not head_matches(arch, "arxiv", target)


def test_unmanaged_skill_is_not_reported_as_drifted(tmp_path):
    """No HEAD yet means we've never written it — that isn't drift."""
    assert head_matches(tmp_path / "archive", "arxiv", _skill(tmp_path))


def test_read_head_on_missing_file(tmp_path):
    assert read_head(tmp_path / "archive", "nope") == {}


# ---- atomic write ----

def test_apply_atomic_leaves_no_temp_file(tmp_path):
    target = _skill(tmp_path, "x")
    apply_atomic(target, "y")
    assert target.read_text(encoding="utf-8") == "y"
    assert list(target.parent.glob("*.tmp")) == []


def test_apply_atomic_creates_missing_parents(tmp_path):
    target = tmp_path / "a" / "b" / "SKILL.md"
    apply_atomic(target, "new")
    assert target.read_text(encoding="utf-8") == "new"


def test_snapshot_of_a_missing_target_records_that_it_did_not_exist(tmp_path):
    """The 'create a new skill' path (Phase 5) needs a v0 meaning 'absent'."""
    arch = tmp_path / "archive"
    v = snapshot(arch, tmp_path / "skills" / "new" / "SKILL.md", "new")
    entry = list_versions(arch, "new")[0]
    assert entry["existed"] is False
    assert read_version(arch, "new", v) == ""


def test_skill_name_is_sanitized_into_the_archive_dir(tmp_path):
    arch = tmp_path / "archive"
    snapshot(arch, _skill(tmp_path), "../../evil")
    assert not (tmp_path.parent / "evil").exists()
    assert any(arch.iterdir())


def test_reverting_to_a_version_that_never_existed_removes_the_skill(tmp_path):
    """A skill authored from scratch has v0001 = "" with existed: False.

    Writing that text back would leave a zero-byte SKILL.md — worse than the
    skill being gone, because the directory is still indexed and the agent
    keeps offering a skill with no content.
    """
    arch = tmp_path / "archive"
    target = tmp_path / "skills" / "brand-new" / "SKILL.md"

    v0 = snapshot(arch, target, "brand-new")           # nothing there yet
    assert list_versions(arch, "brand-new")[0]["existed"] is False

    apply_atomic(target, "---\nname: brand-new\ndescription: d\n---\n\nbody\n")
    set_head(arch, "brand-new", v0, "…")

    ok, msg = revert(arch, target, "brand-new", version=v0)

    assert ok, msg
    assert not target.exists(), "an empty SKILL.md was left behind"
    assert not target.parent.exists(), "the skill directory was left behind"


def test_reverting_a_real_version_still_writes_text(tmp_path):
    """Guard the fix from over-reaching onto normal reverts."""
    arch = tmp_path / "archive"
    target = _skill(tmp_path, "V1")
    snapshot(arch, target, "arxiv")
    apply_atomic(target, "V2")

    ok, _ = revert(arch, target, "arxiv", version=1)
    assert ok
    assert target.read_text(encoding="utf-8") == "V1"


def test_a_removed_skill_can_still_be_brought_back(tmp_path):
    """Reverting to existed=False removes the directory, at which point a live
    lookup can't find the skill — but its later versions are still archived.
    Without a path fallback that text would be unreachable."""
    from mo_evolve.skill_archive import recorded_path

    arch = tmp_path / "archive"
    target = tmp_path / "skills" / "brand-new" / "SKILL.md"

    snapshot(arch, target, "brand-new")                       # v1: existed=False
    apply_atomic(target, "AUTHORED")
    set_head(arch, "brand-new", 1, "AUTHORED")

    revert(arch, target, "brand-new", version=1)              # v2 = AUTHORED
    assert not target.exists()

    recovered = recorded_path(arch, "brand-new")
    assert recovered is not None, "the archive lost track of where it lived"

    ok, _ = revert(arch, recovered, "brand-new", version=2)
    assert ok
    assert recovered.read_text(encoding="utf-8") == "AUTHORED"


def test_recorded_path_on_an_unknown_skill(tmp_path):
    from mo_evolve.skill_archive import recorded_path
    assert recorded_path(tmp_path / "archive", "never-seen") is None
