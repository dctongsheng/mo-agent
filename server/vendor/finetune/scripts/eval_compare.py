#!/usr/bin/env python3
"""Compare base model vs fine-tuned LoRA adapter sampling on the same prompts."""
from __future__ import annotations

import argparse
import sys
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import mint
from mint import types
from tinker_cookbook.tokenizer_utils import get_tokenizer

from lib.config import DEFAULT_SMOKE_MODEL
from lib.mint_client import ensure_env, get_service_client


def load_prompts(path: Path | None) -> list[str]:
    if path is None:
        return [
            "Question: 3+5?\nAnswer:",
            "Question: capital of Japan?\nAnswer:",
            "Translate to Spanish: thank you\nAnswer:",
        ]
    lines = [line.strip() for line in path.read_text(encoding="utf-8").splitlines()]
    return [line for line in lines if line]


def sample(
    service_client: mint.ServiceClient,
    *,
    base_model: str,
    tinker_path: str | None,
    prompt_text: str,
    tokenizer,
    max_tokens: int,
    temperature: float,
) -> str:
    if tinker_path:
        client = service_client.create_sampling_client(
            model_path=tinker_path,
            base_model=base_model,
        )
    else:
        client = service_client.create_sampling_client(base_model=base_model)

    prompt = types.ModelInput.from_ints(
        tokenizer.encode(prompt_text, add_special_tokens=False)
    )
    params = types.SamplingParams(max_tokens=max_tokens, temperature=temperature)
    result = client.sample(prompt=prompt, num_samples=1, sampling_params=params).result()
    return tokenizer.decode(result.sequences[0].tokens, skip_special_tokens=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Base vs adapter sampling comparison")
    parser.add_argument("--base-model", default=DEFAULT_SMOKE_MODEL)
    parser.add_argument(
        "--tinker-path",
        required=True,
        help="Fine-tuned adapter tinker path",
    )
    parser.add_argument(
        "--prompts",
        type=Path,
        default=None,
        help="Text file with one prompt per line",
    )
    parser.add_argument("--max-tokens", type=int, default=64)
    parser.add_argument("--temperature", type=float, default=0.7)
    args = parser.parse_args()

    ensure_env()
    prompts = load_prompts(args.prompts)
    tokenizer = get_tokenizer(args.base_model)
    service_client = get_service_client()

    print("=== Eval: base vs adapter ===")
    print("base_model:", args.base_model)
    print("tinker_path:", args.tinker_path)
    print()

    for i, prompt_text in enumerate(prompts, start=1):
        print(f"--- Prompt {i} ---")
        print("prompt:", repr(prompt_text))
        try:
            base_out = sample(
                service_client,
                base_model=args.base_model,
                tinker_path=None,
                prompt_text=prompt_text,
                tokenizer=tokenizer,
                max_tokens=args.max_tokens,
                temperature=args.temperature,
            )
            print("base:   ", repr(base_out))
        except Exception as exc:
            print("base:    ERROR:", exc)

        adapter_out = sample(
            service_client,
            base_model=args.base_model,
            tinker_path=args.tinker_path,
            prompt_text=prompt_text,
            tokenizer=tokenizer,
            max_tokens=args.max_tokens,
            temperature=args.temperature,
        )
        print("adapter:", repr(adapter_out))
        print()

    print("=== EVAL COMPLETE ===")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception:
        traceback.print_exc()
        raise SystemExit(1)
