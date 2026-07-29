"""Mine Mo's own trajectory log for evaluation examples.

Mo has been recording every chat episode to
``~/.hermes-mo/trajectories/trajectories.jsonl`` and letting the user mark them
好评/差评 — and feeding all of it to nothing. The eval set is synthesized from
the skill's own text, which makes the loop self-referential: the skill is
optimized against a model's imagination of what it should do, never against
what the user actually asked for or how they judged the answer.

This reads that log. Deliberately mirrors ``HermesSessionImporter``'s
static-method shape (`external_importers.py`) so the output drops straight into
``RelevanceFilter.filter_and_score`` without adapting anything.

**On labels.** ``add_trajectory`` folds every turn of a session into one
trajectory carrying one ``label``. A 差评 on turn 5 of a 12-turn session does
not mean turns 1-4 were bad — the user was reacting to the answer in front of
them. Propagating the label across all turns would poison the dataset with
eleven false failures, so it attaches strongly only to the turn the user was
looking at, and earlier turns of a negative episode are marked weak.
"""

from __future__ import annotations

import json
from pathlib import Path

# The gateway truncates at write time, but a trajectory can still be long
# enough to dominate a judge prompt. Keep the same shape as the vendored
# importers, which cap at 1000 chars when scoring.
_MAX_INPUT = 2000
_MAX_REPLY = 4000
_MIN_LEN = 10  # same floor the vendored importers use


class MoTrajectoryImporter:
    """Read ``trajectories.jsonl`` as flat (task, response) turns."""

    @staticmethod
    def extract_messages(
        traj_file: Path,
        limit: int = 0,
        since: float | None = None,
    ) -> list[dict]:
        """One dict per *turn*, newest episode first.

        Returns dicts with the keys ``RelevanceFilter`` requires
        (``source``, ``task_input``, ``assistant_response``) plus the
        provenance the evidence panel and the corrective-rubric step need.
        """
        traj_file = Path(traj_file)
        if not traj_file.exists():
            return []

        try:
            from evolution.core.external_importers import _contains_secret
        except Exception:                       # pragma: no cover - vendored dep
            # Fail closed-ish rather than open: this text is written to disk and
            # sent to an eval model, so "we couldn't load the detector" must not
            # silently mean "nothing is a secret".
            import re as _re
            _fallback = _re.compile(
                r"(sk-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}"
                r"|gh[pousr]_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}"
                r"|-----BEGIN [A-Z ]*PRIVATE KEY-----)")

            def _contains_secret(text: str) -> bool:
                return bool(_fallback.search(text or ""))

        episodes = []
        # Read line-by-line: add_trajectory rewrites the whole file on every
        # turn, so this grows and is re-serialized constantly.
        try:
            with traj_file.open(encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        episodes.append(json.loads(line))
                    except Exception:
                        continue        # a torn line must not sink the import
        except OSError:
            return []

        messages: list[dict] = []
        for ep in reversed(episodes):           # newest episodes first
            if since is not None and float(ep.get("updated_at") or ep.get("created_at") or 0) < since:
                continue

            label = ep.get("label")
            turns = ep.get("turns_log") or []
            if not turns:
                # Pre-fold trajectories, or an episode whose log was trimmed.
                turns = [{"prompt": ep.get("prompt", ""), "reply": ep.get("reply", ""),
                          "at": ep.get("created_at")}]

            last = len(turns) - 1
            for i, turn in enumerate(turns):
                prompt = (turn.get("prompt") or "")[:_MAX_INPUT]
                reply = (turn.get("reply") or "")[:_MAX_REPLY]
                if len(prompt.strip()) < _MIN_LEN:
                    continue
                if _contains_secret(prompt) or (reply and _contains_secret(reply)):
                    continue

                is_last = (i == last)
                # The label attaches to the turn the user was reacting to, and
                # only to that one. Earlier turns of a negative episode are
                # *context* — carrying the label onto them would tell the
                # corrective-rubric step that eleven perfectly good answers were
                # failures, and fabricate eleven failure modes out of them.
                if label in ("neg", "pos") and is_last:
                    turn_label, strength = label, "strong"
                elif label == "neg":
                    # Recorded, but not treated as evidence of failure. Kept so
                    # a future change can weight these if it wants to.
                    turn_label, strength = None, "weak"
                else:
                    turn_label, strength = None, "none"

                messages.append({
                    "source": "mo-trajectory",
                    "task_input": prompt,
                    "assistant_response": reply,
                    "session_id": ep.get("session_id", ""),
                    "traj_id": ep.get("id", ""),
                    "turn_index": i,
                    "is_last_turn": is_last,
                    "label": turn_label,
                    "label_strength": strength,
                    "at": turn.get("at") or ep.get("created_at"),
                })

                if limit and len(messages) >= limit:
                    return messages

        return messages


def label_counts(messages: list[dict]) -> dict:
    """Summary for the run's metrics and the UI's evidence panel.

    ``neg_context`` counts earlier turns of a negative episode — turns that
    happened before the answer the user rejected. They are not failures and are
    deliberately not in ``neg``.
    """
    out = {"neg": 0, "pos": 0, "unlabelled": 0, "neg_context": 0}
    for m in messages:
        lab = m.get("label")
        if lab == "neg":
            out["neg"] += 1
        elif lab == "pos":
            out["pos"] += 1
        else:
            out["unlabelled"] += 1
            if m.get("label_strength") == "weak":
                out["neg_context"] += 1
    return out
