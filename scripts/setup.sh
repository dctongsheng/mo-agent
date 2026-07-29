#!/usr/bin/env bash
# Mo — one-time development setup.
# Installs the desktop app's Node dependencies and creates a Python virtualenv
# for the vendored Hermes Agent core.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "==> Mo setup ($ROOT)"

# --- Node / app deps --------------------------------------------------------
if ! command -v npm >/dev/null 2>&1; then
  echo "ERROR: npm not found. Install Node.js >= 18 first." >&2
  exit 1
fi
echo "==> Installing app dependencies (npm)…"
( cd app && npm install )

# --- Python venv for the vendored core --------------------------------------
PY="${PYTHON:-python3.11}"
if ! command -v "$PY" >/dev/null 2>&1; then
  PY="python3"
fi
echo "==> Creating Python venv at vendor/hermes-agent/.venv ($PY)…"
( cd vendor/hermes-agent
  "$PY" -m venv .venv
  ./.venv/bin/pip install --upgrade pip >/dev/null
  # [messaging] pulls aiohttp/discord.py/slack-sdk. Without it the Telegram,
  # Discord and Slack platform adapters in ~/.hermes-mo/config.yaml fail to
  # load ("No module named 'aiohttp'") and the gateway starts without them.
  echo "==> Installing Hermes Agent core (pip install -e '.[messaging]')…"
  ./.venv/bin/pip install -e ".[messaging]"
)

# --- Self-evolution runtime dependency --------------------------------------
# The GEPA engine (server/vendor/evolution/) imports dspy at module load —
# without it, Mo's headline self-evolution feature fails with ModuleNotFoundError
# the first time a run is started. dspy is not a Hermes dependency, so it has to
# be installed explicitly. >=3.2 is required: evolve_skill.py uses the newer GEPA
# signature (feedback metric, reflection_lm, max_metric_calls).
echo "==> Installing self-evolution dependency (dspy)…"
vendor/hermes-agent/.venv/bin/pip install "dspy>=3.2"

# Dev only: `pytest server/tests` covers the evolution core (judge tiering,
# acceptance gate, skill archive, safety scan). No test touches the network.
vendor/hermes-agent/.venv/bin/pip install pytest >/dev/null

cat <<'DONE'

==> Done.

Next steps:
  1. Copy the env template:   cp .env.example ~/.hermes-mo/.env   (then fill in keys)
  2. Configure your model in  ~/.hermes-mo/config.yaml             (see docs/configuration.md)
  3. Launch the app:          cd app && npm run dev
DONE
