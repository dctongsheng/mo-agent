#!/usr/bin/env bash
# Create venv and install mindlab-toolkit for MinT LoRA training.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="${VENV_DIR:-$SCRIPT_DIR/.venv}"

if ! command -v python3.11 >/dev/null 2>&1; then
  echo "python3.11 is required (MinT SDK needs Python 3.11+)." >&2
  exit 1
fi

python3.11 -m venv "$VENV_DIR"
# shellcheck disable=SC1091
source "$VENV_DIR/bin/activate"
pip install -U pip wheel
pip install "git+https://github.com/MindLab-Research/mindlab-toolkit.git"

python -c "import mint; print('mint OK:', mint.__file__)"
echo "Venv ready: $VENV_DIR"
echo "Activate: source $VENV_DIR/bin/activate"
