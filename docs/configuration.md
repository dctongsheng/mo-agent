# Configuration

All runtime state lives in **`~/.hermes-mo/`** (a dedicated Hermes home, so Mo never collides with a system-wide Hermes).

## Python environment

The vendored Hermes core (`vendor/hermes-agent/`) needs its dependencies installed. The app's `python-bridge.ts` looks for an interpreter in this order:

1. `vendor/hermes-agent/.venv/bin/python3`
2. `<repo>/.venv/bin/python3`
3. `~/.hermes/hermes-agent/venv/bin/python` (a developer's existing Hermes install)
4. `python3` on `PATH`

The recommended setup is a venv next to the vendored core. `./scripts/setup.sh`
does exactly this for you; the manual equivalent is:

```bash
cd vendor/hermes-agent
python3.11 -m venv .venv
./.venv/bin/pip install -e ".[messaging]"   # uses vendor/hermes-agent/pyproject.toml
./.venv/bin/pip install "dspy>=3.2"         # required by the self-evolution engine
```

Two details are easy to miss and both cause silent feature loss:

- **`[messaging]`** pulls `aiohttp` / `discord.py` / `slack-sdk`. Without it the
  Telegram, Discord and Slack adapters configured in `~/.hermes-mo/config.yaml`
  fail to load (`No module named 'aiohttp'`) and the gateway starts without them.
- **`dspy>=3.2`** is imported by `server/vendor/evolution/`. It is *not* a Hermes
  dependency, so a plain `pip install -e .` leaves self-evolution broken with
  `ModuleNotFoundError: No module named 'dspy'` on the first run.

If you already have a Python with `dspy` on your `PATH`, note that the app does
**not** use it: `python-bridge.ts` prefers `vendor/hermes-agent/.venv/bin/python3`
(entry 1 in the list above). Install into that venv, not into your shell's
default interpreter.

## Model providers

Copy the example env and fill in your keys:

```bash
cp .env.example ~/.hermes-mo/.env
```

`~/.hermes-mo/config.yaml` selects the default model and provider. Mo supports any OpenAI-compatible endpoint plus local models via Ollama. Example:

```yaml
model:
  provider: custom:myprovider
  default: My-Model-Name
custom_providers:
  - name: myprovider
    base_url: https://api.example.com/v1
    api_key: sk-...
memory:
  provider: openviking
```

### Endpoint library (recommended)

Rather than re-entering a base URL + key for every scenario, register a provider **once** in the in-app endpoint library, then just pick a model per scenario:

- **Chat** — the main conversation model (Atelier screen).
- **Embedding** — the memory recall model (writes `~/.openviking/ov.conf`).
- **Self-evolution** — optimizer + judge models (`mo-config/evolve.json`).
- **Fine-tuning** — the MinT training key (see the limitation below).

## Fine-tuning (scaffold only)

The open-source build ships fine-tuning as a **scaffold**: it collects
trajectories, generates SFT/DPO datasets and keeps a run ledger, but it does
**not** include the MinT cloud-training scripts — those are not redistributed
here (see [`THIRD_PARTY_LICENSES/README.md`](../THIRD_PARTY_LICENSES/README.md)).

Runs therefore complete in scaffold mode and record what *would* have been
executed. If you supply a MinT API key without installing the scripts, the run
is marked failed with an explanatory log rather than crashing. To enable real
training, install `mint-lora-training` into `server/vendor/finetune/` yourself.

## Memory (OpenViking)

Semantic memory uses OpenViking, configured at `~/.openviking/ov.conf`. The embedding model and dimension are set there (the app writes this file when you pick an embedding model). Recall for very short messages is skipped — tune the threshold with the `MO_RECALL_MIN_CHARS` environment variable (default `6`, set `0` to always recall).

## Local models (Ollama)

If Ollama is running, the app's local-models screen lists installed models and can register them as a `custom` provider with `base_url` pointing at the local Ollama server — no API key needed.
