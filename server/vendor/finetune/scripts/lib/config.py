"""Shared CLI defaults for MinT training scripts."""
from __future__ import annotations

import argparse
from dataclasses import dataclass


SMOKE_EXAMPLES = [
    ("Question: 2+2?\nAnswer:", " 4"),
    ("Question: capital of France?\nAnswer:", " Paris"),
    ("Translate to French: hello\nAnswer:", " bonjour"),
    ("Color of sky?\nAnswer:", " blue"),
]

DEFAULT_SMOKE_MODEL = "Qwen/Qwen3-0.6B"
DEFAULT_PROD_MODEL = "Qwen/Qwen3-4B-Instruct-2507"
DEFAULT_BASE_URL = "https://mint.macaron.xin"
COMMUNITY_TOKEN_QUOTA = 5_000_000


@dataclass
class TrainConfig:
    base_model: str
    run_name: str
    rank: int
    learning_rate: float
    steps: int
    data_path: str | None
    smoke: bool


def add_common_train_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--base-model",
        default=DEFAULT_SMOKE_MODEL,
        help=f"Base model (default: {DEFAULT_SMOKE_MODEL})",
    )
    parser.add_argument(
        "--run-name",
        default="mint-lora-run",
        help="Checkpoint name for save_weights_for_sampler",
    )
    parser.add_argument("--rank", type=int, default=16, help="LoRA rank")
    parser.add_argument("--lr", type=float, default=1e-4, help="Adam learning rate")
    parser.add_argument("--steps", type=int, default=1, help="Training steps")
    parser.add_argument(
        "--data",
        dest="data_path",
        default=None,
        help="Path to JSONL training data",
    )
    parser.add_argument(
        "--smoke",
        action="store_true",
        help="Use built-in smoke examples (4 samples, Qwen3-0.6B defaults)",
    )


def parse_train_config(args: argparse.Namespace) -> TrainConfig:
    if args.smoke:
        args.base_model = DEFAULT_SMOKE_MODEL
        args.run_name = args.run_name if args.run_name != "mint-lora-run" else "mint-smoke-qwen3-0.6b"
        args.rank = 16
        args.steps = 1
        args.data_path = None
    return TrainConfig(
        base_model=args.base_model,
        run_name=args.run_name,
        rank=args.rank,
        learning_rate=args.lr,
        steps=args.steps,
        data_path=args.data_path,
        smoke=args.smoke,
    )
