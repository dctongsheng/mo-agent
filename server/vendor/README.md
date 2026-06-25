# Vendored: hermes-agent self-evolution (GEPA skills pipeline)

Source: https://github.com/NousResearch/hermes-agent-self-evolution
Vendored under `evolution/` so the desktop gateway can run skill evolution
without requiring a user-side clone.

Local patches (see git history):
- `core/dataset_builder.py`: robust JSON salvage parser for non-GPT eval models
- `skills/skill_module.py`: skill text is the optimizable signature instruction;
  `skill_text` reads the evolved instruction back out
- `skills/evolve_skill.py`: GEPA call updated for dspy>=3.2 (feedback metric,
  reflection_lm, budget via max_metric_calls); structure validated on the
  reassembled skill (with frontmatter), not the bare body

Runtime dependency (install into the gateway venv):
    pip install "dspy>=3.0.0"
Eval/optimizer models route through DSPy→LiteLLM at an OpenAI-compatible
endpoint (OPENAI_API_BASE / OPENAI_API_KEY).
