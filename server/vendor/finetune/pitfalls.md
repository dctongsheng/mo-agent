# MinT Pitfalls (from production testing)

| Problem | Symptom | Fix |
|---------|---------|-----|
| Wrong sample API | `AttributeError: 'SampleResponse' has no attribute 'samples'` | Use `sample_result.sequences[i].tokens` (tinker 0.15+) |
| SDK signed URL download | Timeout to `192.168.x.x` | Use `download_lora.py` Archive API |
| Checkpoint 404 | Archive returns 404 | Download soon after training; save `tinker_path` |
| `zero_grad_async()` | Unexpected behavior / docs conflict | Do not call; MinT handles gradient zero |
| `get_info().model_data.model_id` | AttributeError | Non-fatal; trust `save_result.path` |
| Bare `import tinker` | `sk-*` key rejected | Use `import mint` with `MINT_API_KEY` |
| Repetitive smoke samples | `Answer: 8\nAnswer: 8...` | Smoke validates pipeline only; use more steps + `eval_compare.py` |
| Base model eval on LoRA client | Wrong comparison | Use `create_sampling_client(base_model=...)` without `model_path` for base |
| Key in git | Security risk | Use `.env` + `.gitignore`; redact in logs |

## Checkpoint retention

- Default `ttl_seconds=None` may not expire
- Some cookbook scripts use 7-day TTL — download promptly for important runs

## When smoke test is "enough"

Smoke test (`train_sft.py --smoke`) confirms:

- API key valid
- Remote training + optim + save + sample works

It does **not** prove model quality improved.
