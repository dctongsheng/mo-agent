# Vendored: hermes-agent self-evolution (GEPA skills pipeline)

Source: https://github.com/NousResearch/hermes-agent-self-evolution
License: MIT (Nous Research) — see `evolution/LICENSE`
Vendored under `evolution/` so the desktop gateway can run skill evolution
without requiring a user-side clone.

Attribution for this component is recorded in the top-level `NOTICE` and
`THIRD_PARTY_LICENSES/README.md`. The local patches below are Dougo's
work and are likewise MIT-licensed.

Local patches (see git history):
- `core/dataset_builder.py`: robust JSON salvage parser for non-GPT eval models
- `skills/skill_module.py`: skill text is the optimizable signature instruction;
  `skill_text` reads the evolved instruction back out. `forward()` also carries
  `skill_text` on the returned Prediction — a DSPy metric is only handed
  `(gold, pred, ...)`, so without it the LLM judge cannot see which skill
  produced the output and cannot score procedure-following
- `skills/evolve_skill.py`: GEPA call updated for dspy>=3.2 (feedback metric,
  reflection_lm, budget via max_metric_calls); structure validated on the
  reassembled skill (with frontmatter), not the bare body
- `core/config.py`: `EvolutionConfig` gains tiered-judge fields (`metric_mode`,
  `judge_escalate_below`, `judge_max_calls`, `judge_cache`) and gate thresholds
  (`min_holdout`, `min_effect`, `regression_tolerance`)
- `skills/evolve_skill.py`: uses `mo_evolve.metric.TieredMetric` instead of the
  bag-of-words heuristic (upstream imports `LLMJudge` and never instantiates
  it); scores the holdout per-example rather than mean-only so the gate can run
  a *paired* test; evaluates the regression pin set; runs the diff-scoped
  safety scan as two extra constraints; writes `gate.json` / `safety.json` and
  a `fitness` block into `metrics.json`
- `core/config.py`: `critic_model` — the cross-model reviewer. Empty disables
  the review rather than running a same-model rubber stamp
- `skills/evolve_skill.py`: `--critic-model` flag and a post-optimization
  critique written to `critic.json`; `trajectory` / `mixed` eval sources that
  mine Mo's own chat log; dataset provenance recorded in `metrics.json`

Every `mo_evolve` import in this tree is guarded:

    try:
        from mo_evolve.metric import TieredMetric as _TieredMetric
    except ImportError:
        _TieredMetric = None   # fall back to the upstream heuristic

so the engine still runs — and CI's import smoke test still passes — with only
`server/vendor` on the path. The gateway puts `server/` on `PYTHONPATH` when it
spawns a run; if that ever breaks, runs silently degrade to the heuristic rather
than crashing, and `metrics.json` records `metric_mode: "heuristic"`.

Upstream's phases 2–5 (tool descriptions, system prompt, tool code, continuous
monitor) are empty `__init__.py` stubs upstream and are not implemented here.
Phase 4 in particular relies on the Darwinian Evolver, which is **AGPL v3** —
do not import, vendor, or port it.

Runtime dependency (install into the gateway venv):
    pip install "dspy>=3.0.0"
Eval/optimizer models route through DSPy→LiteLLM at an OpenAI-compatible
endpoint (OPENAI_API_BASE / OPENAI_API_KEY).
