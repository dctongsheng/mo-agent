#!/usr/bin/env python3
"""MinT LoRA SFT training script (generalized smoke test + custom JSONL)."""
from __future__ import annotations

import argparse
import os
import sys
import traceback
from pathlib import Path

# Allow running from scripts/ with lib imports
sys.path.insert(0, str(Path(__file__).resolve().parent))

import mint
from mint import types
from tinker_cookbook.supervised.common import compute_mean_nll
from tinker_cookbook.tokenizer_utils import get_tokenizer

from lib.config import SMOKE_EXAMPLES, add_common_train_args, parse_train_config
from lib.datum_utils import load_sft_jsonl, make_completion_datum
from lib.mint_client import (
    adam_params,
    create_lora_training_client,
    ensure_env,
    get_service_client,
)


def sample_once(
    training_client,
    tokenizer,
    tinker_path: str,
    prompt_text: str,
) -> str:
    sampling_client = training_client.create_sampling_client(model_path=tinker_path)
    prompt = types.ModelInput.from_ints(
        tokenizer.encode(prompt_text, add_special_tokens=False)
    )
    params = types.SamplingParams(max_tokens=32, temperature=0.7)
    sample_result = sampling_client.sample(
        prompt=prompt, num_samples=1, sampling_params=params
    ).result()
    return tokenizer.decode(sample_result.sequences[0].tokens, skip_special_tokens=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="MinT LoRA SFT training")
    add_common_train_args(parser)
    parser.add_argument(
        "--eval-prompt",
        default="Question: 3+5?\nAnswer:",
        help="Prompt for post-training sample",
    )
    parser.add_argument(
        "--no-sample",
        action="store_true",
        help="Skip post-training sampling",
    )
    args = parser.parse_args()
    cfg = parse_train_config(args)

    ensure_env()
    print("=== MinT SFT training ===")
    print("TINKER_BASE_URL:", os.environ.get("TINKER_BASE_URL"))
    print("MINT_API_KEY set:", bool(os.environ.get("MINT_API_KEY")))
    print("base_model:", cfg.base_model)
    print("run_name:", cfg.run_name)
    print("rank:", cfg.rank)
    print("steps:", cfg.steps)

    if cfg.data_path:
        examples = load_sft_jsonl(Path(cfg.data_path))
    else:
        examples = SMOKE_EXAMPLES

    tokenizer = get_tokenizer(cfg.base_model)
    batch = [make_completion_datum(p, c, tokenizer) for p, c in examples]
    print("Batch size:", len(batch))

    service_client = get_service_client()
    training_client = create_lora_training_client(
        service_client,
        base_model=cfg.base_model,
        rank=cfg.rank,
    )

    for step in range(1, cfg.steps + 1):
        print(f"Step {step}/{cfg.steps}: forward_backward (cross_entropy)...")
        fb_result = training_client.forward_backward(
            batch, loss_fn="cross_entropy"
        ).result()
        logprobs = [x["logprobs"] for x in fb_result.loss_fn_outputs]
        weights = [d.loss_fn_inputs["weights"] for d in batch]
        train_nll = compute_mean_nll(logprobs, weights)
        print("train_nll:", train_nll)

        print(f"Step {step}/{cfg.steps}: optim_step...")
        training_client.optim_step(adam_params(cfg.learning_rate)).result()

    print(f"save_weights_for_sampler(name={cfg.run_name!r})...")
    save_result = training_client.save_weights_for_sampler(name=cfg.run_name).result()
    tinker_path = save_result.path
    print("tinker_path:", tinker_path)

    if not args.no_sample:
        print("sample prompt:", repr(args.eval_prompt))
        text = sample_once(training_client, tokenizer, tinker_path, args.eval_prompt)
        print("sample[0]:", repr(text))

    print("=== SFT TRAINING PASSED ===")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception:
        print("=== SFT TRAINING FAILED ===", file=sys.stderr)
        traceback.print_exc()
        raise SystemExit(1)
