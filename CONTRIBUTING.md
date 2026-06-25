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

- **App / TypeScript:** `cd app && npm run build:all` must pass (the CI runs
  `tsc` + a renderer build).
- **Python:** keep `server/mo-gateway.py` importable and the evolution engine
  loading: `python -c "import sys; sys.path.insert(0,'server/vendor'); import evolution"`.
- **Don't commit** secrets, `node_modules/`, build output, or anything under
  `~/.hermes-mo/`. The `.gitignore` covers the common cases — double-check `git diff --cached`.
- **Licensing:** do not add third-party code under non-permissive terms. If you
  vendor something, preserve its license and add it to `THIRD_PARTY_LICENSES/`.

## Scope of the vendored core

`vendor/hermes-agent/` is a snapshot of the MIT-licensed Hermes Agent. Bug fixes
that belong upstream should be sent to the Hermes project; vendor changes here
only when necessary to keep Mo working, and document why.

## Commit messages

Conventional, imperative summaries are appreciated (`fix:`, `feat:`, `docs:`…),
with a short body explaining the *why*.

By contributing, you agree your contributions are licensed under the project's
[MIT License](LICENSE).
