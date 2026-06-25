# DPO Workflow

## When to use

Preference alignment from chosen/rejected response pairs.

## Recommended model

`Qwen/Qwen3-4B-Instruct-2507` (Community supports SFT + DPO + GRPO).

## Data preparation

Create `data/dpo.jsonl`:

```json
{
  "prompt": "Explain photosynthesis briefly.",
  "chosen": "Plants convert light into chemical energy via chlorophyll...",
  "rejected": "Photosynthesis is when plants eat sunlight for dinner."
}
```

## Validate data

```bash
python train_dpo.py --data data/dpo.jsonl --validate-only
```

## Full DPO training

DPO requires:

1. Policy LoRA training client
2. Reference model logprobs (frozen base or separate client)
3. `forward_backward_custom` with DPO loss

**Production path:** use `tinker_cookbook.preference.train_dpo` with `import mint`:

```python
import mint  # must be first
from tinker_cookbook.preference import train_dpo
# Configure via train_dpo.Config — see cookbook recipes/preference/dpo/
```

Official guide: https://mint-doc.macaron.im (DPO section) and tinker cookbook DPO README.

## Hyperparameters (starting point)

| Param | Value |
|-------|-------|
| learning_rate | 1e-5 |
| dpo_beta | 0.1 |
| rank | 64 |

## Post-training

Same as SFT: `eval_compare.py` → `download_lora.py --to-peft` → `check_quota.py`.

## Typical pipeline

SFT warm-start → DPO refinement on preference data.
