# Contributing to Mo

Thanks for your interest in improving Mo! This guide covers how the project is
laid out and how to make a change.

## Project layout

| Path | What it is |
|------|------------|
| `app/` | Electron + React 19 desktop app (your contributions to the UI/main process go here) |
| `server/` | Python gateway (`mo-gateway.py`) + the self-evolution engine (`server/vendor/evolution/`) |
| `vendor/hermes-agent/` | **Vendored** Hermes Agent core (Nous Research, MIT). Treat as a dependency — avoid editing it directly; prefer upstreaming changes to Hermes. |

## Development setup

```bash
# one-time
./scripts/setup.sh          # installs app deps + creates the Python venv

# run
cd app && npm run dev
```

See [docs/configuration.md](docs/configuration.md) for model/provider config.

## Before you open a PR

- **App / TypeScript:** all three must pass —

  ```bash
  cd app
  npx tsc -p tsconfig.main.json --noEmit    # main process
  npx tsc -p tsconfig.renderer.json         # renderer (Vite does NOT typecheck)
  npm run build:all
  ```

- **Python:** keep `server/mo-gateway.py` compiling and the evolution engine's
  real entry points importable (not just the dspy-free modules):

  ```bash
  python -m py_compile server/mo-gateway.py
  python -c "import sys; sys.path.insert(0,'server/vendor'); import evolution.skills.evolve_skill"
  ```

  The second command needs `dspy>=3.2` in the active interpreter —
  `./scripts/setup.sh` installs it into `vendor/hermes-agent/.venv`.

  Note the import must succeed with **only** `server/vendor` on the path. The
  engine imports `mo_evolve.*` behind `try/except ImportError`, and this is what
  proves those guards work.

- **Tests:** the self-evolution core is covered; keep it green.

  ```bash
  cd server && python -m pytest tests
  ```

  No test may touch the network or a real `~/.hermes-mo` — use the
  `tmp_hermes_home` and `FakeJudge` fixtures in `server/tests/conftest.py`.

- **Touching self-evolution?** Also walk the manual end-to-end checklist below.
  The unit tests cover the decision logic; they don't cover a real GEPA run.

### Manual E2E checklist (self-evolution changes)

Unit tests can't tell you whether a real optimizer run still produces the files
the gateway expects. Run this once per change to the evolution pipeline:

1. Create a custom skill under `~/.hermes-mo/skills/<name>/SKILL.md` and run one
   evolution from the app. Confirm the run reaches `done` and the diff modal
   shows a **gate banner** and a **评分方式** line (not just an improvement number).
2. Check `metrics.json` in the run's output dir: `fitness.metric_mode` should be
   `tiered`, with a non-zero `judge_calls` and a plausible `cache_hits`. If
   `metric_mode` is `heuristic`, the `mo_evolve` import failed — check
   `PYTHONPATH` in `_spawn_evolution`.
3. **Force the gate to fail:** hand-edit the run's `evolved_skill.md` into an
   obviously worse variant, or lower `min_effect`'s inverse by editing
   `gate.json`'s `passed` to `false`. Confirm 采纳 becomes a two-step
   `确认强制采纳` rather than deploying.
4. **Revert:** after a forced accept, use 版本与回退 to restore the previous
   version and confirm the file is byte-identical to the original
   (`diff` should be empty).
5. **Staleness:** start a run, edit the live `SKILL.md` by hand while it runs,
   then accept. It must be refused with a message about overwriting your edits.
- **Don't commit** secrets, `node_modules/`, build output, or anything under
  `~/.hermes-mo/`. The `.gitignore` covers the common cases — double-check `git diff --cached`.
- **Licensing:** do not add third-party code under non-permissive terms. If you
  vendor something, preserve its license and add it to `THIRD_PARTY_LICENSES/`.
  CI enforces two hard rules: no Anthropic-proprietary skill material, and no
  font binaries. Both have bitten this repo before — see
  `THIRD_PARTY_LICENSES/README.md`.

## Scope of the vendored core

`vendor/hermes-agent/` is a snapshot of the MIT-licensed Hermes Agent. Bug fixes
that belong upstream should be sent to the Hermes project; vendor changes here
only when necessary to keep Mo working, and document why.

## Commit messages

Conventional, imperative summaries are appreciated (`fix:`, `feat:`, `docs:`…),
with a short body explaining the *why*.

By contributing, you agree your contributions are licensed under the project's
[MIT License](LICENSE).
