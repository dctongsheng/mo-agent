"""教它一手 — Hermes' /learn, run in a sandbox and reviewed before it lands.

Hermes can already author a skill from a directory, a URL, or the conversation
you just had. `/learn` is not a tool and not a distillation engine: it's a pure
function that builds a prompt, handed to the agent as a normal turn, after which
the model calls `skill_manage(action="create")` and writes a SKILL.md.

Three things make wiring that into Mo non-obvious.

**`-q "/learn ..."` does not work.** Slash commands are dispatched only from the
interactive REPL; the single-query path never sees them, so the text would go to
the model verbatim. The prompt has to be pre-built.

**The write must not land in the user's real skills dir.** Mo reviews before it
applies — so the turn runs against a sandbox HERMES_HOME and the result is
harvested, not trusted. The sandbox has to be shaped `<root>/profiles/<name>`:
`hermes_cli/main.py:620-623` trusts a pre-set HERMES_HOME unconditionally only
when its parent directory is literally named `profiles`, and otherwise an
`active_profile` file can redirect the run straight into the live tree.

**A staged write leaves the skills dir empty.** With `skills.write_approval` on,
`evaluate_gate` stages *every* skill write and returns `success: true` having
written nothing. Harvesting only the skills dir would silently produce an empty
draft, so both sources are read.

This is 小貘's act — foreground, user-asked — not 夜貘's. It gets its own
ledger: `describe_prior_runs()` feeds `runs.json` straight into 夜貘's
reflection prompt, and learn drafts would pollute a track record it never made.
"""

from __future__ import annotations

import json
import re
import shutil
from pathlib import Path

SANDBOX_PROFILE = "mo-learn"

#: Hard create-time limit in skill_manager_tool. Over this, the description is
#: silently truncated in the system-prompt index and the skill never routes.
MAX_DESCRIPTION = 60
MAX_CONTENT = 100_000
VALID_NAME = re.compile(r"^[a-z0-9][a-z0-9._-]*$")
MAX_NAME = 64

ALLOWED_SUBDIRS = ("references", "templates", "scripts", "assets")


# ---- prompt ---------------------------------------------------------------

def build_prompt(request: str) -> tuple[str, str]:
    """Returns (prompt, standards) where standards is 'applied'|'unavailable'.

    Reuses the vendored `build_learn_prompt`, whose `_AUTHORING_STANDARDS` block
    is the actual house style — frontmatter rules, the 60-char limit, the eight
    body sections, "name Hermes tools not shell utils". Falling back to a
    Mo-local framing without it is possible, but the UI must then say the house
    rules weren't applied rather than implying they were.
    """
    try:
        from agent.learn_prompt import build_learn_prompt
        return build_learn_prompt(request), "applied"
    except Exception:
        req = (request or "").strip() or "我们刚才走过的流程"
        return (
            "[/learn] The user wants you to learn a reusable skill from the "
            "request below, and save it.\n\n"
            f"THE REQUEST:\n{req}\n\n"
            "Author ONE SKILL.md and save it with the `skill_manage` tool "
            '(action="create"). Pick a sensible category. The frontmatter needs '
            f"`name` (lowercase-hyphenated) and `description` (ONE sentence, at "
            f"most {MAX_DESCRIPTION} characters, ending with a period).\n"
        ), "unavailable"


# ---- sandbox --------------------------------------------------------------

def sandbox_home(hermes_root: Path) -> Path:
    """`<root>/profiles/mo-learn` — the parent dir name is load-bearing."""
    return Path(hermes_root) / "profiles" / SANDBOX_PROFILE


def ensure_sandbox(hermes_root: Path) -> tuple[Path, str]:
    """Create the sandbox profile if absent. Returns (path, note)."""
    sandbox = sandbox_home(hermes_root)
    note = ""
    if not sandbox.exists():
        try:
            import sys as _sys, os as _os
            root = _os.environ.get("HERMES_AGENT_ROOT", "")
            if root and root not in _sys.path:
                _sys.path.insert(0, root)
            from hermes_cli import profiles as _P
            # clone_config carries the model/provider/.env across, so a learn
            # turn uses the same endpoint the user already configured.
            _P.create_profile(name=SANDBOX_PROFILE, clone_from="default",
                              clone_config=True)
        except Exception as exc:
            note = f"沙箱 profile 创建失败：{exc}"
            sandbox.mkdir(parents=True, exist_ok=True)
    reset_sandbox(sandbox)
    return sandbox, note


def reset_sandbox(sandbox: Path) -> None:
    """Empty the sandbox so a harvest can't pick up a previous draft.

    Clears BOTH the skills dir and the pending queue — a staged write from an
    earlier run would otherwise be harvested as this run's output.
    """
    sandbox = Path(sandbox)
    for sub in ("skills", "pending/skills"):
        d = sandbox / sub
        if d.exists():
            shutil.rmtree(d, ignore_errors=True)
    (sandbox / "skills").mkdir(parents=True, exist_ok=True)
    # Without this, a first run into an empty home seeds ~130 bundled skills and
    # the harvest can't tell them from what the turn authored.
    (sandbox / ".no-bundled-skills").write_text("", encoding="utf-8")


# ---- harvest --------------------------------------------------------------

def harvest(sandbox: Path) -> list[dict]:
    """Everything the turn authored, from both places it could be."""
    sandbox = Path(sandbox)
    drafts = _harvest_written(sandbox)
    if not drafts:
        drafts = _harvest_staged(sandbox)
    return drafts


def _harvest_written(sandbox: Path) -> list[dict]:
    out = []
    skills = sandbox / "skills"
    if not skills.exists():
        return out
    for md in sorted(skills.rglob("SKILL.md")):
        try:
            content = md.read_text(encoding="utf-8")
        except Exception:
            continue
        fm = parse_frontmatter(content)
        rel = md.parent.relative_to(skills)
        category = str(rel.parent) if len(rel.parts) > 1 else None
        out.append({
            "name": fm.get("name") or md.parent.name,
            "category": None if category in (".", "") else category,
            "description": fm.get("description", ""),
            "content": content,
            "files": _sidecar_files(md.parent),
            "staged": False,
        })
    return out


def _harvest_staged(sandbox: Path) -> list[dict]:
    """Read `pending/skills/*.json`.

    With `skills.write_approval` on, evaluate_gate stages every skill write —
    regardless of origin — and returns success having written nothing. Reading
    only the skills dir would hand back an empty draft with no error.
    """
    out = []
    pend = sandbox / "pending" / "skills"
    if not pend.exists():
        return out
    for f in sorted(pend.glob("*.json")):
        try:
            rec = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            continue
        payload = rec.get("payload") or rec
        if str(payload.get("action", "create")) != "create":
            continue
        content = payload.get("content") or ""
        fm = parse_frontmatter(content)
        out.append({
            "name": payload.get("name") or fm.get("name", ""),
            "category": payload.get("category"),
            "description": fm.get("description", ""),
            "content": content,
            "files": [],
            "staged": True,
        })
    return out


def _sidecar_files(skill_dir: Path) -> list[dict]:
    files = []
    for sub in ALLOWED_SUBDIRS:
        d = skill_dir / sub
        if not d.is_dir():
            continue
        for f in sorted(d.rglob("*")):
            if f.is_file():
                try:
                    files.append({"path": str(f.relative_to(skill_dir)),
                                  "size": f.stat().st_size})
                except Exception:
                    continue
    return files


def parse_frontmatter(text: str) -> dict:
    if not text.strip().startswith("---"):
        return {}
    parts = text.split("---", 2)
    if len(parts) < 3:
        return {}
    out = {}
    for line in parts[1].splitlines():
        if ":" in line and not line.strip().startswith("#"):
            k, v = line.split(":", 1)
            out[k.strip()] = v.strip().strip("'\"")
    return out


# ---- validation -----------------------------------------------------------

def validate_draft(draft: dict, existing: set[str]) -> list[dict]:
    """Re-check Mo-side, because a staged draft never met _create_skill's
    validators — the gate intercepts before any of them run."""
    content = draft.get("content") or ""
    fm = parse_frontmatter(content)
    name = (draft.get("name") or fm.get("name") or "").strip()
    desc = (fm.get("description") or "").strip()
    out: list[dict] = []

    if not content.strip():
        out.append({"code": "empty", "message": "草稿是空的。", "fatal": True})
        return out
    if not content.strip().startswith("---"):
        out.append({"code": "no_frontmatter",
                    "message": "缺少 YAML frontmatter。", "fatal": True})
    if not name:
        out.append({"code": "no_name", "message": "frontmatter 缺少 name。", "fatal": True})
    elif not VALID_NAME.match(name):
        out.append({"code": "bad_name",
                    "message": f"name「{name}」不合法：只能用小写字母、数字、. _ -，且以字母或数字开头。",
                    "fatal": True})
    elif len(name) > MAX_NAME:
        out.append({"code": "name_too_long",
                    "message": f"name 有 {len(name)} 字符，上限 {MAX_NAME}。", "fatal": True})

    if not desc:
        out.append({"code": "no_description",
                    "message": "frontmatter 缺少 description。", "fatal": True})
    elif len(desc) > MAX_DESCRIPTION:
        # Not a style nit. The system-prompt skill index truncates at 60 chars,
        # so the skill installs, shows up in the UI, and never routes.
        out.append({
            "code": "description_too_long",
            "message": (f"description 有 {len(desc)} 字符，上限 {MAX_DESCRIPTION}。"
                        "超出的部分会被系统提示索引悄悄截掉，技艺装上了却永远不会被用到。"),
            "fatal": True,
        })

    if len(content) > MAX_CONTENT:
        out.append({"code": "too_large",
                    "message": f"{len(content)} 字符，上限 {MAX_CONTENT}。", "fatal": True})
    if name and name in existing:
        out.append({"code": "name_taken",
                    "message": f"已经有一条叫「{name}」的技艺了。", "fatal": False})
    return out


def fatal_codes(findings: list[dict]) -> set[str]:
    return {f["code"] for f in findings if f.get("fatal")}


# ---- apply ----------------------------------------------------------------

def apply_draft(store, draft: dict, *, force: bool = False, now=None):
    """Write an approved draft into the user's real skills dir.

    Refuses in a deliberate order, and one refusal is deliberately NOT
    forceable — see below.
    """
    import time
    from mo_evolve.accept import AcceptRefused, AcceptResult
    from mo_evolve import safety, skill_archive

    now = now or time.time
    content = draft.get("content") or ""
    fm = parse_frontmatter(content)
    name = (draft.get("name") or fm.get("name") or "").strip()

    if not content.strip():
        raise AcceptRefused("no_candidate", "这次没有产出可用的技艺文本。")

    existing = {s["name"] for s in store.list_skills()}
    findings = validate_draft(draft, existing if not force else set())
    fatal = fatal_codes(findings)

    # Frontmatter problems are NOT forceable, and this breaks the force-confirm
    # symmetry everywhere else in Mo on purpose. Forcing a failed gate deploys a
    # risky improvement; forcing a 61-char description deploys a skill that
    # cannot fire — it installs, it appears in the list, and the index truncates
    # its description so it never routes. There is nothing to gain by allowing
    # it, so the honest answer is the character count and a rewrite.
    hard = fatal - {"name_taken"}
    if hard:
        raise AcceptRefused(
            "invalid_frontmatter",
            "；".join(f["message"] for f in findings if f.get("fatal")
                      and f["code"] != "name_taken"),
        )

    # Checked against the findings list, not `fatal`: name_taken is marked
    # non-fatal precisely because it IS forceable, so looking for it in the
    # fatal set would mean it never fires and a collision silently overwrote.
    if not force and any(f["code"] == "name_taken" for f in findings):
        raise AcceptRefused("name_taken", f"已经有一条叫「{name}」的技艺了。")

    # Empty baseline ⇒ every line counts as added, which is exactly right for
    # text authored from nothing.
    unsafe = [f for f in safety.scan_added_lines(content, "") if f.severity == "high"]
    if unsafe and not force:
        raise AcceptRefused(
            "unsafe",
            "新写的内容里有 " + str(len(unsafe)) + " 处高危模式：" +
            "、".join(sorted({f.pattern for f in unsafe})),
        )

    target = store.find_skill_file(name)
    if target is None:
        category = draft.get("category")
        base = store.skills_dir / category if category else store.skills_dir
        target = base / name / "SKILL.md"

    # v0001 records existed=False for a genuinely new skill, so reverting to it
    # removes the directory rather than leaving an empty SKILL.md.
    version = skill_archive.snapshot(
        store.archive_dir, target, name,
        meta={"kind": "pre-learn", "forced": force},
    )
    skill_archive.apply_atomic(target, content)
    skill_archive.set_head(store.archive_dir, name, version, content)

    written = _write_sidecars(draft, target.parent)
    store.add_pending({"skill": name, "version": version, "at": now(),
                       "kind": "learn"})

    try:
        applied_to = str(target.relative_to(store.hermes_root))
    except ValueError:
        applied_to = str(target)

    return AcceptResult(
        applied_to=applied_to, archive_version=version, pins=written,
        forced=force, gate_passed=None,
    )


def _write_sidecars(draft: dict, skill_dir: Path) -> int:
    """Copy scripts/references/templates the turn produced alongside SKILL.md."""
    src_dir = draft.get("_source_dir")
    if not src_dir:
        return 0
    n = 0
    for f in draft.get("files") or []:
        rel = f.get("path")
        if not rel or ".." in rel or Path(rel).is_absolute():
            continue
        if Path(rel).parts[0] not in ALLOWED_SUBDIRS:
            continue
        src = Path(src_dir) / rel
        if not src.is_file():
            continue
        dest = Path(skill_dir) / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        try:
            shutil.copy2(src, dest)
            n += 1
        except Exception:
            continue
    return n
