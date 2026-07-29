"""The guard that stops Hermes retiring skills on a timer.

Context, because this suite only makes sense with it: Hermes' curator runs from
the gateway's hourly housekeeping tick — the gateway Mo itself starts. At
``archive_after_days`` it calls ``skill_usage.archive_skill()``, which ``mv``s
the skill's directory into ``.archive/``. No prompt, no diff, nothing in any UI.

On the development machine it had already run three times and marked 52 skills
stale, with the 90-day line falling on 2026-09-17.

``test_the_ninety_day_timer_cannot_move_a_directory`` drives the **real**
``agent.curator.apply_automatic_transitions`` against a fabricated 100-day-old
row. It is the test that would have caught that clock, and it fails if a
re-vendor ever restores the direct call.

The other half matters just as much: the guard must not break the
*non-destructive* parts of the state machine. Stale marking, reactivation, and
every exemption still have to work exactly as upstream wrote them — that is the
whole reason for intercepting one leaf function instead of reimplementing the
policy.
"""

from __future__ import annotations

import datetime
import sys
import types

import pytest

from mo_evolve import curator as C


# ---- a stand-in for tools.skill_usage ------------------------------------

class FakeSkillUsage:
    """Enough of the vendored module for apply_automatic_transitions to run."""

    STATE_ACTIVE = "active"
    STATE_STALE = "stale"
    STATE_ARCHIVED = "archived"
    PROTECTED_BUILTIN_SKILLS = {"plan"}

    def __init__(self, rows):
        self._rows = rows
        self.archived: list[str] = []          # spy: real moves that happened
        self.states: dict[str, str] = {}
        self.seeded: list[str] = []
        self.pinned: dict[str, bool] = {}

    # -- reads
    def curated_report(self):
        return [dict(r) for r in self._rows]

    def usage_report(self):
        return [dict(r) for r in self._rows]

    def list_archived_skill_names(self):
        return list(self.archived)

    def is_curation_eligible(self, name, path=None):
        return name not in self.PROTECTED_BUILTIN_SKILLS

    # -- writes
    def archive_skill(self, name):
        self.archived.append(name)
        return True, f"archived to /tmp/.archive/{name}"

    def set_state(self, name, state):
        self.states[name] = state

    def seed_record_if_missing(self, name):
        self.seeded.append(name)

    def set_pinned(self, name, pinned):
        self.pinned[name] = pinned

    def adopt_skill(self, name):
        return True, "adopted"

    def restore_skill(self, name):
        if name in self.archived:
            self.archived.remove(name)
            return True, f"restored to /tmp/skills/{name}"
        return False, "not archived"


def _row(name, *, days_idle, use_count=1, state="active", pinned=False):
    """A curated_report() row anchored `days_idle` days back."""
    when = (datetime.datetime.now(datetime.timezone.utc)
            - datetime.timedelta(days=days_idle))
    return {
        "name": name,
        "created_at": when.isoformat(),
        "last_used_at": when.isoformat() if use_count else None,
        "last_viewed_at": None,
        "last_patched_at": None,
        "use_count": use_count,
        "view_count": 0,
        "patch_count": 0,
        "state": state,
        "pinned": pinned,
        "provenance": "bundled",
        "_persisted": True,
        "last_activity_at": when.isoformat() if use_count else None,
        "activity_count": use_count,
    }


@pytest.fixture
def fake_usage(monkeypatch):
    """Install a fake tools.skill_usage before anything imports it.

    Guarantees no test can reach the real ~/.hermes-mo/skills/.usage.json.
    """
    def _install(rows):
        fake = FakeSkillUsage(rows)
        mod = types.ModuleType("tools.skill_usage")
        for attr in dir(fake):
            if not attr.startswith("_"):
                setattr(mod, attr, getattr(fake, attr))
        mod._fake = fake
        tools_pkg = sys.modules.get("tools") or types.ModuleType("tools")
        tools_pkg.skill_usage = mod
        monkeypatch.setitem(sys.modules, "tools", tools_pkg)
        monkeypatch.setitem(sys.modules, "tools.skill_usage", mod)
        return fake, mod
    return _install


@pytest.fixture(autouse=True)
def _reset_bypass():
    C._local.bypass = False
    yield
    C._local.bypass = False


# ---- the load-bearing test ------------------------------------------------

def test_the_ninety_day_timer_cannot_move_a_directory(store, fake_usage, monkeypatch):
    """Drive the REAL apply_automatic_transitions past its archive cutoff.

    This is the regression test for the 2026-09-17 clock. If a re-vendor
    restores the direct archive_skill call, or the guard stops being installed,
    this fails.
    """
    curator_mod = pytest.importorskip("agent.curator")

    fake, mod = fake_usage([_row("airtable", days_idle=100)])
    monkeypatch.setattr(curator_mod, "get_archive_after_days", lambda: 90)
    monkeypatch.setattr(curator_mod, "get_stale_after_days", lambda: 30)
    monkeypatch.setattr(curator_mod, "_cron_referenced_skills", lambda: set(),
                        raising=False)

    ok, why = C.install_guard(store)
    assert ok, why

    counts = curator_mod.apply_automatic_transitions()

    assert fake.archived == [], (
        "a skill directory was moved without consent — the guard is not "
        "intercepting archive_skill")
    assert counts.get("archived", 0) == 0
    props = C.list_proposals(store)
    assert [p["skill"] for p in props] == ["airtable"]
    assert props[0]["status"] == "proposed"
    assert props[0]["reason"] == C.REASON_INACTIVITY


def test_the_non_destructive_half_still_works(store, fake_usage, monkeypatch):
    """Stale marking and reactivation must survive the guard untouched — that
    signal is what reflect.py::usage_signal() feeds 夜貘."""
    curator_mod = pytest.importorskip("agent.curator")

    fake, _ = fake_usage([
        _row("going-stale", days_idle=45),                       # → stale
        _row("came-back", days_idle=2, state="stale"),           # → active
    ])
    monkeypatch.setattr(curator_mod, "get_archive_after_days", lambda: 90)
    monkeypatch.setattr(curator_mod, "get_stale_after_days", lambda: 30)
    monkeypatch.setattr(curator_mod, "_cron_referenced_skills", lambda: set(),
                        raising=False)
    C.install_guard(store)

    curator_mod.apply_automatic_transitions()

    assert fake.states.get("going-stale") == "stale"
    assert fake.states.get("came-back") == "active"
    assert fake.archived == []


def test_pinned_skills_are_still_exempt(store, fake_usage, monkeypatch):
    """Proves the exemption state machine wasn't reimplemented — upstream's
    pinned check runs before anything the guard could see."""
    curator_mod = pytest.importorskip("agent.curator")

    fake, _ = fake_usage([_row("pinned-one", days_idle=500, pinned=True)])
    monkeypatch.setattr(curator_mod, "get_archive_after_days", lambda: 90)
    monkeypatch.setattr(curator_mod, "get_stale_after_days", lambda: 30)
    monkeypatch.setattr(curator_mod, "_cron_referenced_skills", lambda: set(),
                        raising=False)
    C.install_guard(store)

    curator_mod.apply_automatic_transitions()

    assert fake.archived == []
    assert C.list_proposals(store) == [], "a pinned skill should not even be proposed"


def test_a_never_used_skill_inside_the_grace_floor_is_left_alone(store, fake_usage, monkeypatch):
    curator_mod = pytest.importorskip("agent.curator")

    fake, _ = fake_usage([_row("brand-new", days_idle=5, use_count=0)])
    monkeypatch.setattr(curator_mod, "get_archive_after_days", lambda: 90)
    monkeypatch.setattr(curator_mod, "get_stale_after_days", lambda: 30)
    monkeypatch.setattr(curator_mod, "_cron_referenced_skills", lambda: set(),
                        raising=False)
    C.install_guard(store)

    curator_mod.apply_automatic_transitions()
    assert fake.archived == []
    assert C.list_proposals(store) == []


# ---- guard mechanics ------------------------------------------------------

def test_guard_is_idempotent(store, fake_usage):
    fake, mod = fake_usage([])
    assert C.install_guard(store)[0]
    first = mod.archive_skill
    ok, why = C.install_guard(store)
    assert ok and why == "already installed"
    assert mod.archive_skill is first, "installing twice wrapped a wrapper"


def test_guard_installed_reports_truthfully(store, fake_usage):
    fake_usage([])
    assert not C.guard_installed()
    C.install_guard(store)
    assert C.guard_installed()
    C.uninstall_guard()
    assert not C.guard_installed()


def test_bypass_lets_an_approved_retirement_through(store, fake_usage):
    fake, _ = fake_usage([])
    C.install_guard(store)

    ok, msg = C.apply_retirement(store, "airtable")
    assert ok
    assert fake.archived == ["airtable"], "an approved retirement must actually archive"


def test_bypass_resets_after_an_exception(store, fake_usage):
    fake_usage([])
    C.install_guard(store)
    with pytest.raises(RuntimeError):
        with C.bypass():
            raise RuntimeError("boom")
    assert not getattr(C._local, "bypass", False), (
        "a failed retirement left the guard disarmed")


def test_a_guarded_call_refuses_and_explains(store, fake_usage):
    fake, mod = fake_usage([])
    C.install_guard(store)

    ok, msg = mod.archive_skill("something")

    assert ok is False
    assert "待退休" in msg
    assert fake.archived == []
    assert C.get_proposal(store, "something")["status"] == "proposed"


def test_an_agent_delete_is_labelled_differently(store, fake_usage, monkeypatch):
    """A mid-chat delete and a 90-day timer both funnel through archive_skill;
    the proposal should say which one it was."""
    fake, mod = fake_usage([])
    C.install_guard(store)
    monkeypatch.setattr(C, "_in_agent_context", lambda: True)

    mod.archive_skill("deleted-by-agent")

    assert C.get_proposal(store, "deleted-by-agent")["reason"] == C.REASON_AGENT_DELETE


# ---- proposal bookkeeping -------------------------------------------------

def test_reproposing_an_open_proposal_is_a_noop(store, fake_usage):
    fake_usage([])
    first = C.propose(store, "x", reason=C.REASON_INACTIVITY)
    again = C.propose(store, "x", reason=C.REASON_MANUAL)
    assert again["proposed_at"] == first["proposed_at"]
    assert again["reason"] == C.REASON_INACTIVITY
    assert len(C.list_proposals(store)) == 1


def test_keep_records_the_decision(store, fake_usage):
    fake, _ = fake_usage([])
    C.propose(store, "x")
    ok, msg = C.keep(store, "x")
    assert ok
    assert C.get_proposal(store, "x")["status"] == "kept"
    assert fake.pinned == {}


def test_keep_with_pin_also_pins(store, fake_usage):
    fake, _ = fake_usage([])
    C.propose(store, "x")
    ok, _ = C.keep(store, "x", pin=True)
    assert ok and fake.pinned == {"x": True}


def test_retiring_records_the_archive_path(store, fake_usage):
    fake, _ = fake_usage([])
    C.install_guard(store)
    C.propose(store, "x")
    C.apply_retirement(store, "x")
    entry = C.get_proposal(store, "x")
    assert entry["status"] == "retired"
    assert entry["archive_path"].endswith("/x")


def test_restore_flips_the_status_back(store, fake_usage):
    fake, _ = fake_usage([])
    C.install_guard(store)
    C.propose(store, "x")
    C.apply_retirement(store, "x")
    ok, _ = C.restore(store, "x")
    assert ok
    assert C.get_proposal(store, "x")["status"] == "kept"


def test_a_corrupt_retirements_file_does_not_crash(store, fake_usage):
    fake_usage([])
    store.evolve_dir.mkdir(parents=True, exist_ok=True)
    C.retirements_path(store).write_text("{ not json", encoding="utf-8")
    assert C.list_proposals(store) == []
    C.propose(store, "x")
    assert len(C.list_proposals(store)) == 1


def test_proposals_carry_the_reclaimable_cost(store, fake_usage, make_skill):
    """Retiring isn't tidiness — it's tokens back from every system prompt."""
    fake_usage([])
    p = make_skill("chatty", description="Does a thing.")
    p.write_text("---\nname: chatty\ndescription: Does a thing.\n---\n\n" + "x" * 4000,
                 encoding="utf-8")

    entry = C.propose(store, "chatty", row=_row("chatty", days_idle=100))

    assert entry["skill_md_chars"] > 4000
    assert entry["description"] == "Does a thing."
    assert entry["days_idle"] == 100


def test_status_counts_and_totals(store, fake_usage, make_skill):
    make_skill("a")
    fake, _ = fake_usage([_row("a", days_idle=100)])
    C.propose(store, "a", row=_row("a", days_idle=100))

    st = C.status(store)
    assert st["counts"]["proposed"] == 1
    assert st["proposed_chars"] > 0
    assert "guard_installed" in st and "clamped" in st


# ---- sync / preview -------------------------------------------------------

def test_sync_turns_existing_stale_marks_into_visible_proposals(store, fake_usage, monkeypatch):
    """52 skills were marked stale by runs the user never saw. They are real
    telemetry, so they get shown rather than reset."""
    curator_mod = pytest.importorskip("agent.curator")
    fake, _ = fake_usage([
        _row("old-1", days_idle=45, state="stale"),
        _row("old-2", days_idle=120, state="stale"),
        _row("fresh", days_idle=1),
    ])
    monkeypatch.setattr(curator_mod, "get_archive_after_days", lambda: 90)
    monkeypatch.setattr(curator_mod, "get_stale_after_days", lambda: 30)

    added = C.sync_proposals(store)

    names = {p["skill"] for p in C.list_proposals(store)}
    assert names == {"old-1", "old-2"}
    assert added == 2


def test_sync_does_not_resurrect_a_decided_proposal(store, fake_usage, monkeypatch):
    curator_mod = pytest.importorskip("agent.curator")
    fake, _ = fake_usage([_row("old-1", days_idle=120, state="stale")])
    monkeypatch.setattr(curator_mod, "get_archive_after_days", lambda: 90)
    monkeypatch.setattr(curator_mod, "get_stale_after_days", lambda: 30)

    C.sync_proposals(store)
    C.keep(store, "old-1")
    C.sync_proposals(store)

    assert C.get_proposal(store, "old-1")["status"] == "kept"


def test_a_guard_created_proposal_still_carries_its_telemetry(store, fake_usage):
    """The guard only receives a skill name. Without a lookup, every proposal
    it creates would show "闲置 —— 天 / provenance 未知" — exactly the numbers
    that make the proposal decidable."""
    fake, mod = fake_usage([_row("airtable", days_idle=120, use_count=3)])
    C.install_guard(store)

    mod.archive_skill("airtable")

    entry = C.get_proposal(store, "airtable")
    assert entry["days_idle"] == 120
    assert entry["provenance"] == "bundled"
    assert entry["use_count"] == 3


def test_sync_backfills_an_incomplete_proposal(store, fake_usage, monkeypatch):
    curator_mod = pytest.importorskip("agent.curator")
    monkeypatch.setattr(curator_mod, "get_archive_after_days", lambda: 90)
    monkeypatch.setattr(curator_mod, "get_stale_after_days", lambda: 30)
    fake_usage([_row("old", days_idle=120, state="stale")])

    # Simulate a proposal written before the lookup existed.
    with store.lock:
        data = C._read(store)
        data["items"]["old"] = {"skill": "old", "status": "proposed",
                                "proposed_at": 1.0, "reason": C.REASON_INACTIVITY,
                                "days_idle": None, "provenance": None}
        C._write(store, data)

    C.sync_proposals(store)
    assert C.get_proposal(store, "old")["days_idle"] == 120
