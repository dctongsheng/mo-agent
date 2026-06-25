"""MinT client helpers: env setup and ServiceClient factory."""
from __future__ import annotations

import os


def ensure_env() -> None:
    """Map MINT_* to TINKER_* and validate API key is present."""
    key = os.environ.get("MINT_API_KEY") or os.environ.get("TINKER_API_KEY")
    if not key:
        raise SystemExit("Set MINT_API_KEY (or TINKER_API_KEY) in the environment.")

    if os.environ.get("MINT_API_KEY") and not os.environ.get("TINKER_API_KEY"):
        os.environ["TINKER_API_KEY"] = os.environ["MINT_API_KEY"]

    base = (
        os.environ.get("MINT_BASE_URL")
        or os.environ.get("TINKER_BASE_URL")
        or "https://mint.macaron.xin"
    )
    os.environ.setdefault("MINT_BASE_URL", base)
    os.environ.setdefault("TINKER_BASE_URL", base)


def get_service_client() -> mint.ServiceClient:
    ensure_env()
    import mint

    return mint.ServiceClient()


def create_lora_training_client(
    service_client: mint.ServiceClient,
    *,
    base_model: str,
    rank: int,
) -> mint.LoraTrainingClient:
    return service_client.create_lora_training_client(
        base_model=base_model,
        rank=rank,
        train_mlp=True,
        train_attn=True,
        train_unembed=True,
    )


def adam_params(learning_rate: float) -> types.AdamParams:
    from mint import types

    return types.AdamParams(
        learning_rate=learning_rate,
        beta1=0.9,
        beta2=0.95,
        eps=1e-8,
    )


def redact_key(key: str) -> str:
    if len(key) <= 12:
        return "sk-***"
    return f"{key[:6]}...{key[-4:]}"
