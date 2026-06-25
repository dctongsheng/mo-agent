"""Convert prompts/completions to MinT Datum objects."""
from __future__ import annotations

import json
from pathlib import Path

import mint
import torch
from mint import types
from tinker_cookbook.supervised.common import datum_from_model_input_weights


def make_completion_datum(prompt: str, completion: str, tokenizer) -> mint.Datum:
    full = prompt + completion
    tokens = tokenizer.encode(full, add_special_tokens=False)
    prompt_len = len(tokenizer.encode(prompt, add_special_tokens=False))
    weights = torch.zeros(len(tokens), dtype=torch.float32)
    if prompt_len < len(tokens):
        weights[prompt_len:] = 1.0
    model_input = types.ModelInput.from_ints(tokens)
    return datum_from_model_input_weights(model_input, weights, reduction="none")


def load_sft_jsonl(path: Path) -> list[tuple[str, str]]:
    examples: list[tuple[str, str]] = []
    with path.open(encoding="utf-8") as f:
        for line_no, line in enumerate(f, start=1):
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            if "prompt" not in row or "completion" not in row:
                raise ValueError(
                    f"{path}:{line_no}: expected keys 'prompt' and 'completion'"
                )
            examples.append((row["prompt"], row["completion"]))
    if not examples:
        raise ValueError(f"No examples found in {path}")
    return examples


def load_dpo_jsonl(path: Path) -> list[tuple[str, str, str]]:
    examples: list[tuple[str, str, str]] = []
    with path.open(encoding="utf-8") as f:
        for line_no, line in enumerate(f, start=1):
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            for key in ("prompt", "chosen", "rejected"):
                if key not in row:
                    raise ValueError(f"{path}:{line_no}: missing key {key!r}")
            examples.append((row["prompt"], row["chosen"], row["rejected"]))
    if not examples:
        raise ValueError(f"No examples found in {path}")
    return examples
