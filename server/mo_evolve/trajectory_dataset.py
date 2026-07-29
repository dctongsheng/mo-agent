"""Turn Mo's trajectories into an eval dataset.

The important step here is what happens to a 差评 turn.

``RelevanceFilter`` derives ``expected_behavior`` by looking at the user's
message *and the assistant's actual response*. For a turn the user marked
negative, that response is the thing that was wrong — so a rubric derived from
it teaches the optimizer to reproduce the failure. Those turns get their rubric
rewritten by ``DeriveCorrectiveRubric``, which is told the user was
dissatisfied and asked what a good answer *would* have done.

That inversion is the whole point of mining trajectories: negative examples are
the highest-value signal GEPA has, because its reflective mutation only reads
feedback from candidates that scored badly.
"""

from __future__ import annotations

import random
from pathlib import Path

from mo_evolve.trajectory_importer import MoTrajectoryImporter, label_counts

#: Deterministic shuffle seed. The split must not hand the gate a holdout made
#: only of the oldest examples while training on the newest — but it also has to
#: be reproducible, so a verdict can be recomputed from the stored dataset.
SPLIT_SEED = 20260729


def min_mined_for(config) -> int:
    """How many examples make a *usable* dataset, not merely a non-empty one.

    Derived from the gate rather than picked: the gate refuses any run whose
    holdout is smaller than ``min_holdout``, so a dataset that cannot produce
    that many holdout examples will complete the whole GEPA budget and then be
    rejected every single time. Doubling it leaves train and val a fair share.
    """
    return max(8, getattr(config, "min_holdout", 5) * 2)


def _signatures():
    """Built lazily so importing this module doesn't require dspy."""
    import dspy

    class DeriveCorrectiveRubric(dspy.Signature):
        """The user marked this exchange as unsatisfactory.

        Describe what a GOOD response would have done — the rubric, not the
        text. Do NOT describe what the assistant actually did; that is the
        failure being corrected. Name the failure mode as a short kebab-case
        tag (e.g. ignored-length-constraint, wrong-tool, hallucinated-source).
        """
        skill_name: str = dspy.InputField()
        skill_text: str = dspy.InputField(desc="First 800 chars of the SKILL.md")
        task_input: str = dspy.InputField(desc="What the user asked")
        actual_response: str = dspy.InputField(desc="The unsatisfactory answer")
        expected_behavior: str = dspy.OutputField(
            desc="Rubric describing what a good response should do instead")
        failure_mode: str = dspy.OutputField(desc="Short kebab-case tag")

    return DeriveCorrectiveRubric


def _stratified_split(examples: list, config) -> tuple[list, list, list]:
    """Split with the holdout sized *first*, then stratified across labels.

    Two requirements pull against each other.

    The holdout is what the acceptance gate measures, and the gate refuses any
    run with fewer than ``min_holdout`` examples. Splitting per-stratum and
    letting the holdout be whatever falls out the end produced holdouts of 4 (or
    0) from perfectly reasonable datasets — the run would burn its whole GEPA
    budget and then be rejected for sample size, every time.

    But the holdout must also not become all-negatives: drawn only from
    failures, it measures recovery from failure rather than overall quality.

    So: decide the holdout size up front against the gate's floor, then fill it
    proportionally from each stratum (largest-remainder), then split what's left
    into train and val.
    """
    if not examples:
        return [], [], []

    holdout_ratio = getattr(config, "holdout_ratio", 0.25)
    val_ratio = getattr(config, "val_ratio", 0.25)
    min_holdout = getattr(config, "min_holdout", 5)

    n = len(examples)
    # Never starve training to satisfy the floor — with too few examples the
    # gate is *supposed* to refuse, and it will.
    want_holdout = min(max(min_holdout, round(n * holdout_ratio)), n // 2)

    strata: dict = {}
    for ex in examples:
        strata.setdefault(_stratum(ex), []).append(ex)

    # Shuffled per stratum, deterministically: without this the holdout is
    # always the oldest slice and the gate only ever measures stale examples.
    rng = random.Random(SPLIT_SEED)
    for group in strata.values():
        rng.shuffle(group)

    holdout = _proportional_take(strata, want_holdout)

    # Whatever remains, split train/val — again per stratum so val isn't
    # accidentally single-label.
    remaining = [ex for group in strata.values() for ex in group]
    want_val = min(round(n * val_ratio), max(0, len(remaining) - 1))
    val_strata: dict = {}
    for ex in remaining:
        val_strata.setdefault(_stratum(ex), []).append(ex)
    val = _proportional_take(val_strata, want_val)
    train = [ex for group in val_strata.values() for ex in group]

    return train, val, holdout


def _proportional_take(strata: dict, want: int) -> list:
    """Remove ``want`` examples from ``strata`` in proportion to stratum size.

    Mutates ``strata`` (the taken examples are popped), so the caller is left
    holding exactly the remainder — no example is dropped or duplicated.
    """
    if want <= 0:
        return []
    total = sum(len(g) for g in strata.values())
    if total == 0:
        return []
    want = min(want, total)

    # Largest-remainder apportionment: floor everyone, then hand out the
    # leftovers to whoever was rounded down hardest.
    quotas = {k: (len(g) * want) / total for k, g in strata.items()}
    take = {k: int(q) for k, q in quotas.items()}
    leftover = want - sum(take.values())
    for k, _ in sorted(quotas.items(), key=lambda kv: kv[1] - int(kv[1]), reverse=True):
        if leftover <= 0:
            break
        if take[k] < len(strata[k]):
            take[k] += 1
            leftover -= 1

    out = []
    for k in sorted(strata):
        n_take = min(take.get(k, 0), len(strata[k]))
        out.extend(strata[k][:n_take])
        strata[k] = strata[k][n_take:]
    return out


def _stratum(ex) -> str:
    src = getattr(ex, "source", "") or ""
    if src.endswith(":neg"):
        return "neg"
    if src.endswith(":pos"):
        return "pos"
    if src == "synthetic":
        return "synthetic"
    return "unlabelled"


def build_dataset_from_trajectories(
    skill_name: str,
    skill_text: str,
    traj_file: Path,
    model: str,
    config,
    max_examples: int = 40,
    blend_synthetic: bool = True,
    console=None,
):
    """Build an EvalDataset from Mo's trajectory log.

    Returns ``(dataset, provenance)``. ``provenance`` records where every
    example came from and which failure modes were seen — that's what makes
    the run legible in the UI instead of a progress bar.
    """
    import dspy
    from evolution.core.dataset_builder import EvalDataset, EvalExample, SyntheticDatasetBuilder
    from evolution.core.external_importers import RelevanceFilter

    def say(msg):
        if console is not None:
            console.print(msg)

    messages = MoTrajectoryImporter.extract_messages(traj_file)
    counts = label_counts(messages)
    say(f"  Mined {len(messages)} turns "
        f"({counts['neg']} neg / {counts['pos']} pos / {counts['unlabelled']} unlabelled)")

    examples: list = []
    failure_modes: dict = {}
    traj_ids: list = []

    if messages:
        scored = RelevanceFilter(model).filter_and_score(
            messages, skill_name, skill_text, max_examples=max_examples,
        )
        # filter_and_score drops provenance, so re-attach by task_input. The
        # importer truncates identically (both cap at 2000 chars), so the keys
        # line up exactly.
        #
        # Precedence matters when the same prompt appears twice. `messages` is
        # newest-first, and a dict comprehension lets the LAST write win — which
        # would silently hand the oldest episode's label to the newest example.
        # Ask the same question Monday (fine) and Friday (差评) and the 差评
        # would be discarded. So: newest wins, and an explicit label always
        # beats an unlabelled duplicate.
        by_input: dict = {}
        for m in reversed(messages):            # oldest first → newest overwrites
            prev = by_input.get(m["task_input"])
            if prev is not None and prev.get("label") and not m.get("label"):
                continue                        # don't let an unlabelled turn erase a label
            by_input[m["task_input"]] = m

        DeriveCorrectiveRubric = _signatures()
        corrective = dspy.ChainOfThought(DeriveCorrectiveRubric)
        lm = dspy.LM(model)

        for ex in scored:
            src = by_input.get(ex.task_input, {})
            label = src.get("label")
            if src.get("traj_id"):
                traj_ids.append(src["traj_id"])

            if label == "neg":
                # Rewrite the rubric: the actual response is the failure.
                try:
                    with dspy.context(lm=lm):
                        r = corrective(
                            skill_name=skill_name,
                            skill_text=skill_text[:800],
                            task_input=ex.task_input,
                            actual_response=(src.get("assistant_response") or "")[:1500],
                        )
                    rubric = (getattr(r, "expected_behavior", "") or "").strip()
                    mode = (getattr(r, "failure_mode", "") or "unspecified").strip()[:60]
                    if rubric:
                        ex.expected_behavior = rubric
                        ex.category = mode
                        failure_modes[mode] = failure_modes.get(mode, 0) + 1
                except Exception:
                    # Keep the RelevanceFilter rubric rather than dropping the
                    # example — but don't tag it as a known failure mode.
                    pass
                ex.source = "mo-trajectory:neg"
            elif label == "pos":
                ex.source = "mo-trajectory:pos"
            else:
                ex.source = "mo-trajectory"

            examples.append(ex)

    mined = len(examples)
    say(f"  {mined} relevant examples after filtering")

    # Top up when the mined set is too thin to produce a holdout the gate will
    # accept. Without this the run completes, spends its whole GEPA budget, and
    # is then refused for sample size — every time.
    synthetic_added = 0
    min_mined = min_mined_for(config)
    if blend_synthetic and mined < min_mined:
        say(f"  Only {mined} mined (< {min_mined}) — blending in synthetic examples")
        try:
            syn = SyntheticDatasetBuilder(config).generate(
                artifact_text=skill_text, artifact_type="skill")
            for ex in syn.all_examples:
                ex.source = "synthetic"
                examples.append(ex)
                synthetic_added += 1
        except Exception as exc:
            say(f"  [yellow]Synthetic top-up failed ({exc})[/yellow]")

    train, val, holdout = _stratified_split(examples, config)
    dataset = EvalDataset(train=train, val=val, holdout=holdout)

    # Say so up front rather than letting the user discover it forty minutes and
    # several dollars later, when the gate refuses on sample size.
    min_holdout = getattr(config, "min_holdout", 5)
    if len(holdout) < min_holdout:
        say(f"  [yellow]⚠ holdout 只有 {len(holdout)} 条（门槛需要 {min_holdout} 条）——"
            f"本次进化跑完也无法通过采纳门槛。多聊几轮，或改用「轨迹为主，不足时补合成」。[/yellow]")

    provenance = {
        "source": "trajectory" if not synthetic_added else "mixed",
        "counts": {
            "trajectory_neg": sum(1 for e in examples if _stratum(e) == "neg"),
            "trajectory_pos": sum(1 for e in examples if _stratum(e) == "pos"),
            "trajectory_unlabelled": sum(1 for e in examples if _stratum(e) == "unlabelled"),
            "synthetic": synthetic_added,
        },
        "turns_mined": len(messages),
        "label_counts": counts,
        "trajectory_ids": sorted(set(traj_ids))[:50],
        "failure_modes": failure_modes,
        "holdout_strata": _strata_counts(holdout),
    }
    return dataset, provenance


def _strata_counts(examples: list) -> dict:
    out: dict = {}
    for ex in examples:
        s = _stratum(ex)
        out[s] = out.get(s, 0) + 1
    return out
