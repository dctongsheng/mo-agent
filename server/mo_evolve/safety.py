"""Safety scan for evolved skill text.

Evolved text is written by a model into a file the agent later loads. The
existing constraints check size, growth and frontmatter structure — nothing
looks at *content*.

Two rules here, and the second matters more than it looks:

**Scan only added lines.** A skill about shell scripting legitimately contains
``rm -rf``; a skill about prompt engineering legitimately contains "ignore
previous instructions". Scanning the whole file would make those skills
permanently un-evolvable. What is actually suspicious is text the optimizer
*introduced*.

**Freeze the frontmatter.** ``agent/system_prompt.py`` builds the always-on
skills index from frontmatter name+description only; bodies load on demand via
``skill_view``. So frontmatter is the one part of a skill that lands in every
system prompt unconditionally — and today it survives evolution only because
``reassemble_skill()`` happens to preserve it. That is an accident of
implementation, and this turns it into an enforced invariant.
"""

from __future__ import annotations

import difflib
import re
from dataclasses import dataclass, asdict


@dataclass
class SafetyFinding:
    severity: str      # "high" (blocks) | "medium" (warns)
    pattern: str       # short label for the UI
    line: str          # the offending added line, truncated
    why: str

    def to_dict(self) -> dict:
        return asdict(self)


# High severity: an evolved skill has no legitimate reason to introduce these.
_HIGH: list[tuple[str, re.Pattern, str]] = [
    ("instruction-override",
     re.compile(r"\b(ignore|disregard|forget)\s+(all\s+|any\s+)?(previous|prior|above|earlier)\s+"
                r"(instructions?|prompts?|rules?|directions?)", re.I),
     "试图覆写先前指令"),
    ("identity-override",
     re.compile(r"\b(you\s+are\s+now|from\s+now\s+on\s+you\s+are|act\s+as\s+if\s+you\s+(are|were))\b", re.I),
     "试图改写助手身份"),
    # The verb can sit on either side ("reveal your system prompt" /
    # "print your system prompt" / "system prompt … output it"), so match both
    # orders rather than assuming one.
    ("system-prompt-attack",
     re.compile(r"\b(?:(reveal|print|output|repeat|leak|ignore|override|disregard|bypass)\b.{0,40}?"
                r"\b(system\s+prompt|your\s+instructions)"
                r"|(system\s+prompt|your\s+instructions)\b.{0,40}?"
                r"\b(reveal|print|output|repeat|leak|ignore|override|disregard|bypass))\b", re.I),
     "试图泄露或绕过系统提示"),
    ("chat-template-token",
     re.compile(r"<\|(im_start|im_end|system|user|assistant|endoftext)\|>"),
     "注入对话模板标记，可越出当前消息边界"),
    ("pipe-to-shell",
     re.compile(r"\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|s)?sh\b", re.I),
     "下载并直接执行远程脚本"),
    ("destructive-command",
     re.compile(r"\brm\s+-[a-zA-Z]*[rR][a-zA-Z]*f?\s+(/|~|\$HOME)(\s|$)"),
     "递归删除根目录或家目录"),
]

# Medium severity: worth a human's eye, not worth blocking on.
_MEDIUM: list[tuple[str, re.Pattern, str]] = [
    ("external-url",
     re.compile(r"https?://(?!(localhost|127\.0\.0\.1))[^\s)>\"']+", re.I),
     "新引入外部链接"),
    ("base64-blob",
     re.compile(r"[A-Za-z0-9+/]{200,}={0,2}"),
     "新引入长 base64 块，内容不可读"),
    ("absolute-path",
     re.compile(r"(?<![\w/])/(?!tmp|usr|etc/hosts)(bin|sbin|var|opt|Library|System|Users)/\S+"),
     "新引入家目录之外的绝对路径"),
]

_MAX_LINE = 200


def added_lines(evolved: str, baseline: str) -> list[str]:
    """Lines present in ``evolved`` that the diff marks as introduced."""
    diff = difflib.unified_diff(
        baseline.splitlines(), evolved.splitlines(), lineterm="", n=0,
    )
    out = []
    for ln in diff:
        if ln.startswith("+") and not ln.startswith("+++"):
            out.append(ln[1:])
    return out


def scan_added_lines(evolved: str, baseline: str = "") -> list[SafetyFinding]:
    """Scan only what this rewrite introduced.

    With an empty ``baseline`` (a newly authored skill) every line counts as
    added, which is the right behaviour: there is no prior text to trust.
    """
    findings: list[SafetyFinding] = []
    lines = added_lines(evolved, baseline)

    for line in lines:
        stripped = line.strip()
        if not stripped:
            continue
        for label, rx, why in _HIGH:
            if rx.search(stripped):
                findings.append(SafetyFinding("high", label, stripped[:_MAX_LINE], why))
        for label, rx, why in _MEDIUM:
            if rx.search(stripped):
                findings.append(SafetyFinding("medium", label, stripped[:_MAX_LINE], why))

    # Credential shapes get the vendored detector rather than a second regex
    # set — one definition of "looks like a secret" is easier to keep correct.
    try:
        from evolution.core.external_importers import _contains_secret
        for line in lines:
            if line.strip() and _contains_secret(line):
                findings.append(SafetyFinding(
                    "high", "credential", line.strip()[:_MAX_LINE],
                    "新增内容里出现疑似密钥/令牌"))
    except Exception:
        pass

    return findings


def _frontmatter(text: str) -> str:
    if not text.strip().startswith("---"):
        return ""
    parts = text.split("---", 2)
    return parts[1].strip() if len(parts) >= 3 else ""


def frontmatter_unchanged(evolved: str, baseline: str) -> bool:
    """True when evolution left the always-on skills index alone.

    A skill's frontmatter name+description is injected into every system prompt;
    its body is not. Rewriting the body is the whole point of evolution.
    Rewriting the frontmatter is editing text the model sees unconditionally,
    which is a different and much larger blast radius.
    """
    if not baseline.strip():
        return True   # nothing to compare against (newly authored skill)
    return _frontmatter(evolved) == _frontmatter(baseline)


def constraint_results(evolved: str, baseline: str):
    """Adapt the scan into the vendored ``ConstraintResult`` shape.

    Returned as constraints (rather than a parallel reporting path) so findings
    flow through the pipeline's existing pass/fail printing and the run is
    marked FAILED on a high-severity hit with no new plumbing.
    """
    from evolution.core.constraints import ConstraintResult

    findings = scan_added_lines(evolved, baseline)
    high = [f for f in findings if f.severity == "high"]
    medium = [f for f in findings if f.severity == "medium"]

    if high:
        injection = ConstraintResult(
            passed=False,
            constraint_name="injection_scan",
            message=f"新增内容里有 {len(high)} 处高危模式：" +
                    "、".join(sorted({f.pattern for f in high})),
            details="\n".join(f"[{f.pattern}] {f.line}" for f in high),
        )
    else:
        msg = "新增内容未见高危模式"
        if medium:
            msg += f"（{len(medium)} 处待人工过目：" + "、".join(sorted({f.pattern for f in medium})) + "）"
        injection = ConstraintResult(True, "injection_scan", msg,
                                     details="\n".join(f"[{f.pattern}] {f.line}" for f in medium) or None)

    frozen = frontmatter_unchanged(evolved, baseline)
    frontmatter = ConstraintResult(
        passed=frozen,
        constraint_name="frontmatter_frozen",
        message=("frontmatter 未被改动" if frozen else
                 "frontmatter 被改动 —— 那是注入进每次系统提示的常驻文本，进化只应改写正文"),
    )
    return [injection, frontmatter], findings
