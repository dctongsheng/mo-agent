"""待办 — the gate shim, the unified list, and the background-review log.

The shim is the interesting part. Hermes' write-approval gate is one boolean
per subsystem: with it off, `evaluate_gate` returns `allow` for foreground and
background alike; with it on, every skill write stages regardless of origin.
Neither setting gives what Mo wants, which is "instant when you asked for it,
reviewable when a daemon thread did it".

So Mo turns both flags on and shims the gate to pass foreground writes through.
The shim must be inert unless Mo set the flags itself, or it would silently
undo a user who deliberately enabled full approval.
"""

from __future__ import annotations

import json
import sys
import types

import pytest

from mo_evolve import inbox as I


class FakeGateDecision:
    def __init__(self, allow=False, stage=False, blocked=False, message=""):
        self.allow, self.stage, self.blocked, self.message = allow, stage, blocked, message


class FakeWriteApproval:
    """Enough of tools.write_approval to drive the shim and the inbox."""

    SKILLS = "skills"
    MEMORY = "memory"
    GateDecision = FakeGateDecision

    def __init__(self):
        self.pending: dict[str, list[dict]] = {"skills": [], "memory": []}
        self.background = False
        self.gate_calls: list[str] = []

    def is_background(self):
        return self.background

    def evaluate_gate(self, subsystem, **kw):
        self.gate_calls.append(subsystem)
        # Upstream behaviour with the flag ON: skills always stage, and any
        # background write stages.
        return FakeGateDecision(stage=True, message="staged")

    def list_pending(self, subsystem):
        return list(self.pending.get(subsystem, []))

    def get_pending(self, subsystem, pid):
        return next((r for r in self.pending.get(subsystem, []) if r["id"] == pid), None)

    def discard_pending(self, subsystem, pid):
        before = len(self.pending.get(subsystem, []))
        self.pending[subsystem] = [r for r in self.pending.get(subsystem, [])
                                   if r["id"] != pid]
        return len(self.pending[subsystem]) < before

    def skill_pending_diff(self, rec):
        return "--- a\n+++ b\n+new line\n"


@pytest.fixture
def fake_wa(monkeypatch):
    fake = FakeWriteApproval()
    mod = types.ModuleType("tools.write_approval")
    for attr in dir(fake):
        if not attr.startswith("__"):
            setattr(mod, attr, getattr(fake, attr))
    mod._fake = fake
    tools_pkg = sys.modules.get("tools") or types.ModuleType("tools")
    tools_pkg.write_approval = mod
    monkeypatch.setitem(sys.modules, "tools", tools_pkg)
    monkeypatch.setitem(sys.modules, "tools.write_approval", mod)
    return fake, mod


@pytest.fixture
def marked(monkeypatch):
    """Pretend Mo set the flags (the config marker is present)."""
    monkeypatch.setattr(I, "background_only_enabled", lambda: True)


# ---- the shim -------------------------------------------------------------

def test_a_foreground_write_is_allowed_through(fake_wa, marked):
    """Telling 小貘 「记住我用 pnpm」 must still take effect immediately."""
    fake, mod = fake_wa
    assert I.install_gate_shim()[0]
    fake.background = False

    decision = mod.evaluate_gate("memory")

    assert decision.allow is True
    assert decision.stage is False


def test_a_background_write_is_staged(fake_wa, marked):
    """The fork that runs every ~10 turns goes to the inbox instead."""
    fake, mod = fake_wa
    assert I.install_gate_shim()[0]
    fake.background = True

    decision = mod.evaluate_gate("skills")

    assert decision.stage is True
    assert decision.allow is False


def test_the_shim_is_inert_without_mo_s_marker(fake_wa, monkeypatch):
    """A user who deliberately enabled full approval keeps it — the shim must
    not quietly reinterpret their setting."""
    fake, mod = fake_wa
    monkeypatch.setattr(I, "background_only_enabled", lambda: False)
    I.install_gate_shim()
    fake.background = False

    decision = mod.evaluate_gate("skills")

    assert decision.stage is True, "a deliberate full-approval setting was overridden"


def test_the_shim_is_idempotent(fake_wa, marked):
    fake, mod = fake_wa
    assert I.install_gate_shim()[0]
    first = mod.evaluate_gate
    ok, why = I.install_gate_shim()
    assert ok and why == "already installed"
    assert mod.evaluate_gate is first


def test_shim_installed_reports_truthfully(fake_wa, marked):
    fake, mod = fake_wa
    assert not I.shim_installed()
    I.install_gate_shim()
    assert I.shim_installed()
    I.uninstall_gate_shim()
    assert not I.shim_installed()


# ---- the unified list -----------------------------------------------------

def _staged(fake, subsystem, pid, name, origin="background_review"):
    fake.pending[subsystem].append({
        "id": pid, "subsystem": subsystem, "action": "create",
        "summary": f"create {name}", "origin": origin, "created_at": 100.0,
        "payload": {"action": "create", "name": name, "content": "..."},
    })


def test_staged_writes_appear_with_their_origin(store, fake_wa):
    fake, _ = fake_wa
    _staged(fake, "skills", "s1", "new-skill")
    _staged(fake, "memory", "m1", "a fact", origin="foreground")

    items = I.list_all(store)

    kinds = {i["kind"] for i in items}
    assert kinds == {"skills-write", "memory-write"}
    origins = {i["title"]: i["origin"] for i in items}
    assert origins["new-skill"] == "background_review"


def test_retirement_proposals_join_the_same_list(store, fake_wa):
    from mo_evolve import curator
    curator.propose(store, "airtable", reason=curator.REASON_INACTIVITY)

    items = I.list_all(store)
    assert any(i["kind"] == "retirement" and i["title"] == "airtable" for i in items)


def test_learn_drafts_join_the_same_list(store, fake_wa):
    store.insert_learn_run({"id": "d1", "status": "done", "created_at": 5.0,
                            "request": "learn arxiv",
                            "skill": {"name": "arxiv-api", "description": "d"}})
    items = I.list_all(store)
    assert any(i["kind"] == "learn-draft" and i["title"] == "arxiv-api" for i in items)


def test_a_running_learn_draft_is_not_in_the_list(store, fake_wa):
    store.insert_learn_run({"id": "d1", "status": "running", "created_at": 5.0,
                            "request": "x"})
    assert [i for i in I.list_all(store) if i["kind"] == "learn-draft"] == []


def test_the_list_is_newest_first(store, fake_wa):
    fake, _ = fake_wa
    _staged(fake, "skills", "old", "old-one")
    fake.pending["skills"][0]["created_at"] = 1.0
    _staged(fake, "skills", "new", "new-one")
    fake.pending["skills"][1]["created_at"] = 99.0
    assert [i["title"] for i in I.list_all(store)][:2] == ["new-one", "old-one"]


def test_counts_break_out_background(store, fake_wa):
    fake, _ = fake_wa
    _staged(fake, "skills", "s1", "a", origin="background_review")
    _staged(fake, "memory", "m1", "b", origin="foreground")

    c = I.counts(store)
    assert c["total"] == 2
    assert c["background"] == 1


# ---- approve / reject -----------------------------------------------------

def test_detail_includes_a_rendered_diff_for_skills(store, fake_wa):
    fake, _ = fake_wa
    _staged(fake, "skills", "s1", "a")
    d = I.detail("skills", "s1")
    assert d["id"] == "s1"
    assert "+new line" in d["diff"]


def test_detail_of_a_missing_record(fake_wa):
    assert I.detail("skills", "nope") is None


def test_rejecting_discards_the_record(store, fake_wa):
    fake, _ = fake_wa
    _staged(fake, "skills", "s1", "a")
    ok, _ = I.reject("skills", "s1")
    assert ok
    assert fake.list_pending("skills") == []


def test_approving_a_vanished_record_fails_cleanly(fake_wa):
    ok, msg = I.approve("skills", "gone")
    assert not ok and "不在" in msg


# ---- background review log ------------------------------------------------

def test_a_review_pass_is_recorded(store):
    I.record_review(store, ["saved memory: prefers pnpm",
                            "patched skill: git-workflow"], now=lambda: 1.0)
    rows = I.read_review_log(store)
    assert len(rows) == 1
    assert rows[0]["actions"][0].startswith("saved memory")


def test_an_empty_pass_is_not_recorded(store):
    """Nothing happened is not an event worth a line."""
    I.record_review(store, [])
    assert I.read_review_log(store) == []


def test_the_log_is_newest_first_and_capped(store):
    for i in range(60):
        I.record_review(store, [f"action {i}"], now=lambda i=i: float(i))
    rows = I.read_review_log(store, limit=10)
    assert len(rows) == 10
    assert rows[0]["actions"] == ["action 59"]


def test_a_torn_log_line_is_skipped(store):
    I.record_review(store, ["good"], now=lambda: 1.0)
    p = I.review_log_path(store)
    p.write_text(p.read_text() + '{"at": 2.0, "actions": ["half\n', encoding="utf-8")
    assert [r["actions"] for r in I.read_review_log(store)] == [["good"]]


def test_the_recorder_wraps_the_summariser_and_keeps_its_return(store, monkeypatch):
    """Upstream prints the summary once and drops it. Wrapping must persist it
    without changing what the caller receives."""
    br = types.ModuleType("agent.background_review")

    def summarize(review_messages, prior_snapshot, notification_mode="on"):
        return ["saved memory: x"]
    br.summarize_background_review_actions = summarize

    agent_pkg = sys.modules.get("agent") or types.ModuleType("agent")
    agent_pkg.background_review = br
    monkeypatch.setitem(sys.modules, "agent", agent_pkg)
    monkeypatch.setitem(sys.modules, "agent.background_review", br)

    ok, why = I.install_review_recorder(store)
    assert ok, why

    out = br.summarize_background_review_actions([], [])

    assert out == ["saved memory: x"], "the wrapper changed the caller's result"
    assert I.read_review_log(store)[0]["actions"] == ["saved memory: x"]


def test_the_recorder_is_idempotent(store, monkeypatch):
    br = types.ModuleType("agent.background_review")
    br.summarize_background_review_actions = lambda *a, **kw: []
    agent_pkg = sys.modules.get("agent") or types.ModuleType("agent")
    agent_pkg.background_review = br
    monkeypatch.setitem(sys.modules, "agent", agent_pkg)
    monkeypatch.setitem(sys.modules, "agent.background_review", br)

    I.install_review_recorder(store)
    first = br.summarize_background_review_actions
    ok, why = I.install_review_recorder(store)
    assert ok and why == "already installed"
    assert br.summarize_background_review_actions is first
