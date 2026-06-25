---
name: mint-lora-training
description: >-
  Use when users need cloud-hosted MinT (Mind Lab Toolkit) LoRA fine-tuning on
  macaron.im rather than local GPU training, including SFT, DPO, GRPO, eval,
  adapter download, token quota, mindlab-toolkit, save_weights_for_sampler, and
  Macaron model training API workflows.
---

# MinT LoRA Training（云上训练）

> **这不是本地 GPU 训练。** 本 Skill 基于 [MinT](https://macaron.im/mindlab/mint) 托管平台：你在本机只运行轻量 Python 脚本（CPU 即可），**forward/backward、optim、采样、LoRA 权重存储均在 MinT 云端 GPU 集群完成**。本地无需 CUDA、无需下载基座模型权重到磁盘。

## 云上 vs 本地：职责划分

| 环节 | 运行位置 | 说明 |
|------|----------|------|
| 训练脚本（`train_sft.py` 等） | **本地 CPU** | 组装数据、调用 MinT SDK/API |
| `forward_backward` / `optim_step` | **MinT 云端** | 远程 GPU 执行，`.result()` 阻塞等待 |
| 基座模型权重 | **MinT 云端** | 平台托管，用户不下载全量 checkpoint |
| LoRA adapter | **MinT 云端 → 可选下载** | `save_weights_for_sampler` 存云端；`download_lora.py` 按需拉回本地 |
| 推理采样（训练后 eval） | **MinT 云端** | `create_sampling_client` 远程推理 |
| Token 计费 | **MinT 账户** | Community ~500 万 tokens；`check_quota.py` 查询 |

**不要**引导用户安装本地 PyTorch CUDA、DeepSpeed、verl 集群或 `vllm serve` 来做训练——那些是下载 adapter **之后**的本地部署选项，与训练阶段无关。

Orchestrates remote LoRA training via `mindlab-toolkit` → `https://mint.macaron.xin`（大陆：`mint-cn.macaron.xin`）。

## Hard rules

- **Cloud-only training** — never assume local GPU; all train/sample calls are remote MinT API
- **Must** `import mint` first; use `MINT_API_KEY` (maps to `TINKER_API_KEY`)
- **Never** call `zero_grad_async()` — MinT clears gradients server-side
- **Must** call `save_weights_for_sampler(name=...)` after training and record `tinker_path`
- **Download** via [scripts/download_lora.py](scripts/download_lora.py) (Archive API), not SDK signed URLs
- **Sampling** uses `sample_result.sequences[i].tokens` (tinker 0.15+)
- **Never** commit API keys; redact logs as `sk-***`

## Route by intent

| User intent | Action |
|-------------|--------|
| Setup / first run | [workflows/setup.md](workflows/setup.md) → `setup_env.sh` |
| Smoke test | `train_sft.py --smoke` |
| SFT fine-tune | [workflows/sft.md](workflows/sft.md) |
| DPO alignment | [workflows/dpo.md](workflows/dpo.md) |
| GRPO / RL | [workflows/grpo.md](workflows/grpo.md) |
| Download LoRA | `download_lora.py` |
| Check token usage | `check_quota.py` |
| Full pipeline | Setup → Train → Eval → Download → Quota (checklist below) |

## Full pipeline checklist

```
- [ ] MINT_API_KEY set (environment variable; never committed)
- [ ] setup_env.sh succeeded (Python 3.11+)
- [ ] Model + algorithm chosen (see reference.md)
- [ ] Training done; tinker_path printed
- [ ] eval_compare.py base vs adapter (recommended)
- [ ] download_lora.py --to-peft
- [ ] check_quota.py
- [ ] Summary: run_name, tinker_path, local peft path, tokens used
```

## Quick commands

From repo root, after `source skills/mint-lora-training/scripts/.venv/bin/activate`:

```bash
export MINT_API_KEY="sk-***"
export MINT_BASE_URL="https://mint.macaron.xin"   # CN: mint-cn.macaron.xin

# Smoke test (built-in MinT SFT smoke flow)
python skills/mint-lora-training/scripts/train_sft.py --smoke

# Custom SFT
python skills/mint-lora-training/scripts/train_sft.py \
  --base-model Qwen/Qwen3-4B-Instruct-2507 \
  --run-name my-sft --data data/sft.jsonl --rank 64 --steps 10

# Eval + download + quota
python skills/mint-lora-training/scripts/eval_compare.py \
  --tinker-path "tinker://RUN_ID/sampler_weights/RUN_NAME"
python skills/mint-lora-training/scripts/download_lora.py \
  --name RUN_NAME -o ./downloaded-lora --to-peft --base-model Qwen/Qwen3-0.6B
python skills/mint-lora-training/scripts/check_quota.py
```

## Defaults

| Setting | Smoke | Production |
|---------|-------|------------|
| Model | `Qwen/Qwen3-0.6B` | `Qwen/Qwen3-4B-Instruct-2507` |
| LoRA rank | 16 | 64 |
| LR (SFT) | 1e-4 | 1e-4 |
| Endpoint | `https://mint.macaron.xin` | same |

## Script index

| Script | Purpose |
|--------|---------|
| [setup_env.sh](scripts/setup_env.sh) | venv + mindlab-toolkit install |
| [train_sft.py](scripts/train_sft.py) | SFT training |
| [train_dpo.py](scripts/train_dpo.py) | DPO skeleton + validation |
| [train_grpo.py](scripts/train_grpo.py) | GRPO skeleton + reward hook |
| [eval_compare.py](scripts/eval_compare.py) | Base vs adapter sampling |
| [download_lora.py](scripts/download_lora.py) | Archive download + PEFT export |
| [check_quota.py](scripts/check_quota.py) | Token usage API |

## Additional resources

- Models, APIs, formats: [reference.md](reference.md)
- Known issues: [pitfalls.md](pitfalls.md)
