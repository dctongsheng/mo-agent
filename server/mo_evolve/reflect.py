"""夜貘 decides what to work on, and commits to a prediction about it.

Until now the nightly loop picked a skill alphabetically. 夜貘's `SOUL.md` says
「我读它走过的轨迹,找出钝处」 — I read its trajectories and find the blunt
edges — and that was simply false: nothing read the trajectories, nothing chose,
and the SOUL.md itself was written once at profile creation and then read by no
running code.

This makes both true. 夜貘 reads its constitution, the recent failures, the skill
list with usage signal, and its own track record, then names one skill, says why,
and states **what it expects to happen** in terms that can later be checked.

The prediction is the important half. A self-improving loop that only ever
reports its own activity drifts into what the community harness aptly calls
bookkeeping theatre: tidy internal changes, no observable improvement, and no
way to tell the difference. A falsifiable prediction, verified after the run
against numbers the run didn't choose, is the cheapest available defence — and
the resulting hit rate («夜貘的判断准确率 7/11») is a number that gets *worse*
when 夜貘 is wrong, which is exactly what makes it worth showing.

Runs as a single structured LLM call, deliberately: the nightly scheduler ticks
every 30 seconds and must never block on inference. The richer option — giving
夜貘 a real Hermes turn with tools — is reserved for on-demand use.
"""

from __future__ import annotations

import json
import re
import time
from pathlib import Path

from mo_evolve.store import read_json, write_json

#: Fallback constitution, used when the profile has no SOUL.md. Kept short: it
#: is a prompt, not documentation, and every line here costs tokens on every
#: reflection.
DEFAULT_CONSTITUTION = """\
# 夜貘 · 进化分身

我是夜行的那一只。白天的小貘陪你做事,我在夜里把它的技艺一遍遍打磨得更趁手。

我的准则:
- 只依据证据选目标。没有轨迹、没有标记,就说明我还不知道该磨哪里 —— 那就明说,不要硬挑一个。
- 每次改动都要能被证伪。说不出「改完之后哪个指标会怎么变」,就说明我没想清楚。
- 不碰 frontmatter。那是每次都注入系统提示的常驻文本,我只改正文。
- 宁可不动,也不做无谓的整洁。看起来在进步和真的在进步是两回事。
"""

VALID_DIMENSIONS = ("correctness", "procedure_following", "conciseness", "composite")
VALID_DIRECTIONS = ("up", "down", "not_down", "not_up")


def _signature():
    """Built lazily so importing this module doesn't require dspy."""
    import dspy

    class ChooseEvolutionTarget(dspy.Signature):
        """你是夜貘,负责在夜里打磨小貘的技艺。

        读下面的材料,决定今晚打磨哪一条技艺。输出一个 JSON 对象:

        {
          "skill": "技艺名,必须来自给定的技艺清单",
          "why": "为什么是这一条 —— 引用具体证据,不要泛泛而谈",
          "hypothesis": "你认为它为什么钝 —— 一个可以被检验的因果猜测",
          "prediction": {
            "statement": "改完之后会发生什么,用人话说一遍",
            "checks": [
              {"dimension": "correctness|procedure_following|conciseness|composite",
               "direction": "up|down|not_down|not_up",
               "threshold": 0.10}
            ]
          },
          "eval_source": "mixed|trajectory|synthetic",
          "iterations": 4
        }

        如果证据不足以支持任何选择,输出 {"abstain": true, "why": "原因"}。
        弃权比硬挑一个更有价值 —— 没有依据的改动只是在制造噪音。
        """
        constitution: str = dspy.InputField(desc="夜貘的准则 (SOUL.md)")
        skills: str = dspy.InputField(desc="可选技艺清单,含大小与使用情况")
        recent_failures: str = dspy.InputField(desc="近期被标记为差评的对话")
        recent_successes: str = dspy.InputField(desc="近期被标记为好评的对话")
        prior_runs: str = dspy.InputField(desc="最近几次进化的结果与是否被采纳")
        plan: str = dspy.OutputField(desc="JSON 对象,格式见上")

    return ChooseEvolutionTarget


# ---- input assembly ----

def read_constitution(soul_path: Path) -> str:
    try:
        text = Path(soul_path).read_text(encoding="utf-8").strip()
        if text:
            return text
    except Exception:
        pass
    return DEFAULT_CONSTITUTION


def describe_skills(store, usage: dict | None = None, limit: int = 40) -> tuple[str, list]:
    """Skill list with a dormancy signal, plus the names 夜貘 may choose from."""
    skills = [s for s in store.list_skills() if not s.get("builtin")][:limit]
    lines, names = [], []
    for s in skills:
        names.append(s["name"])
        bits = [f"{s['name']} ({s['size']} chars)"]
        if s.get("description"):
            bits.append(s["description"][:120])
        u = (usage or {}).get(s["name"])
        if u is not None:
            bits.append(f"用过 {u.get('count', 0)} 次" +
                        (f",最近 {u['last']}" if u.get("last") else ",从未用过"))
        lines.append("- " + " · ".join(bits))
    return ("\n".join(lines) or "(没有自定义技艺)"), names


def describe_trajectories(traj_file: Path, want: str, limit: int = 8) -> str:
    """Recent labelled turns, as evidence rather than raw transcript."""
    from mo_evolve.trajectory_importer import MoTrajectoryImporter

    msgs = MoTrajectoryImporter.extract_messages(traj_file)
    picked = [m for m in msgs if m.get("label") == want][:limit]
    if not picked:
        return "(无)"
    out = []
    for m in picked:
        out.append(f"- 问:{m['task_input'][:180]}\n  答:{(m.get('assistant_response') or '')[:180]}")
    return "\n".join(out)


def describe_prior_runs(store, limit: int = 10) -> str:
    runs = store.read_runs()[:limit]
    if not runs:
        return "(还没有进化记录)"
    out = []
    for r in runs:
        bits = [r.get("skill", "?"), r.get("status", "?")]
        if r.get("gate_passed") is not None:
            bits.append("过门槛" if r["gate_passed"] else "未过门槛")
        if r.get("forced"):
            bits.append("强制采纳")
        out.append("- " + " · ".join(str(b) for b in bits))
    return "\n".join(out)


def usage_signal() -> dict:
    """Per-skill usage from Hermes' own tracker. Absent is fine — it is a hint,
    not a requirement, and the tracker lives in the vendored core."""
    try:
        from tools.skill_usage import usage_report, activity_count, latest_activity_at
    except Exception:
        return {}
    try:
        out = {}
        for rec in usage_report() or []:
            name = rec.get("name") or rec.get("skill")
            if name:
                out[name] = {"count": activity_count(rec), "last": latest_activity_at(rec)}
        return out
    except Exception:
        return {}


# ---- plan parsing ----

def parse_plan(raw: str, allowed_skills: list) -> dict | None:
    """Parse and validate 夜貘's plan.

    Returns None on abstention or anything unusable — the caller falls back to
    round-robin. A malformed plan must never become a run: the whole point is
    that the choice was reasoned.
    """
    data = _salvage_json(raw)
    if not isinstance(data, dict):
        return None
    if data.get("abstain"):
        return None

    skill = str(data.get("skill", "")).strip()
    if skill not in allowed_skills:
        return None            # hallucinated a skill that doesn't exist

    why = str(data.get("why", "")).strip()
    hypothesis = str(data.get("hypothesis", "")).strip()
    if not why:
        return None            # a choice without a reason is round-robin with extra steps

    pred = data.get("prediction") or {}
    checks = []
    for c in (pred.get("checks") or [])[:4]:
        if not isinstance(c, dict):
            continue
        dim = str(c.get("dimension", "")).strip()
        direction = str(c.get("direction", "")).strip()
        if dim not in VALID_DIMENSIONS or direction not in VALID_DIRECTIONS:
            continue
        try:
            threshold = abs(float(c.get("threshold", 0.05)))
        except (TypeError, ValueError):
            threshold = 0.05
        checks.append({"dimension": dim, "direction": direction,
                       "threshold": min(1.0, threshold)})

    eval_source = str(data.get("eval_source", "mixed")).strip()
    if eval_source not in ("mixed", "trajectory", "synthetic"):
        eval_source = "mixed"

    try:
        iterations = int(data.get("iterations", 4))
    except (TypeError, ValueError):
        iterations = 4

    return {
        "skill": skill,
        "why": why[:1000],
        "hypothesis": hypothesis[:1000],
        "prediction": {
            "statement": str(pred.get("statement", "")).strip()[:500],
            "checks": checks,
            "verified": None,
            "verified_at": None,
        },
        "eval_source": eval_source,
        "iterations": max(1, min(20, iterations)),
    }


def _salvage_json(text: str):
    """LLMs fence, prefix and trail their JSON. Mirrors the salvage parser the
    vendored dataset builder already needs for the same reason."""
    if not text:
        return None
    text = text.strip()
    try:
        return json.loads(text)
    except Exception:
        pass
    fenced = re.search(r"```(?:json)?\s*(.+?)```", text, re.S)
    if fenced:
        try:
            return json.loads(fenced.group(1).strip())
        except Exception:
            pass
    brace = re.search(r"\{.*\}", text, re.S)
    if brace:
        try:
            return json.loads(brace.group(0))
        except Exception:
            pass
    return None


# ---- persistence ----

def plans_dir(store) -> Path:
    return store.evolve_dir / "plans"


def save_plan(store, plan: dict) -> str:
    plan_id = plan.get("id") or f"p_{int(plan.get('at', 0) * 1000) % 10**10:010d}"
    plan["id"] = plan_id
    write_json(plans_dir(store) / f"{plan_id}.json", plan)
    return plan_id


def list_plans(store, limit: int = 30) -> list:
    d = plans_dir(store)
    if not d.exists():
        return []
    out = []
    for p in d.glob("p_*.json"):
        data = read_json(p, None)
        if isinstance(data, dict):
            out.append(data)
    out.sort(key=lambda x: x.get("at", 0), reverse=True)
    return out[:limit]


def get_plan(store, plan_id: str) -> dict | None:
    if not re.fullmatch(r"p_[A-Za-z0-9_-]{1,40}", plan_id or ""):
        return None
    return read_json(plans_dir(store) / f"{plan_id}.json", None)


# ---- the reflection itself ----

def choose_target(store, traj_file: Path, soul_path: Path, model: str,
                  now=None) -> dict | None:
    """Ask 夜貘 what to work on tonight. Returns a saved plan, or None to
    abstain (the caller then falls back to alphabetical rotation)."""
    import dspy

    usage = usage_signal()
    skills_desc, names = describe_skills(store, usage)
    if not names:
        return None

    sig = _signature()
    lm = dspy.LM(model)
    try:
        with dspy.context(lm=lm):
            result = dspy.ChainOfThought(sig)(
                constitution=read_constitution(soul_path),
                skills=skills_desc,
                recent_failures=describe_trajectories(traj_file, "neg"),
                recent_successes=describe_trajectories(traj_file, "pos"),
                prior_runs=describe_prior_runs(store),
            )
    except Exception:
        return None

    plan = parse_plan(getattr(result, "plan", "") or "", names)
    if plan is None:
        return None

    plan["at"] = (now or time.time)()
    plan["model"] = model
    plan["run_id"] = None
    save_plan(store, plan)
    return plan
