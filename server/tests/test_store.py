"""EvolveStore — run bookkeeping, skill listing, auto-rotation."""

from __future__ import annotations

from mo_evolve.store import EvolveStore, read_json


def test_runs_roundtrip(store):
    assert store.read_runs() == []
    store.insert_run({"id": "a", "skill": "s1", "status": "running"})
    store.insert_run({"id": "b", "skill": "s2", "status": "running"})
    # Newest first — the UI renders this order directly.
    assert [r["id"] for r in store.read_runs()] == ["b", "a"]


def test_update_run_merges_fields(store):
    store.insert_run({"id": "a", "skill": "s1", "status": "running"})
    store.update_run("a", status="done", output_dir="/tmp/out", rc=0)
    r = store.get_run("a")
    assert r["status"] == "done"
    assert r["output_dir"] == "/tmp/out"
    assert r["skill"] == "s1"  # untouched fields survive


def test_update_unknown_run_is_a_noop(store):
    store.insert_run({"id": "a", "status": "running"})
    store.update_run("nope", status="done")
    assert store.get_run("a")["status"] == "running"


def test_read_runs_survives_a_corrupt_file(store):
    store.evolve_dir.mkdir(parents=True, exist_ok=True)
    store.runs_file.write_text("{ not json", encoding="utf-8")
    assert store.read_runs() == []


def test_schedule_defaults_then_persists(store):
    d = store.read_schedule()
    assert d["enabled"] is False and d["skill"] == "auto"
    store.write_schedule({"enabled": True, "hour": 2, "minute": 30,
                          "skill": "arxiv", "iterations": 6})
    assert store.read_schedule()["hour"] == 2


def test_list_skills_classifies_and_sorts(store, make_skill):
    make_skill("zeta", description="Z skill")
    make_skill("alpha", description="A skill")
    skills = store.list_skills()
    assert [s["name"] for s in skills] == ["alpha", "zeta"]
    assert all(s["builtin"] is False for s in skills)
    assert skills[0]["description"] == "A skill"
    assert skills[0]["path"].startswith("skills/")


def test_list_skills_prefers_frontmatter_name_over_dir_name(store, make_skill):
    p = make_skill("audiocraft")
    p.write_text(
        "---\nname: audiocraft-audio-generation\ndescription: d\n---\n\nbody\n",
        encoding="utf-8",
    )
    assert [s["name"] for s in store.list_skills()] == ["audiocraft-audio-generation"]


def test_builtin_detection_from_manifest(store, make_skill):
    make_skill("arxiv")
    make_skill("mine")
    (store.skills_dir / ".bundled_manifest").write_text(
        "# bundled\narxiv: something\n", encoding="utf-8")
    got = {s["name"]: s["builtin"] for s in store.list_skills()}
    assert got == {"arxiv": True, "mine": False}


def test_find_skill_file_by_dir_and_by_frontmatter(store, make_skill):
    make_skill("by-dir")
    p = make_skill("odd-dir")
    p.write_text("---\nname: declared-name\ndescription: d\n---\n\nb\n", encoding="utf-8")

    assert store.find_skill_file("by-dir") == store.skills_dir / "by-dir" / "SKILL.md"
    assert store.find_skill_file("declared-name") == p
    assert store.find_skill_file("absent") is None


def test_next_auto_skill_rotates_and_persists_cursor(store, make_skill):
    for n in ("a", "b", "c"):
        make_skill(n)
    # Empty cursor isn't in the list → ValueError → start from the first.
    assert store.next_auto_skill() == "a"
    assert read_json(store.auto_cursor_file, {})["last"] == "a"
    assert store.next_auto_skill() == "b"
    assert store.next_auto_skill() == "c"
    assert store.next_auto_skill() == "a"   # wraps


def test_next_auto_skill_recovers_from_a_deleted_cursor_target(store, make_skill):
    make_skill("a")
    make_skill("b")
    store.evolve_dir.mkdir(parents=True, exist_ok=True)
    from mo_evolve.store import write_json
    write_json(store.auto_cursor_file, {"last": "deleted-skill"})
    assert store.next_auto_skill() == "a"


def test_next_auto_skill_empty_when_all_builtin(store, make_skill):
    make_skill("arxiv")
    (store.skills_dir / ".bundled_manifest").write_text("arxiv: x\n", encoding="utf-8")
    assert store.next_auto_skill() == ""


def test_paths_are_under_the_evolver_profile(tmp_hermes_home):
    s = EvolveStore(tmp_hermes_home)
    assert s.evolve_dir == tmp_hermes_home / "profiles" / "ye-mao-evolve" / "evolve"
    # Evolution reads/writes the user's LIVE skills, not the profile clone —
    # a newly authored skill must be immediately evolvable.
    assert s.skills_dir == tmp_hermes_home / "skills"
