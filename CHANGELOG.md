# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/Taiyi-AI-Lab/mo-agent
