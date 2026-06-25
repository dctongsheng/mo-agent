#!/usr/bin/env python3
"""Download LoRA sampler weights from MinT after training.

Uses the public archive API (streaming tar.gz). The Tinker SDK's signed-URL
redirect can point at an internal storage host; this script downloads through
TINKER_BASE_URL instead.
"""
from __future__ import annotations

import argparse
import os
import sys
import tarfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

# Allow running from scripts/ with lib imports
sys.path.insert(0, str(Path(__file__).resolve().parent))

from lib.config import DEFAULT_BASE_URL
from lib.mint_client import ensure_env


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


def _parse_tinker_path(tinker_path: str) -> tuple[str, str]:
    from mint import types

    parsed = types.ParsedCheckpointTinkerPath.from_tinker_path(tinker_path)
    return parsed.training_run_id, parsed.checkpoint_id


def _safe_extract_tar(archive_path: Path, extract_dir: Path) -> None:
    base = extract_dir.resolve()
    with tarfile.open(archive_path, "r:*") as tar:
        for member in tar.getmembers():
            if member.issym() or member.islnk():
                raise RuntimeError(f"Unsafe link in archive: {member.name!r}")
            member_path = (extract_dir / member.name).resolve()
            if not member_path.is_relative_to(base):
                raise RuntimeError(f"Path traversal in archive: {member.name!r}")
        tar.extractall(path=extract_dir)


def download_archive(
    *,
    tinker_path: str,
    output_dir: Path,
    api_key: str | None = None,
    base_url: str | None = None,
) -> Path:
    """Download and extract a checkpoint archive. Returns adapter directory."""
    run_id, checkpoint_id = _parse_tinker_path(tinker_path)
    api_key = api_key or _api_key()
    base_url = (base_url or _base_url()).rstrip("/")

    output_dir.mkdir(parents=True, exist_ok=True)
    archive_path = output_dir / "checkpoint.tar.gz"

    encoded_ckpt = urllib.parse.quote(checkpoint_id, safe="")
    url = f"{base_url}/api/v1/training_runs/{run_id}/checkpoints/{encoded_ckpt}/archive"
    request = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Accept": "application/gzip",
        },
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=600) as response:
            with archive_path.open("wb") as out:
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    out.write(chunk)
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Archive download failed ({exc.code}): {body}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Archive download failed: {exc}") from exc

    extract_dir = output_dir / "extracted"
    if extract_dir.exists():
        raise RuntimeError(f"Refusing to overwrite existing directory: {extract_dir}")
    extract_dir.mkdir(parents=True)

    _safe_extract_tar(archive_path, extract_dir)

    children = [p for p in extract_dir.iterdir() if p.is_dir()]
    adapter_dir = children[0] if len(children) == 1 else extract_dir

    adapter_config = adapter_dir / "adapter_config.json"
    adapter_weights = adapter_dir / "adapter_model.safetensors"
    if not adapter_config.exists() or not adapter_weights.exists():
        raise RuntimeError(
            f"Expected adapter_config.json and adapter_model.safetensors under {adapter_dir}"
        )

    return adapter_dir


def find_tinker_path_by_name(name: str) -> str | None:
    """Search owned training runs for a sampler checkpoint with the given name."""
    import mint

    sc = mint.ServiceClient()
    rc = sc.create_rest_client()
    runs = rc.list_training_runs(limit=100).result()
    suffix = f"/sampler_weights/{name}"
    for run in runs.training_runs:
        ck = run.last_sampler_checkpoint
        if ck and ck.tinker_path.endswith(suffix):
            return ck.tinker_path
        try:
            listed = rc.list_checkpoints(run.training_run_id).result()
        except Exception:
            continue
        for ck in listed.checkpoints:
            if ck.checkpoint_type == "sampler" and ck.checkpoint_id.endswith(name):
                return ck.tinker_path
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description="Download MinT LoRA sampler weights.")
    parser.add_argument(
        "tinker_path",
        nargs="?",
        help="e.g. tinker://<run-id>/sampler_weights/mint-smoke-qwen3-0.6b",
    )
    parser.add_argument(
        "--name",
        help="Checkpoint name saved via save_weights_for_sampler(name=...).",
    )
    parser.add_argument(
        "-o",
        "--output",
        default="./downloaded-lora",
        help="Output directory (default: ./downloaded-lora)",
    )
    parser.add_argument(
        "--to-peft",
        action="store_true",
        help="Also convert to standard PEFT layout via tinker_cookbook.weights.build_lora_adapter",
    )
    parser.add_argument(
        "--base-model",
        default="Qwen/Qwen3-0.6B",
        help="Base model for --to-peft (default: Qwen/Qwen3-0.6B)",
    )
    args = parser.parse_args()
    ensure_env()

    tinker_path = args.tinker_path
    if not tinker_path:
        if not args.name:
            parser.error("Provide tinker_path or --name")
        tinker_path = find_tinker_path_by_name(args.name)
        if not tinker_path:
            raise SystemExit(f"No sampler checkpoint named {args.name!r} found.")

    print("tinker_path:", tinker_path)
    print("base_url:", _base_url())

    adapter_dir = download_archive(tinker_path=tinker_path, output_dir=Path(args.output))
    print("adapter_dir:", adapter_dir)
    for path in sorted(adapter_dir.iterdir()):
        if path.is_file():
            print(f"  {path.name}\t{path.stat().st_size} bytes")

    if args.to_peft:
        from tinker_cookbook import weights

        peft_dir = Path(args.output) / "peft"
        weights.build_lora_adapter(
            base_model=args.base_model,
            adapter_path=str(adapter_dir),
            output_path=str(peft_dir),
        )
        print("peft_dir:", peft_dir)

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception:
        print("download failed", file=sys.stderr)
        raise
