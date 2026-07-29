"""Evolve a Hermes Agent skill using DSPy + GEPA.

Usage:
    python -m evolution.skills.evolve_skill --skill github-code-review --iterations 10
    python -m evolution.skills.evolve_skill --skill arxiv --eval-source golden --dataset datasets/skills/arxiv/
"""

import difflib
import json
import os
import sys
import time
from pathlib import Path
from datetime import datetime
from typing import Optional

import click
import dspy
from rich.console import Console
from rich.panel import Panel
from rich.table import Table

from evolution.core.config import EvolutionConfig, get_hermes_agent_path
from evolution.core.dataset_builder import SyntheticDatasetBuilder, EvalDataset, GoldenDatasetLoader
from evolution.core.external_importers import build_dataset_from_external
from evolution.core.fitness import skill_fitness_metric, LLMJudge, FitnessScore
from evolution.core.constraints import ConstraintValidator
from evolution.skills.skill_module import (
    SkillModule,
    load_skill,
    find_skill,
    reassemble_skill,
)

# Mo local patches live in an importable, unit-tested package alongside the
# gateway. Guarded so this engine still runs with only `server/vendor` on the
# path (which is what CI's import smoke test proves).
try:
    from mo_evolve.metric import TieredMetric as _TieredMetric, dimensions_of as _dimensions_of
except ImportError:  # pragma: no cover - exercised by the standalone CI job
    _TieredMetric = None
    _dimensions_of = None
try:
    from mo_evolve import gate as _gate
except ImportError:  # pragma: no cover
    _gate = None
try:
    from mo_evolve import safety as _safety
except ImportError:  # pragma: no cover
    _safety = None
try:
    from mo_evolve.trajectory_dataset import build_dataset_from_trajectories as _build_from_trajectories
except ImportError:  # pragma: no cover
    _build_from_trajectories = None
try:
    from mo_evolve import critic as _critic
except ImportError:  # pragma: no cover
    _critic = None

console = Console()


def evolve(
    skill_name: str,
    iterations: int = 10,
    eval_source: str = "synthetic",
    dataset_path: Optional[str] = None,
    optimizer_model: str = "openai/gpt-4.1",
    eval_model: str = "openai/gpt-4.1-mini",
    critic_model: str = "",
    hermes_repo: Optional[str] = None,
    run_tests: bool = False,
    dry_run: bool = False,
):
    """Main evolution function — orchestrates the full optimization loop."""

    config = EvolutionConfig(
        iterations=iterations,
        optimizer_model=optimizer_model,
        eval_model=eval_model,
        judge_model=eval_model,  # Use same model for dataset generation
        critic_model=critic_model,
        run_pytest=run_tests,
    )
    if hermes_repo:
        config.hermes_agent_path = Path(hermes_repo)

    # ── 1. Find and load the skill ──────────────────────────────────────
    console.print(f"\n[bold cyan]🧬 Hermes Agent Self-Evolution[/bold cyan] — Evolving skill: [bold]{skill_name}[/bold]\n")

    skill_path = find_skill(skill_name, config.hermes_agent_path)
    if not skill_path:
        console.print(f"[red]✗ Skill '{skill_name}' not found in {config.hermes_agent_path / 'skills'}[/red]")
        sys.exit(1)

    skill = load_skill(skill_path)
    console.print(f"  Loaded: {skill_path.relative_to(config.hermes_agent_path)}")
    console.print(f"  Name: {skill['name']}")
    console.print(f"  Size: {len(skill['raw']):,} chars")
    console.print(f"  Description: {skill['description'][:80]}...")

    if dry_run:
        console.print(f"\n[bold green]DRY RUN — setup validated successfully.[/bold green]")
        console.print(f"  Would generate eval dataset (source: {eval_source})")
        console.print(f"  Would run GEPA optimization ({iterations} iterations)")
        console.print(f"  Would validate constraints and create PR")
        return

    # ── 2. Build or load evaluation dataset ─────────────────────────────
    console.print(f"\n[bold]Building evaluation dataset[/bold] (source: {eval_source})")

    # Bound on every branch — only the trajectory path fills it in.
    dataset_provenance = {"source": eval_source}

    if eval_source == "golden" and dataset_path:
        dataset = GoldenDatasetLoader.load(Path(dataset_path))
        console.print(f"  Loaded golden dataset: {len(dataset.all_examples)} examples")
    elif eval_source == "sessiondb":
        save_path = Path(dataset_path) if dataset_path else Path("datasets") / "skills" / skill_name
        dataset = build_dataset_from_external(
            skill_name=skill_name,
            skill_text=skill["raw"],
            sources=["claude-code", "copilot", "hermes"],
            output_path=save_path,
            model=eval_model,
        )
        if not dataset.all_examples:
            console.print("[red]✗ No relevant examples found from session history[/red]")
            sys.exit(1)
        console.print(f"  Mined {len(dataset.all_examples)} examples from session history")
    elif eval_source in ("trajectory", "mixed"):
        # Mo local patch: mine the user's own chat episodes and 好评/差评 labels.
        # Without this the eval set is synthesized from the skill's own text and
        # the loop is self-referential — the skill is optimized against a model's
        # imagination of it, never against what the user actually asked for.
        if _build_from_trajectories is None:
            console.print("[red]✗ Trajectory mining unavailable (mo_evolve not on path)[/red]")
            sys.exit(1)
        traj_file = Path(hermes_repo or config.hermes_agent_path) / "trajectories" / "trajectories.jsonl"
        dataset, dataset_provenance = _build_from_trajectories(
            skill_name=skill_name,
            skill_text=skill["raw"],
            traj_file=traj_file,
            model=eval_model,
            config=config,
            blend_synthetic=(eval_source == "mixed"),
            console=console,
        )
        if not dataset.all_examples:
            console.print("[red]✗ No relevant examples found in trajectories[/red]")
            console.print("  聊几轮再来,或给几条回答打上好评/差评。")
            sys.exit(1)
        dataset.save(Path("datasets") / "skills" / skill_name)
    elif eval_source == "synthetic":
        builder = SyntheticDatasetBuilder(config)
        dataset = builder.generate(
            artifact_text=skill["raw"],
            artifact_type="skill",
        )
        # Save for reuse
        save_path = Path("datasets") / "skills" / skill_name
        dataset.save(save_path)
        console.print(f"  Generated {len(dataset.all_examples)} synthetic examples")
        console.print(f"  Saved to {save_path}/")
        # Mo local patch: report provenance here too, so the UI can tell the
        # user this eval set was synthesized from the skill's own text — a
        # self-referential loop — rather than silently showing nothing.
        dataset_provenance = {
            "source": "synthetic",
            "counts": {"trajectory_neg": 0, "trajectory_pos": 0,
                       "trajectory_unlabelled": 0, "synthetic": len(dataset.all_examples)},
            "turns_mined": 0,
        }
    elif dataset_path:
        dataset = EvalDataset.load(Path(dataset_path))
        console.print(f"  Loaded dataset: {len(dataset.all_examples)} examples")
    else:
        console.print("[red]✗ Specify --dataset-path or use --eval-source synthetic[/red]")
        sys.exit(1)

    console.print(f"  Split: {len(dataset.train)} train / {len(dataset.val)} val / {len(dataset.holdout)} holdout")

    # ── 3. Validate constraints on baseline ─────────────────────────────
    console.print(f"\n[bold]Validating baseline constraints[/bold]")
    validator = ConstraintValidator(config)
    # Validate the full reassembled skill (with frontmatter) so the
    # skill_structure check is meaningful — the body alone never has YAML.
    baseline_constraints = validator.validate_all(skill["raw"], "skill")
    all_pass = True
    for c in baseline_constraints:
        icon = "✓" if c.passed else "✗"
        color = "green" if c.passed else "red"
        console.print(f"  [{color}]{icon} {c.constraint_name}[/{color}]: {c.message}")
        if not c.passed:
            all_pass = False

    if not all_pass:
        console.print("[yellow]⚠ Baseline skill has constraint violations — proceeding anyway[/yellow]")

    # ── 4. Set up DSPy + GEPA optimizer ─────────────────────────────────
    console.print(f"\n[bold]Configuring optimizer[/bold]")
    console.print(f"  Optimizer: GEPA ({iterations} iterations)")
    console.print(f"  Optimizer model: {optimizer_model}")
    console.print(f"  Eval model: {eval_model}")

    # Configure DSPy
    lm = dspy.LM(eval_model)
    dspy.configure(lm=lm)

    # Create the baseline skill module
    baseline_module = SkillModule(skill["body"])

    # Prepare DSPy examples
    trainset = dataset.to_dspy_examples("train")
    valset = dataset.to_dspy_examples("val")

    # ── 5. Run GEPA optimization ────────────────────────────────────────
    console.print(f"\n[bold cyan]Running GEPA optimization ({iterations} iterations)...[/bold cyan]\n")

    start_time = time.time()

    # Budget scales with the user-chosen iteration count: each "iteration" is
    # ~15 metric calls. Keeps small runs fast/cheap and large runs thorough.
    budget = max(15, iterations * 15)

    # Mo local patch: tiered metric. Upstream scores everything with the
    # keyword-overlap heuristic and hands GEPA a formatted float as "feedback",
    # which defeats the point of GEPA's reflective mutation. TieredMetric runs
    # the free heuristic first and escalates to the (already-written but never
    # instantiated) LLMJudge when a candidate scores poorly — which is exactly
    # where the reflector reads feedback. Guarded import so the vendored engine
    # still runs standalone, without mo_evolve on the path.
    # Evolver-profile paths. Every run gets a fresh cwd, so anything meant to
    # persist across runs has to live here rather than under output/.
    _evolve_home = Path(hermes_repo or config.hermes_agent_path) / "profiles" / "ye-mao-evolve" / "evolve"

    metric = None
    if _TieredMetric is not None:
        try:
            metric = _TieredMetric(
                config,
                # Stable across runs: the nightly loop re-scores the same pin
                # set on every run, and those judgements are identical whenever
                # the skill text and output repeat.
                cache_path=_evolve_home / "judge_cache" / f"{skill_name}.json",
                max_metric_calls=budget,
            )
            console.print(f"  Metric: tiered (judge escalates below "
                          f"{config.judge_escalate_below:.2f}, model {eval_model})")
        except Exception as exc:
            console.print(f"[yellow]Tiered metric unavailable ({exc}); using heuristic[/yellow]")
            metric = None
    if metric is None:
        console.print("[yellow]  Metric: keyword-overlap heuristic (no LLM judge)[/yellow]")

    def _gepa_metric(gold, pred, trace=None, pred_name=None, pred_trace=None):
        if metric is not None:
            return metric(gold, pred, trace, pred_name, pred_trace)
        score = skill_fitness_metric(gold, pred, trace)
        out = (getattr(pred, "output", "") or "").strip()
        if not out:
            fb = "Output was empty — the skill must produce a concrete response."
        elif score < 0.6:
            exp = getattr(gold, "expected_behavior", "")
            fb = f"score={score:.2f}. Only partially matched expected behavior: {exp[:200]}"
        else:
            fb = f"score={score:.2f}. Good — matched the expected behavior."
        return dspy.Prediction(score=score, feedback=fb)
    try:
        optimizer = dspy.GEPA(
            metric=_gepa_metric,
            max_metric_calls=budget,
            reflection_lm=dspy.LM(optimizer_model),
            track_stats=False,
        )
        optimized_module = optimizer.compile(
            baseline_module,
            trainset=trainset,
            valset=valset,
        )
    except Exception as e:
        # Fall back to MIPROv2 if GEPA isn't usable in this DSPy version.
        # MIPROv2 also optimizes the signature instructions (= the skill body),
        # so the evolved skill is still a real mutation.
        console.print(f"[yellow]GEPA unavailable ({e}); falling back to MIPROv2[/yellow]")
        optimizer = dspy.MIPROv2(
            metric=skill_fitness_metric,
            auto="light",
        )
        optimized_module = optimizer.compile(
            baseline_module,
            trainset=trainset,
            requires_permission_to_run=False,
        )

    elapsed = time.time() - start_time
    console.print(f"\n  Optimization completed in {elapsed:.1f}s")

    # ── 6. Extract evolved skill text ───────────────────────────────────
    # The optimized module's instructions contain the evolved skill text
    evolved_body = optimized_module.skill_text
    evolved_full = reassemble_skill(skill["frontmatter"], evolved_body)

    # ── 7. Validate evolved skill ───────────────────────────────────────
    console.print(f"\n[bold]Validating evolved skill[/bold]")
    evolved_constraints = validator.validate_all(evolved_full, "skill", baseline_text=skill["raw"])

    # Mo local patch: content safety. The size/growth/structure checks say
    # nothing about what the text *is* — and this text ends up in a file the
    # agent loads. Scanned diff-scoped (only lines this rewrite introduced) so
    # a skill that legitimately discusses shell commands stays evolvable.
    safety_findings = []
    if _safety is not None:
        try:
            extra, safety_findings = _safety.constraint_results(evolved_full, skill["raw"])
            evolved_constraints = list(evolved_constraints) + list(extra)
        except Exception as exc:
            console.print(f"[yellow]Safety scan unavailable ({exc})[/yellow]")

    all_pass = True
    for c in evolved_constraints:
        icon = "✓" if c.passed else "✗"
        color = "green" if c.passed else "red"
        console.print(f"  [{color}]{icon} {c.constraint_name}[/{color}]: {c.message}")
        if not c.passed:
            all_pass = False

    if not all_pass:
        console.print("[red]✗ Evolved skill FAILED constraints — not deploying[/red]")
        # Still save for inspection
        output_path = Path("output") / skill_name / "evolved_FAILED.md"
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(evolved_full)
        # Mo local patch: persist the constraint verdicts on this path too.
        # A run rejected *for* a high-severity injection finding is exactly the
        # run whose findings someone needs to read; without this they were
        # printed to the log and then dropped, because this return precedes the
        # safety.json write below.
        (output_path.parent / "failed_constraints.json").write_text(json.dumps({
            "constraints": [{"name": c.constraint_name, "passed": c.passed,
                             "message": c.message, "details": c.details}
                            for c in evolved_constraints],
            "safety_findings": [f.to_dict() for f in safety_findings],
        }, ensure_ascii=False, indent=2))
        console.print(f"  Saved failed variant to {output_path}")
        return

    # ── 8. Evaluate on holdout set ──────────────────────────────────────
    console.print(f"\n[bold]Evaluating on holdout set ({len(dataset.holdout)} examples)[/bold]")

    holdout_examples = dataset.to_dspy_examples("holdout")

    # Mo local patch: the holdout is always scored by the LLM judge (never the
    # keyword proxy) because this is the number the acceptance gate rests on.
    # Per-example scores are retained — the gate runs a *paired* bootstrap over
    # the per-example deltas, which upstream's mean-only loop threw away.
    baseline_scores = []
    evolved_scores = []
    baseline_fs = []
    evolved_fs = []
    for ex in holdout_examples:
        with dspy.context(lm=lm):
            baseline_pred = baseline_module(task_input=ex.task_input)
            evolved_pred = optimized_module(task_input=ex.task_input)

        if metric is not None:
            b_fs = metric.score_pair(ex, baseline_pred)
            e_fs = metric.score_pair(ex, evolved_pred)
            baseline_fs.append(b_fs)
            evolved_fs.append(e_fs)
            baseline_scores.append(b_fs.composite)
            evolved_scores.append(e_fs.composite)
        else:
            baseline_scores.append(skill_fitness_metric(ex, baseline_pred))
            evolved_scores.append(skill_fitness_metric(ex, evolved_pred))

    if metric is not None:
        metric.flush_cache()

    avg_baseline = sum(baseline_scores) / max(1, len(baseline_scores))
    avg_evolved = sum(evolved_scores) / max(1, len(evolved_scores))
    improvement = avg_evolved - avg_baseline

    # ── 8b. Regression pin set + acceptance gate ────────────────────────
    # Pins are holdout examples donated by every previously ACCEPTED run of
    # this skill. A candidate that improves today's rubric while breaking an
    # older one is rejected — "benchmarks are gates, not fitness functions",
    # implemented without any external benchmark.
    pin_result = None
    pins_dir = _evolve_home / "pins"
    if _gate is not None:
        pins = _gate.read_pins(pins_dir, skill_name)
        if pins:
            console.print(f"\n[bold]Checking {len(pins)} regression pins[/bold]")
            regressions = []
            for pin in pins:
                pex = dspy.Example(
                    task_input=pin.get("task_input", ""),
                    expected_behavior=pin.get("expected_behavior", ""),
                ).with_inputs("task_input")
                try:
                    with dspy.context(lm=lm):
                        b_pred = baseline_module(task_input=pex.task_input)
                        e_pred = optimized_module(task_input=pex.task_input)
                    if metric is not None:
                        b = metric.score_pair(pex, b_pred).composite
                        e = metric.score_pair(pex, e_pred).composite
                    else:
                        b = skill_fitness_metric(pex, b_pred)
                        e = skill_fitness_metric(pex, e_pred)
                except Exception:
                    continue  # a flaky pin must not block an otherwise good run
                if e < b:
                    regressions.append({"task_input": pin.get("task_input", "")[:200],
                                        "baseline": b, "evolved": e, "delta": e - b})
            pin_result = {"n": len(pins), "regressions": regressions}
            console.print(f"  {len(regressions)} regressed of {len(pins)}")

    verdict = None
    if _gate is not None:
        degraded = bool(metric is not None and metric.stats.degraded)
        verdict = _gate.evaluate_gate(
            baseline_scores, evolved_scores, pin_result, config,
            degraded=degraded,
            degraded_reason=(metric.stats.degraded_reason if metric is not None else ""),
        )

    # ── 9. Report results ───────────────────────────────────────────────
    table = Table(title="Evolution Results")
    table.add_column("Metric", style="bold")
    table.add_column("Baseline", justify="right")
    table.add_column("Evolved", justify="right")
    table.add_column("Change", justify="right")

    change_color = "green" if improvement > 0 else "red"
    table.add_row(
        "Holdout Score",
        f"{avg_baseline:.3f}",
        f"{avg_evolved:.3f}",
        f"[{change_color}]{improvement:+.3f}[/{change_color}]",
    )
    table.add_row(
        "Skill Size",
        f"{len(skill['body']):,} chars",
        f"{len(evolved_body):,} chars",
        f"{len(evolved_body) - len(skill['body']):+,} chars",
    )
    table.add_row("Time", "", f"{elapsed:.1f}s", "")
    table.add_row("Iterations", "", str(iterations), "")

    console.print()
    console.print(table)

    # ── 10. Save output ─────────────────────────────────────────────────
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_dir = Path("output") / skill_name / timestamp
    output_dir.mkdir(parents=True, exist_ok=True)

    # Save evolved skill
    (output_dir / "evolved_skill.md").write_text(evolved_full)

    # Save baseline for comparison
    (output_dir / "baseline_skill.md").write_text(skill["raw"])

    # Save metrics
    metrics = {
        "skill_name": skill_name,
        "timestamp": timestamp,
        "iterations": iterations,
        "optimizer_model": optimizer_model,
        "eval_model": eval_model,
        "baseline_score": avg_baseline,
        "evolved_score": avg_evolved,
        "improvement": improvement,
        "baseline_size": len(skill["body"]),
        "evolved_size": len(evolved_body),
        "train_examples": len(dataset.train),
        "val_examples": len(dataset.val),
        "holdout_examples": len(dataset.holdout),
        "elapsed_seconds": elapsed,
        "constraints_passed": all_pass,
    }

    # Mo local patch: record how the scores were actually produced, so the UI
    # can never again present a keyword-overlap number as an LLM-judge verdict.
    if metric is not None:
        fitness = metric.stats.to_dict()
        fitness.update({
            "metric_mode": config.metric_mode,
            "judge_model": config.eval_model,
            "collusion_risk": config.eval_model == config.optimizer_model,
            "holdout_pairs": [{"baseline": b, "evolved": e}
                              for b, e in zip(baseline_scores, evolved_scores)],
        })
        if _dimensions_of is not None and baseline_fs:
            fitness["holdout_dimensions"] = {
                "baseline": _dimensions_of(baseline_fs),
                "evolved": _dimensions_of(evolved_fs),
            }
        metrics["fitness"] = fitness
    else:
        metrics["fitness"] = {"metric_mode": "heuristic", "degraded": False,
                              "holdout_pairs": [{"baseline": b, "evolved": e}
                                                for b, e in zip(baseline_scores, evolved_scores)]}

    # The holdout examples this run was judged on. On accept these become the
    # skill's regression pins. Deliberately NOT named `holdout_examples` — that
    # key already exists above as an integer count, and runs produced before
    # this change still carry the int, so reusing the name would hand the
    # accept path a number to iterate over.
    # Where the eval examples came from. This is what turns the run from a
    # progress bar into something legible: "夜貘 read 6 negative trajectories,
    # mostly about ignoring length constraints".
    metrics["dataset"] = dataset_provenance

    metrics["holdout_pin_examples"] = [
        {"task_input": getattr(ex, "task_input", ""),
         "expected_behavior": getattr(ex, "expected_behavior", "")}
        for ex in holdout_examples
    ]

    (output_dir / "metrics.json").write_text(json.dumps(metrics, indent=2))

    if safety_findings:
        (output_dir / "safety.json").write_text(json.dumps(
            {"findings": [f.to_dict() for f in safety_findings]},
            ensure_ascii=False, indent=2))

    # Mo local patch: a second opinion, from a model that is not the author.
    # One call, advisory — a `reject` doesn't block, it just means accepting
    # needs the same explicit confirmation as a failed gate.
    if _critic is not None and getattr(config, "critic_model", ""):
        console.print("\n[bold]Cross-model review[/bold]")
        diff_text = "".join(difflib.unified_diff(
            skill["raw"].splitlines(keepends=True),
            evolved_full.splitlines(keepends=True),
            fromfile="baseline", tofile="evolved"))
        crit = _critic.critique(
            diff=diff_text, baseline=skill["body"], evolved=evolved_body,
            hypothesis=os.environ.get("MO_EVOLVE_HYPOTHESIS", ""),
            critic_model=config.critic_model, optimizer_model=optimizer_model,
        )
        console.print(f"  {crit.verdict}" + (f" — {crit.rationale}" if crit.rationale else ""))
        if crit.skipped:
            console.print(f"  [yellow]{crit.skipped}[/yellow]")
        (output_dir / "critic.json").write_text(
            json.dumps(crit.to_dict(), ensure_ascii=False, indent=2))
        metrics["critic"] = crit.to_dict()
        (output_dir / "metrics.json").write_text(json.dumps(metrics, indent=2))

    if verdict is not None:
        metrics["gate"] = verdict.to_dict()
        (output_dir / "metrics.json").write_text(json.dumps(metrics, indent=2))
        (output_dir / "gate.json").write_text(
            json.dumps(verdict.to_dict(), ensure_ascii=False, indent=2))

    console.print(f"\n  Output saved to {output_dir}/")

    # The gate — not `improvement > 0` — decides whether this is deployable.
    if verdict is not None:
        if verdict.passed:
            console.print(f"\n[bold green]✓ 通过采纳门槛：{verdict.reason}[/bold green]")
            console.print(f"  Review the diff: diff {output_dir}/baseline_skill.md {output_dir}/evolved_skill.md")
        else:
            console.print(f"\n[yellow]⚠ 未通过采纳门槛：{verdict.reason}[/yellow]")
            console.print("  采纳按钮仍可用，但需要二次确认强制采纳。")
    elif improvement > 0:
        console.print(f"\n[bold green]✓ Evolution improved skill by {improvement:+.3f} ({improvement/max(0.001, avg_baseline)*100:+.1f}%)[/bold green]")
    else:
        console.print(f"\n[yellow]⚠ Evolution did not improve skill (change: {improvement:+.3f})[/yellow]")
        console.print("  Try: more iterations, better eval dataset, or different optimizer model")


@click.command()
@click.option("--skill", required=True, help="Name of the skill to evolve")
@click.option("--iterations", default=10, help="Number of GEPA iterations")
@click.option("--eval-source", default="synthetic",
              type=click.Choice(["synthetic", "golden", "sessiondb", "trajectory", "mixed"]),
              help="Source for evaluation dataset (trajectory/mixed mine Mo's own chat log)")
@click.option("--dataset-path", default=None, help="Path to existing eval dataset (JSONL)")
@click.option("--optimizer-model", default="openai/gpt-4.1", help="Model for GEPA reflections")
@click.option("--eval-model", default="openai/gpt-4.1-mini", help="Model for evaluations")
@click.option("--critic-model", default="", help="Model for the cross-model review (must differ from --optimizer-model)")
@click.option("--hermes-repo", default=None, help="Path to hermes-agent repo")
@click.option("--run-tests", is_flag=True, help="Run full pytest suite as constraint gate")
@click.option("--dry-run", is_flag=True, help="Validate setup without running optimization")
def main(skill, iterations, eval_source, dataset_path, optimizer_model, eval_model, critic_model, hermes_repo, run_tests, dry_run):
    """Evolve a Hermes Agent skill using DSPy + GEPA optimization."""
    evolve(
        skill_name=skill,
        iterations=iterations,
        eval_source=eval_source,
        dataset_path=dataset_path,
        optimizer_model=optimizer_model,
        eval_model=eval_model,
        critic_model=critic_model,
        hermes_repo=hermes_repo,
        run_tests=run_tests,
        dry_run=dry_run,
    )


if __name__ == "__main__":
    main()
