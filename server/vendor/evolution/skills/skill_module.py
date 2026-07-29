"""Wraps a SKILL.md file as a DSPy module for optimization.

The key abstraction: a skill file becomes a parameterized DSPy module
where the skill text is the optimizable parameter. GEPA can then
mutate the skill text and evaluate the results.
"""

import re
from pathlib import Path
from typing import Optional

import dspy


def load_skill(skill_path: Path) -> dict:
    """Load a skill file and parse its frontmatter + body.

    Returns:
        {
            "path": Path,
            "raw": str (full file content),
            "frontmatter": str (YAML between --- markers),
            "body": str (markdown after frontmatter),
            "name": str,
            "description": str,
        }
    """
    raw = skill_path.read_text()

    # Parse YAML frontmatter
    frontmatter = ""
    body = raw
    if raw.strip().startswith("---"):
        parts = raw.split("---", 2)
        if len(parts) >= 3:
            frontmatter = parts[1].strip()
            body = parts[2].strip()

    # Extract name and description from frontmatter
    name = ""
    description = ""
    for line in frontmatter.split("\n"):
        if line.strip().startswith("name:"):
            name = line.split(":", 1)[1].strip().strip("'\"")
        elif line.strip().startswith("description:"):
            description = line.split(":", 1)[1].strip().strip("'\"")

    return {
        "path": skill_path,
        "raw": raw,
        "frontmatter": frontmatter,
        "body": body,
        "name": name,
        "description": description,
    }


def find_skill(skill_name: str, hermes_agent_path: Path) -> Optional[Path]:
    """Find a skill by name in the hermes-agent skills directory.

    Searches recursively for a SKILL.md in a directory matching the skill name.
    """
    skills_dir = hermes_agent_path / "skills"
    if not skills_dir.exists():
        return None

    # Direct match: skills/<category>/<skill_name>/SKILL.md
    for skill_md in skills_dir.rglob("SKILL.md"):
        if skill_md.parent.name == skill_name:
            return skill_md

    # Fuzzy match: check the name field in frontmatter
    for skill_md in skills_dir.rglob("SKILL.md"):
        try:
            content = skill_md.read_text()[:500]
            if f"name: {skill_name}" in content or f'name: "{skill_name}"' in content:
                return skill_md
        except Exception:
            continue

    return None


def _get_instructions(predictor) -> str:
    """Read current signature instructions from a (possibly optimized)
    predictor, across DSPy layouts (ChainOfThought wraps an inner predict)."""
    for obj in (predictor, getattr(predictor, "predict", None)):
        sig = getattr(obj, "signature", None)
        if sig is not None and getattr(sig, "instructions", None):
            return sig.instructions
    return ""


class SkillModule(dspy.Module):
    """A DSPy module that wraps a skill file for optimization.

    The skill *body* is placed as the predictor's signature **instructions** —
    exactly the parameter GEPA / MIPROv2 mutate. After compile(), ``skill_text``
    reads the (evolved) instructions back out, so the optimizer truly changes
    the skill rather than an inert attribute.
    """

    class TaskWithSkill(dspy.Signature):
        task_input: str = dspy.InputField(desc="The task to complete")
        output: str = dspy.OutputField(desc="Your response following the skill instructions")

    def __init__(self, skill_text: str):
        super().__init__()
        sig = self.TaskWithSkill.with_instructions(skill_text)
        self.predictor = dspy.ChainOfThought(sig)

    @property
    def skill_text(self) -> str:
        return _get_instructions(self.predictor)

    def forward(self, task_input: str) -> dspy.Prediction:
        result = self.predictor(task_input=task_input)
        # Mo local patch: carry the candidate's current skill text on the
        # prediction. A DSPy metric is only handed (gold, pred, trace, ...) —
        # without this the LLM judge cannot see which skill produced the output
        # and cannot score procedure-following or apply a length penalty.
        return dspy.Prediction(
            output=getattr(result, "output", ""),
            skill_text=self.skill_text,
        )


def reassemble_skill(frontmatter: str, evolved_body: str) -> str:
    """Reassemble a skill file from frontmatter and evolved body.

    Preserves the original YAML frontmatter (name, description, metadata)
    and replaces only the body with the evolved version.
    """
    return f"---\n{frontmatter}\n---\n\n{evolved_body}\n"
