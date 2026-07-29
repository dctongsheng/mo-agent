# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added — 夜貘 evolves against your real chat history

- **Trajectory mining** (`server/mo_evolve/trajectory_importer.py`,
  `trajectory_dataset.py`). `trajectories.jsonl` and the 好评/差评 labels have
  been collected since day one and fed to exactly nothing; the eval set was
  synthesized from each skill's own text, so the loop was self-referential — a
  skill could score perfectly against a model's imagination of itself while
  being useless in practice. New eval sources `trajectory` and `mixed`, the
  latter now the default for both manual and scheduled runs.
- **Corrective rubrics for negative examples.** `RelevanceFilter` derives its
  rubric partly from the assistant's actual response; for a turn the user
  rejected, that response *is* the bug, so an unmodified rubric would train the
  optimizer to reproduce the failure. Those turns go through
  `DeriveCorrectiveRubric` instead, which is asked what a good answer would have
  done, plus a failure-mode tag. This inversion is the point of mining
  trajectories at all — GEPA's reflective mutation only reads feedback from
  candidates that scored badly.
- **An evidence panel.** A run used to be a progress bar and a number. It now
  says what it read: 「读了 6 条差评轨迹、4 条合成任务。主要问题：
  ignored-length-constraint ×4」. When an eval set turns out to be entirely
  synthetic it says so, and explains why that is a weaker basis.

### Fixed — trajectory label semantics

- **A 差评 no longer condemns the whole session.** `add_trajectory` folds every
  turn of a session into one trajectory with one label; a 差评 on turn 5 of 12
  means the user disliked *that answer*, not the eleven before it. Carrying the
  label across them sent eleven good answers through a prompt that opens "the
  user marked this exchange as unsatisfactory", fabricating eleven failure
  modes and eleven rubrics that "correct" answers that were fine. Earlier turns
  are now recorded as `neg_context` and treated as unlabelled.
- **The newest duplicate wins.** Provenance was re-attached by keying a dict on
  `task_input` over a newest-first list, so the *last* write — the oldest
  episode — won. Ask the same question Monday (fine) and Friday (差评) and the
  Friday label was silently discarded.
- **The holdout now reaches the gate's floor.** Splitting per-stratum and
  letting the holdout be whatever fell out produced holdouts of 4, or 0, from
  perfectly reasonable datasets — so a run completed, spent its entire GEPA
  budget, and was then refused for sample size, every time. The holdout is now
  sized against `min_holdout` first and filled proportionally across label
  strata (it must not become all-negatives, which would measure recovery from
  failure rather than quality). Shuffling is seeded so verdicts stay
  reproducible; the blend threshold is derived from the gate rather than
  guessed.

### Added — self-evolution trust layer

- **Real fitness scoring.** The vendored engine shipped a complete `LLMJudge`,
  imported it, and never instantiated it — every score in the product came from
  a bag-of-words overlap heuristic while the UI and docs called it
  "LLM-as-judge". New `server/mo_evolve/metric.py` wires the judge in with an
  escalate-on-failure tier: the free heuristic runs first, and only candidates
  scoring below 0.85 are judged. That is precisely where GEPA's reflective
  mutation reads feedback, so the judge budget lands where it changes the
  outcome, at roughly a third of an always-judge run's cost. Cached, hard-capped,
  and failure-contained — a run whose judge failed >30% of calls is marked
  `degraded` and the gate refuses it.
- **Statistical acceptance gate** (`server/mo_evolve/gate.py`). A paired
  bootstrap CI over the per-example holdout deltas, with a minimum effect size
  and a minimum sample count. Replaces `improvement > 0`, which was printed to a
  log and enforced nowhere — a candidate that regressed on holdout could be
  deployed with one click.
- **Regression pin sets.** Each accepted run donates its holdout to
  `evolve/pins/<skill>.jsonl`; future candidates must not regress on the
  accumulated pins. A ratchet against "improves this week's rubric, breaks last
  month's", with no external benchmark.
- **Versioned skill archive with revert** (`server/mo_evolve/skill_archive.py`).
  Accepting used to be a bare `write_text` — no backup, no way back. Every
  accept now snapshots first and writes atomically; the app lists versions with
  one-click revert, and a revert is itself snapshotted.
- **Diff-scoped safety scan** (`server/mo_evolve/safety.py`). Only lines the
  rewrite *added* are scanned, so a skill that legitimately discusses `rm -rf`
  or prompt injection stays evolvable. High-severity patterns block the run;
  medium ones surface in the diff view.
- **Frozen frontmatter.** A skill's `name`/`description` is injected into every
  system prompt, while its body loads on demand — so frontmatter is the one
  part with an unconditional blast radius. It survived evolution only by
  accident of `reassemble_skill()`; now it's an enforced constraint.
- **Test suite.** `pytest server/tests` — no network, no real
  `~/.hermes-mo`. Includes a regression lock on the fix for upstream issue #141
  (skill body as a signature instruction rather than an inert attribute), which
  is what makes evolution a real mutation instead of a no-op. New CI job.

### Fixed

- **Stale-baseline clobber.** Accepting a run never compared the live
  `SKILL.md` against the run's baseline, so a nightly run started at 03:00 and
  accepted at 18:00 silently discarded every edit made in between. Now refused
  (409) unless explicitly forced — and forced or not, the overwritten text is
  archived.
- **Hot-swapping evolved skills into live sessions.** Writing a skill
  mid-conversation busts the prompt static-prefix cache and makes the next
  `skill_view` return text the turn wasn't planned against. Accepts are now
  marked pending and the UI reports 「下次新会话生效」.

### Changed

- Evolution state (runs, schedule, skill listing, auto-rotation) moved out of
  the `mo-gateway.py` closure into `server/mo_evolve/store.py`. The gateway file
  has a hyphen in its name and so cannot be imported — that, not oversight, was
  the root cause of having no tests. Route handlers now delegate.
- The diff modal shows the gate verdict, how the scores were produced
  (`metric_mode`, judge call counts, cache hits), and a collusion warning when
  the judge and optimizer models are identical. A failing gate turns 采纳 into a
  two-step force-confirm rather than hiding the candidate.
- `docs/self-evolution.md` rewritten. It previously claimed LLM-as-judge scoring
  (untrue until now) and that evolution ran against a private copy of the skills
  (it has always run against the live directory). Both corrected, and a
  "What 夜貘 cannot do yet" section added.

### Added
- Initial public release of **Mo**, a desktop self-evolving agent.
- Electron + React 19 desktop app (`app/`) with chat, settings, model
  configuration (endpoint library), and a self-evolution view.
- GEPA-based skill self-evolution engine (`server/vendor/evolution/`) with
  baseline-aware size/growth constraints.
- Python gateway (`server/mo-gateway.py`) mounting `/api/mo/*` routes on the
  vendored Hermes Agent core.
- Bundled Hermes Agent core (Nous Research, MIT) under `vendor/hermes-agent/`.
- Short-message recall skip (`MO_RECALL_MIN_CHARS`) to avoid pointless vector
  searches on trivial greetings.

### Fixed
- **Self-evolution failed on a clean install.** `dspy` is imported by the GEPA
  engine but was never installed — `scripts/setup.sh` now installs `dspy>=3.2`
  into the core venv, and the docs call it out. The CI smoke test previously
  imported only the two dspy-free modules and passed while the feature was
  broken; it now imports the real entry points.
- Renderer TypeScript was never typechecked (`tsconfig.main.json` covers only
  the main process, and Vite strips types without checking). Added
  `app/tsconfig.renderer.json` and wired it into CI.
- Bumped `dompurify` 3.4.9 → 3.4.12 and `fast-uri` 3.1.2 → 3.1.4, clearing all
  known advisories in the production dependency tree.

### Security
- Added a Content-Security-Policy to the renderer and `setWindowOpenHandler` /
  `will-navigate` guards to the main process, so links in agent output can't
  navigate the app window or open Electron windows.
- Added `SECURITY.md` with a private disclosure process and an explicit scope.
- Broadened `.gitignore` to cover key/certificate patterns.

### Removed
- **License compliance:** the Anthropic-licensed `docx`, `pdf` and `xlsx` skills
  (© Anthropic, PBC — all rights reserved) were removed, alongside the already
  removed `powerpoint`. All bundled font binaries were removed as well; the
  vendored dashboard falls back to system fonts. `scripts/update-hermes.sh`
  re-applies these strips and now fails the build if any survive, and CI
  enforces both rules independently.
- The MinT LoRA training scripts (`server/vendor/finetune/`) are no longer
  bundled. Fine-tuning ships as a scaffold; supplying a MinT key without
  installing the scripts now fails with an explanatory message instead of a
  bare `FileNotFoundError`.

### Changed
- `NOTICE`, `README` and `THIRD_PARTY_LICENSES/` corrected: the self-evolution
  engine (`server/vendor/evolution/`) is vendored from Nous Research's
  hermes-agent-self-evolution under MIT, not original work. Its license text is
  now preserved in-tree and its attribution recorded. `NOTICE` also referenced
  two paths (`server/evolution/`, `server/gateway.py`) that do not exist.
- Documented the Chinese-only UI, the fine-tuning limitation and the Google
  Fonts request in the README's known-limitations table.

### Notes
- macOS (Apple Silicon) only for now.
- Non-redistributable material (Anthropic `powerpoint`/`docx`/`pdf`/`xlsx`
  skills, conference LaTeX templates, licensed fonts) is stripped for MIT
  compliance — see `THIRD_PARTY_LICENSES/`.

[Unreleased]: https://github.com/dctongsheng/mo-agent
