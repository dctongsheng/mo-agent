# Setup Workflow

> **前提：云上训练。** 本地只需 Python 3.11+ 与网络；GPU 在 MinT 侧。注册并获取 API Key 后即可从 CPU 机器发起训练。
## 1. Register and get API key

1. Register at https://macaron.im/mindlab/mint
2. Create API key (`sk-*`) in https://mint-console.macaron.xin/login
3. Export `MINT_API_KEY` in your shell; never commit API keys.

## 2. Install environment

```bash
cd skills/mint-lora-training/scripts
bash setup_env.sh
source .venv/bin/activate
```

Requires Python 3.11+.

## 3. Configure endpoint

```bash
export MINT_API_KEY="sk-***"
export MINT_BASE_URL="https://mint.macaron.xin"
# Mainland: export MINT_BASE_URL="https://mint-cn.macaron.xin"
```

## 4. Verify connectivity

```bash
python train_sft.py --smoke
```

Expected: `train_nll` printed, `tinker_path` printed, `=== SFT TRAINING PASSED ===`.

## 5. Check quota

```bash
python check_quota.py
```

## Troubleshooting

See [pitfalls.md](../pitfalls.md).
