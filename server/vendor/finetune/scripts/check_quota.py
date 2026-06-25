#!/usr/bin/env python3
"""Query MinT token usage via internal usage_summary API."""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

from lib.config import COMMUNITY_TOKEN_QUOTA, DEFAULT_BASE_URL


def _api_key() -> str:
    key = os.environ.get("MINT_API_KEY") or os.environ.get("TINKER_API_KEY")
    if not key:
        raise SystemExit("Set MINT_API_KEY (or TINKER_API_KEY) in the environment.")
    return key


def _base_url() -> str:
    return (
        os.environ.get("MINT_BASE_URL")
        or os.environ.get("TINKER_BASE_URL")
        or DEFAULT_BASE_URL
    ).rstrip("/")


def _get_json(url: str, api_key: str) -> dict:
    request = urllib.request.Request(
        url,
        headers={"Authorization": f"Bearer {api_key}"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {exc.code}: {body}") from exc


def main() -> int:
    api_key = _api_key()
    base = _base_url()

    logs = _get_json(f"{base}/internal/usage_logs?limit=1", api_key)
    if not logs.get("logs"):
        print("No usage logs found for this account.")
        return 0

    account_id = logs["logs"][0]["account_id"]
    summary = _get_json(f"{base}/internal/usage_summary/{account_id}", api_key)

    total = summary.get("total_quantity", 0)
    breakdown = summary.get("charge_item_totals", {})
    training = breakdown.get("training", 0)
    sampling = breakdown.get("sampling", 0)
    remaining = COMMUNITY_TOKEN_QUOTA - total

    print("=== MinT Token Usage ===")
    print(f"account_id: {account_id}")
    print(f"total_used: {total} tokens")
    print(f"  training: {training}")
    print(f"  sampling: {sampling}")
    print(f"community_quota: {COMMUNITY_TOKEN_QUOTA} tokens (plan default)")
    print(f"remaining_estimated: {remaining} tokens (computed, not from API)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
