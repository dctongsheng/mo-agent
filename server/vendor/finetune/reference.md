# MinT Reference

## 架构：云上训练，非本地

MinT 是 **Managed Infrastructure for Training**（Mind Lab 托管训练平台）：

- 本地：SDK 客户端脚本 + 数据文件 + API Key
- 云端：基座模型、GPU 计算、LoRA 状态、分布式 rollout、采样服务
- 数据流：`本地 Datum 批次` → API → `云端 forward_backward/optim` → `tinker_path` → 可选 `download_lora.py` 拉回 adapter

Community 版 **不支持**在本地 GPU 上训练；Enterprise 私有化部署另议（联系 `sales@mindlab.ltd`）。

## Endpoints

| Region | URL |
|--------|-----|
| International | `https://mint.macaron.xin` |
| Mainland China | `https://mint-cn.macaron.xin` |
| Console | https://mint-console.macaron.xin/login |
| Docs | https://mint-doc.macaron.im/en/community/get-started |

Set `MINT_BASE_URL` and `MINT_API_KEY`. `import mint` maps to `TINKER_*`.

## Supported models (Community)

| Model | Architecture | Algorithms |
|-------|--------------|------------|
| `Qwen/Qwen3-0.6B` | Dense | SFT, GRPO |
| `Qwen/Qwen3-4B-Instruct-2507` | Dense | SFT, DPO, GRPO |
| `Qwen/Qwen3-4B-Thinking-2507` | Dense | SFT, GRPO |
| `Qwen/Qwen3-30B-A3B-Instruct-2507` | MoE | SFT, GRPO |
| `Qwen/Qwen3-235B-A22B-Instruct-2507` | MoE | SFT, GRPO |

Enterprise adds GLM, Kimi, DeepSeek, VLA — contact `sales@mindlab.ltd`.

## Algorithm → loss_fn

| Task | loss_fn | Script |
|------|---------|--------|
| SFT | `cross_entropy` | `train_sft.py` |
| DPO | `forward_backward_custom` + preference loss | `train_dpo.py` + cookbook |
| GRPO / RL | `importance_sampling` | `train_grpo.py` + cookbook |

## Datum format (SFT)

JSONL, one object per line:

```json
{"prompt": "Question: 2+2?\nAnswer:", "completion": " 4"}
```

Prompt tokens get loss weight 0; completion tokens weight 1.

## DPO data format

```json
{"prompt": "...", "chosen": "...", "rejected": "..."}
```

Typical hyperparams: `lr=1e-5`, `dpo_beta=0.1`.

## Archive download API

```
GET {BASE_URL}/api/v1/training_runs/{run_id}/checkpoints/{encoded_checkpoint_id}/archive
Authorization: Bearer {MINT_API_KEY}
Accept: application/gzip
```

- `checkpoint_id` example: `sampler_weights/my-run-name`
- URL-encode slash: `sampler_weights%2Fmy-run-name`

Response: tar.gz containing `adapter_model.safetensors` + `adapter_config.json`.

## Usage API

```
GET /internal/usage_logs?limit=1        → account_id
GET /internal/usage_summary/{account_id} → total_quantity, charge_item_totals
```

Community tier: ~5M tokens included (remaining is computed, not returned by API).

## tinker_path format

```
tinker://{training_run_id}/sampler_weights/{run_name}
```

Always print and save after `save_weights_for_sampler(name=...)`.

## Local loading (after --to-peft)

**Transformers + PEFT:**

```python
from transformers import AutoModelForCausalLM
from peft import PeftModel
model = AutoModelForCausalLM.from_pretrained("Qwen/Qwen3-0.6B", device_map="auto")
model = PeftModel.from_pretrained(model, "./downloaded-lora/peft")
```

**vLLM:**

```bash
vllm serve Qwen/Qwen3-0.6B --enable-lora --max-lora-rank 16 \
  --lora-modules my-run=./downloaded-lora/peft
```

## SDK install

```bash
pip install git+https://github.com/MindLab-Research/mindlab-toolkit.git
```

Requires Python 3.11+.

## Official links

- MinT product: https://macaron.im/mindlab/mint
- SDK: https://github.com/MindLab-Research/mindlab-toolkit
- Quickstart repo: https://github.com/MindLab-Research/mint-quickstart
- Community verl: https://github.com/verl-project/verl-mint
