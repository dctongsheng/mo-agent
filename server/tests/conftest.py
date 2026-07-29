"""Shared fixtures for the evolution tests.

Two rules these fixtures exist to enforce:

1. **No test touches the network.** Anything that would call an LLM goes
   through ``fake_lm`` / ``FakeJudge``, which replay canned responses.
2. **No test touches the real ``~/.hermes-mo``.** ``tmp_hermes_home`` builds a
   throwaway tree with the same shape.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

# Both the Mo-original package and the vendored engine must be importable.
_SERVER = Path(__file__).resolve().parent.parent
for _p in (str(_SERVER), str(_SERVER / "vendor")):
    if _p not in sys.path:
        sys.path.insert(0, _p)


SKILL_TEMPLATE = """---
name: {name}
description: {description}
---

{body}
"""


def write_skill(root: Path, name: str, body: str = "Do the thing.",
                description: str = "A test skill.") -> Path:
    """Create ``<root>/skills/<name>/SKILL.md`` and return its path."""
    d = root / "skills" / name
    d.mkdir(parents=True, exist_ok=True)
    p = d / "SKILL.md"
    p.write_text(
        SKILL_TEMPLATE.format(name=name, description=description, body=body),
        encoding="utf-8",
    )
    return p


@pytest.fixture
def tmp_hermes_home(tmp_path: Path, monkeypatch) -> Path:
    """A throwaway ``~/.hermes-mo`` with the directory shape the gateway expects."""
    home = tmp_path / "hermes-mo"
    (home / "skills").mkdir(parents=True)
    (home / "trajectories").mkdir(parents=True)
    (home / "profiles" / "ye-mao-evolve" / "evolve").mkdir(parents=True)
    monkeypatch.setenv("HERMES_HOME", str(home))
    # get_hermes_agent_path() raises FileNotFoundError when it can't discover a
    # repo, which would break EvolutionConfig construction at import-of-default
    # time. Point it at the sandbox.
    monkeypatch.setenv("HERMES_AGENT_REPO", str(home))
    # Keep bundled-skill detection from scanning a developer's real install and
    # misclassifying fixture skills as built-in.
    monkeypatch.setenv("HERMES_AGENT_ROOT", str(tmp_path / "no-such-agent"))
    return home


@pytest.fixture
def store(tmp_hermes_home: Path):
    from mo_evolve.store import EvolveStore
    return EvolveStore(tmp_hermes_home)


@pytest.fixture
def make_skill(tmp_hermes_home: Path):
    """Factory: ``make_skill("arxiv", body="...")`` → Path to its SKILL.md."""
    def _make(name: str, **kw) -> Path:
        return write_skill(tmp_hermes_home, name, **kw)
    return _make


class FakeJudge:
    """Stand-in for ``evolution.core.fitness.LLMJudge``.

    Records every call so tests can assert *whether* the judge was consulted —
    which is the whole point of the tiered metric — and can be told to raise so
    the failure-containment path is exercised.
    """

    def __init__(self, score=0.8, feedback="judge says: tighten the procedure",
                 raises: BaseException | None = None):
        self.calls: list[dict] = []
        self._score = score
        self._feedback = feedback
        self._raises = raises

    def score(self, task_input, expected_behavior, agent_output, skill_text,
              artifact_size=None, max_size=None):
        self.calls.append({
            "task_input": task_input,
            "expected_behavior": expected_behavior,
            "agent_output": agent_output,
            "skill_text": skill_text,
            "artifact_size": artifact_size,
            "max_size": max_size,
        })
        if self._raises is not None:
            raise self._raises
        from evolution.core.fitness import FitnessScore
        # Distribute the requested composite across the three dimensions so
        # composite == self._score exactly (weights sum to 1.0, no penalty).
        return FitnessScore(
            correctness=self._score,
            procedure_following=self._score,
            conciseness=self._score,
            length_penalty=0.0,
            feedback=self._feedback,
        )

    @property
    def call_count(self) -> int:
        return len(self.calls)


@pytest.fixture
def fake_judge():
    return FakeJudge


class _Obj:
    """Minimal duck-type for a dspy.Example / dspy.Prediction in metric tests."""

    def __init__(self, **kw):
        self.__dict__.update(kw)


@pytest.fixture
def gold():
    def _gold(task_input="do it", expected_behavior="alpha beta gamma delta"):
        return _Obj(task_input=task_input, expected_behavior=expected_behavior)
    return _gold


@pytest.fixture
def pred():
    def _pred(output="alpha beta gamma delta", skill_text="SKILL BODY"):
        return _Obj(output=output, skill_text=skill_text)
    return _pred
