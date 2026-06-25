# SFT Workflow

## When to use

Supervised fine-tuning on prompt→completion pairs (instruction tuning, domain Q&A).

## Data preparation

Create `data/sft.jsonl`:

```json
{"prompt": "Question: 2+2?\nAnswer:", "completion": " 4"}
{"prompt": "Translate to French: hello\nAnswer:", "completion": " bonjour"}
```

## Smoke test (no data file)

```bash
python train_sft.py --smoke
```

Equivalent to the original MinT smoke SFT flow.

## Production training

```bash
python train_sft.py \
  --base-model Qwen/Qwen3-4B-Instruct-2507 \
  --run-name my-domain-sft \
  --data data/sft.jsonl \
  --rank 64 \
  --lr 1e-4 \
  --steps 50
```

## Post-training

1. Record `tinker_path` from output
2. Run eval:

```bash
python eval_compare.py \
  --base-model Qwen/Qwen3-4B-Instruct-2507 \
  --tinker-path "tinker://RUN_ID/sampler_weights/my-domain-sft"
```

3. Download:

```bash
python download_lora.py --name my-domain-sft -o ./downloaded-lora --to-peft \
  --base-model Qwen/Qwen3-4B-Instruct-2507
```

## Tips

- Start with `--smoke` before large runs
- Increase `--steps` for meaningful quality changes (smoke uses 1 step)
- Monitor tokens via `check_quota.py`
