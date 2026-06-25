# GRPO / RL Workflow

## When to use

Optimize from rewards, verifiers, or environment feedback (math grading, tool success, human preference scores).

## Recommended path

1. **SFT warm-start** — `train_sft.py` on demonstration data
2. **GRPO** — sample rollouts, compute rewards, train with `importance_sampling`

## Reward function

Create `reward_fn.py`:

```python
def get_reward(response: str, context: dict) -> float:
    """context may include 'prompt', 'ground_truth', etc."""
    expected = context.get("ground_truth", "")
    return 1.0 if expected in response else 0.0
```

Validate:

```bash
python train_grpo.py --reward-fn reward_fn.py --validate-only
```

## GRPO loop (conceptual)

```
for step in range(num_steps):
    rollouts = sampling_client.sample(prompts)
    rewards = [get_reward(r, ctx) for r, ctx in zip(rollouts, contexts)]
    advantages = center_rewards_per_group(rewards)  # GRPO
    datums = build_importance_sampling_datums(rollouts, advantages)
    training_client.forward_backward(datums, loss_fn="importance_sampling")
    training_client.optim_step(...)
training_client.save_weights_for_sampler(name=run_name)
```

## Production reference

- `tinker_cookbook.recipes.rl_loop` — GSM8K GRPO example
- `tinker_cookbook.rl.train` — general RL training utilities
- MinT blog: experiential intelligence + reward-driven LoRA

## Hyperparameters (starting point)

| Param | Value |
|-------|-------|
| model | `Qwen/Qwen3-4B-Instruct-2507` |
| learning_rate | 4e-5 |
| rank | 64 |
| group_size | 8–16 (for variance reduction) |

## Post-training

`eval_compare.py` → `download_lora.py --to-peft` → `check_quota.py`.

## Notes

- GRPO uses more tokens than SFT (rollout + training)
- Start with small batch/group before scaling
- See [pitfalls.md](../pitfalls.md) for train/rollout consistency issues at large scale
