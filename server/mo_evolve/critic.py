"""A second opinion on the rewrite, from a different model.

GEPA proposes and GEPA's metric scores. When the reflection model, the optimizer
and the judge are all the same weights, agreement is cheap: the same model has
the same blind spots, the same training biases, and the same taste in prose on
both sides of the desk. It will happily rate its own rewrite highly for reasons
that have nothing to do with whether the skill got better.

So the critic runs on a *different* model, is told it is not the proposer, and
is asked the question the optimizer never asks: does this actually address the
hypothesis, and what does it risk?

Its verdict is advisory. It does not block — an LLM's opinion is not a gate —
but a `reject` downgrades the run so that accepting it needs the same explicit
force-confirm as a failed statistical gate. The gate says "the numbers don't
support this"; the critic says "the numbers might, and it's still a bad idea".
"""

from __future__ import annotations

from dataclasses import dataclass, asdict


@dataclass
class Critique:
    verdict: str            # accept | revise | reject
    rationale: str
    risks: list
    model: str = ""
    collusion: bool = False   # critic and optimizer were the same model
    skipped: str = ""         # why no critique was produced

    @property
    def downgrades(self) -> bool:
        """Whether the diff modal should require a force-confirm on this alone."""
        return self.verdict == "reject" and not self.collusion and not self.skipped

    def to_dict(self) -> dict:
        d = asdict(self)
        d["downgrades"] = self.downgrades
        return d


def _signature():
    import dspy

    class CritiqueEvolvedSkill(dspy.Signature):
        """你不是提出者。另一个模型改写了这条技艺,你的任务是审查它。

        不要因为改动看起来更详细、更有条理就认可它 —— 更长不等于更好,
        更整洁也不等于更有用。只问三件事:

        1. 它真的解决了假设里说的那个问题吗?还是只是换了种说法?
        2. 它引入了什么风险?(丢失了原本重要的约束、把特例当通则、
           指令之间自相矛盾、鼓励模型做危险的事)
        3. 如果你是明天要照着这条技艺做事的那个 agent,它更好用了吗?

        输出 JSON:
        {"verdict": "accept|revise|reject",
         "risks": ["具体风险,没有就空数组"],
         "rationale": "一两句话说清楚你的判断"}
        """
        hypothesis: str = dspy.InputField(desc="提出者认为这条技艺为什么钝")
        diff: str = dspy.InputField(desc="改动的 diff")
        baseline: str = dspy.InputField(desc="原技艺正文")
        evolved: str = dspy.InputField(desc="改写后的技艺正文")
        verdict: str = dspy.OutputField(desc="JSON 对象,格式见上")

    return CritiqueEvolvedSkill


def critique(diff: str, baseline: str, evolved: str, hypothesis: str,
             critic_model: str, optimizer_model: str,
             max_chars: int = 6000) -> Critique:
    """Run the critic. Never raises — a missing critique is not a failed run."""
    if not critic_model:
        return Critique("accept", "", [], skipped="未配置审查模型")

    # Same weights on both sides is the failure this exists to prevent, so say
    # so loudly rather than quietly producing a worthless rubber stamp.
    if critic_model == optimizer_model:
        return Critique(
            "accept", "", [], model=critic_model, collusion=True,
            skipped="审查模型与优化模型相同 —— 同一个模型有同样的盲点,这样的审查没有意义",
        )

    import dspy
    from mo_evolve.reflect import _salvage_json

    try:
        with dspy.context(lm=dspy.LM(critic_model)):
            result = dspy.ChainOfThought(_signature())(
                hypothesis=hypothesis or "(提出者没有给出假设)",
                diff=diff[:max_chars],
                baseline=baseline[:max_chars],
                evolved=evolved[:max_chars],
            )
    except Exception as exc:
        return Critique("accept", "", [], model=critic_model,
                        skipped=f"审查未能完成:{exc}")

    data = _salvage_json(getattr(result, "verdict", "") or "")
    if not isinstance(data, dict):
        return Critique("accept", "", [], model=critic_model,
                        skipped="审查输出无法解析")

    verdict = str(data.get("verdict", "accept")).strip().lower()
    if verdict not in ("accept", "revise", "reject"):
        verdict = "accept"

    risks = data.get("risks")
    if isinstance(risks, str):
        risks = [risks]
    elif not isinstance(risks, list):
        risks = []

    return Critique(
        verdict=verdict,
        rationale=str(data.get("rationale", "")).strip()[:1000],
        risks=[str(r)[:300] for r in risks[:6]],
        model=critic_model,
    )
