# Configuration

All runtime state lives in **`~/.hermes-mo/`** (a dedicated Hermes home, so Mo never collides with a system-wide Hermes).

## Python environment

The vendored Hermes core (`vendor/hermes-agent/`) needs its dependencies installed. The app's `python-bridge.ts` looks for an interpreter in this order:

1. `vendor/hermes-agent/.venv/bin/python3`
2. `<repo>/.venv/bin/python3`
3. `~/.hermes/hermes-agent/venv/bin/python` (a developer's existing Hermes install)
4. `python3` on `PATH`

The recommended setup is a venv next to the vendored core:

```bash
cd vendor/hermes-agent
python3.11 -m venv .venv
./.venv/bin/pip install -e .     # uses vendor/hermes-agent/pyproject.toml
```

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
- **Fine-tuning** — the MinT training key.

## Memory (OpenViking)

Semantic memory uses OpenViking, configured at `~/.openviking/ov.conf`. The embedding model and dimension are set there (the app writes this file when you pick an embedding model). Recall for very short messages is skipped — tune the threshold with the `MO_RECALL_MIN_CHARS` environment variable (default `6`, set `0` to always recall).

## Local models (Ollama)

If Ollama is running, the app's local-models screen lists installed models and can register them as a `custom` provider with `base_url` pointing at the local Ollama server — no API key needed.
