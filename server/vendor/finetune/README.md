# mint-lora-training

Cloud-hosted MinT LoRA training workflows for macaron.im.

## When to Use

Use this skill when you want an agent to run LoRA training through MinT (Mind
Lab Toolkit), where local scripts orchestrate API calls and the actual
forward/backward passes, optimization, sampling, and adapter storage happen on
MinT servers.

Do not use it for local CUDA GRPO training. Use
[`grpo-finetune`](../grpo-finetune/README.md) for that workflow.

## Requirements

- Python 3.11+
- Network access to MinT
- `MINT_API_KEY` from https://mint-console.macaron.xin/login
- No local GPU is required for training

Never commit API keys, `.env` files, downloaded adapters, or training outputs.

## Quick Start

From the repository root:

```bash
cd skills/mint-lora-training/scripts
bash setup_env.sh
source .venv/bin/activate

export MINT_API_KEY="sk-***"
export MINT_BASE_URL="https://mint.macaron.xin"

python train_sft.py --smoke
```

Expected smoke-test output includes `train_nll`, a `tinker_path`, and
`=== SFT TRAINING PASSED ===`.

## Common Workflows

- Setup and connectivity: `workflows/setup.md`
- Supervised fine-tuning: `workflows/sft.md`
- DPO alignment: `workflows/dpo.md`
- GRPO / RL loops: `workflows/grpo.md`
- Adapter download: `scripts/download_lora.py`
- Quota check: `scripts/check_quota.py`

## Notes on Quota and APIs

`check_quota.py` uses MinT usage endpoints that may change over time. Treat the
reported remaining quota as an estimate and confirm billing or quota-sensitive
runs in the MinT console before large jobs.

## Local Deployment After Training

Training happens on MinT. After downloading an adapter, local deployment is a
separate step. The reference guide includes examples for Transformers + PEFT and
vLLM LoRA loading.
