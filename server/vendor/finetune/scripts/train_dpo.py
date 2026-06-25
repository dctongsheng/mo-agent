#!/usr/bin/env python3
"""MinT DPO training skeleton — validates data and delegates to tinker_cookbook for full runs.

Full DPO requires reference-model logprobs and forward_backward_custom. See workflows/dpo.md
and tinker_cookbook.preference.train_dpo for production training.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from lib.config import DEFAULT_PROD_MODEL
from lib.datum_utils import load_dpo_jsonl
from lib.mint_client import ensure_env, get_service_client, create_lora_training_client


def main() -> int:
    parser = argparse.ArgumentParser(description="MinT DPO training skeleton")
    parser.add_argument("--base-model", default=DEFAULT_PROD_MODEL)
    parser.add_argument("--run-name", default="mint-dpo-run")
    parser.add_argument("--data", required=True, help="DPO JSONL: prompt, chosen, rejected")
    parser.add_argument("--rank", type=int, default=64)
    parser.add_argument("--lr", type=float, default=1e-5, help="DPO typical lr ~1e-5")
    parser.add_argument("--dpo-beta", type=float, default=0.1)
    parser.add_argument("--steps", type=int, default=1)
    parser.add_argument(
        "--validate-only",
        action="store_true",
        help="Only validate JSONL and print summary",
    )
    args = parser.parse_args()

    examples = load_dpo_jsonl(Path(args.data))
    print(f"Loaded {len(examples)} preference pairs from {args.data}")

    if args.validate_only:
        for i, (prompt, chosen, rejected) in enumerate(examples[:3], start=1):
            print(f"  [{i}] prompt={prompt[:40]!r}... chosen={chosen[:30]!r}...")
        print("Validation OK. Run full DPO via tinker_cookbook (see workflows/dpo.md).")
        return 0

    ensure_env()
    print("=== MinT DPO skeleton ===")
    print("base_model:", args.base_model)
    print("dpo_beta:", args.dpo_beta)
    print()
    print(
        "Full DPO needs reference-model forward passes + forward_backward_custom.\n"
        "This skeleton validates connectivity only. For production DPO:\n"
        "  1. Read workflows/dpo.md\n"
        "  2. Use tinker_cookbook.recipes.preference.dpo.train with import mint\n"
        "  3. Or extend this script using tinker_cookbook.preference.train_dpo.main\n"
    )

    service_client = get_service_client()
    training_client = create_lora_training_client(
        service_client,
        base_model=args.base_model,
        rank=args.rank,
    )
    print("Training client created (connectivity OK).")
    print("Implement DPO loop with forward_backward_custom — see workflows/dpo.md")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
