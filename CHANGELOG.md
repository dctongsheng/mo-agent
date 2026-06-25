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

### Notes
- macOS (Apple Silicon) only for now.
- Non-redistributable bundled skills (Anthropic `powerpoint`, conference LaTeX
  templates) were removed for MIT compliance — see `THIRD_PARTY_LICENSES/`.

[Unreleased]: https://github.com/Taiyi-AI-Lab/mo-agent
