"""Mo-original self-evolution logic for the 夜貘 (ye-mao-evolve) sub-agent.

This package holds everything Mo adds on top of the vendored GEPA engine in
``server/vendor/evolution``: run/schedule state, the tiered LLM-judge metric,
the statistical acceptance gate, the safety scan, and the versioned skill
archive.

Why it lives here rather than in ``mo-gateway.py``: that file's name contains a
hyphen, so it cannot be imported, and all of its evolution logic sits inside a
single ``_mount_mo_routes(app)`` closure. Nothing in it can be unit-tested. Code
in this package is importable and covered by ``server/tests``.

Why it is not folded into ``server/vendor/evolution``: that tree is vendored
from NousResearch/hermes-agent-self-evolution and is kept close to upstream so
it stays re-vendorable. Vendored files import from here defensively::

    try:
        from mo_evolve.metric import TieredMetric
    except ImportError:
        TieredMetric = None   # fall back to the upstream heuristic

so the engine keeps working — and keeps passing CI's import smoke test — when
this package is not on the path.
"""

__all__ = ["store", "gate", "metric", "safety", "skill_archive"]
