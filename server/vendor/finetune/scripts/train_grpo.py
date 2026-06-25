#!/usr/bin/env python3
"""MinT GRPO / RL training skeleton — reward hook + importance_sampling guidance.

Production GRPO requires rollout → reward → forward_backward(loss_fn='importance_sampling').
See workflows/grpo.md and tinker_cookbook.recipes.rl_loop.
"""
from __future__ import annotations

import argparse
import importlib.util
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from lib.config import DEFAULT_PROD_MODEL
from lib.mint_client import ensure_env, get_service_client, create_lora_training_client


def load_reward_fn(path: Path):
    spec = importlib.util.spec_from_file_location("reward_module", path)
    if spec is None or spec.loader is None:
        raise ValueError(f"Cannot load reward module: {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if not hasattr(module, "get_reward"):
        raise ValueError(f"{path} must define get_reward(response: str, context: dict) -> float")
    return module.get_reward


def main() -> int:
    parser = argparse.ArgumentParser(description="MinT GRPO training skeleton")
    parser.add_argument("--base-model", default=DEFAULT_PROD_MODEL)
    parser.add_argument("--run-name", default="mint-grpo-run")
    parser.add_argument("--rank", type=int, default=64)
    parser.add_argument("--lr", type=float, default=4e-5)
    parser.add_argument(
        "--reward-fn",
        type=Path,
        help="Python file with get_reward(response, context) -> float",
    )
    parser.add_argument(
        "--validate-only",
        action="store_true",
        help="Validate env and reward fn only",
    )
    args = parser.parse_args()

    ensure_env()
    print("=== MinT GRPO skeleton ===")
    print("base_model:", args.base_model)
    print("loss_fn: importance_sampling (GRPO-style)")
    print()

    if args.reward_fn:
        reward_fn = load_reward_fn(args.reward_fn)
        score = reward_fn("test response", {"prompt": "hello"})
        print(f"Reward fn loaded from {args.reward_fn}, smoke score={score}")
    else:
        print("No --reward-fn provided. GRPO requires a reward/verifier function.")

    if args.validate_only:
        service_client = get_service_client()
        create_lora_training_client(
            service_client, base_model=args.base_model, rank=args.rank
        )
        print("Validation OK. See workflows/grpo.md for full RL loop.")
        return 0

    print(
        "Full GRPO loop steps:\n"
        "  1. Sample rollouts via sampling_client\n"
        "  2. Score with get_reward()\n"
        "  3. Build datums with advantages (GRPO: center rewards within group)\n"
        "  4. forward_backward(datums, loss_fn='importance_sampling')\n"
        "  5. optim_step → save_weights_for_sampler\n"
        "\nRecommended: start with SFT (train_sft.py), then GRPO.\n"
        "Reference: tinker_cookbook.recipes.rl_loop\n"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
