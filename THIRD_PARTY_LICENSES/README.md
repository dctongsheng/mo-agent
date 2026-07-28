# Third-party licenses

Mo (MIT) bundles the following third-party components. Each component's full
license text is preserved in-tree at the path shown; this index summarizes them.

| Component | Where | Copyright | License |
|-----------|-------|-----------|---------|
| **Hermes Agent** core | `vendor/hermes-agent/` | Nous Research | MIT — see [`hermes-agent-MIT.txt`](hermes-agent-MIT.txt) and `vendor/hermes-agent/LICENSE` |
| `hermes-achievements` plugin | `vendor/hermes-agent/plugins/hermes-achievements/` | Hermes Achievements contributors | MIT — `…/LICENSE` |
| `security-guidance` plugin | `vendor/hermes-agent/plugins/security-guidance/` | (see NOTICE) | Apache-2.0 — `…/LICENSE` + `…/NOTICE` |
| `humanizer` skill | `vendor/hermes-agent/skills/creative/humanizer/` | Siqi Chen | MIT — `…/LICENSE` |
| **Hermes Agent Self-Evolution** | `server/vendor/evolution/` | Nous Research | MIT — `server/vendor/evolution/LICENSE` |

All bundled components are under permissive licenses (MIT / Apache-2.0),
compatible with this project's MIT license. Per the Apache-2.0 terms, the
`security-guidance` plugin's `NOTICE` file is retained unmodified in-tree.

`server/vendor/evolution/` carries Mo-local modifications on top of the upstream
snapshot; they are listed in [`server/vendor/README.md`](../server/vendor/README.md)
and are released under the MIT License by Taiyi-AI-Lab.

## Removed for license compliance

The upstream Hermes Agent install ships material under non-redistributable
terms. The following were **removed** from this distribution and are not part
of Mo. `scripts/update-hermes.sh` re-applies these strips on every snapshot
refresh and aborts if any of them survive.

- `skills/productivity/powerpoint/` — © Anthropic, PBC, "all rights reserved".
- `skills/productivity/docx/` — © Anthropic, PBC, "all rights reserved".
- `skills/productivity/pdf/` — © Anthropic, PBC, "all rights reserved".
- `skills/productivity/xlsx/` — © Anthropic, PBC, "all rights reserved".
- `skills/research/research-paper-writing/templates/` — conference LaTeX styles
  (AAAI / ACL / ICML / ICLR / NeurIPS / COLM), each under its own copyright.
- **All font binaries** under `hermes_cli/web_dist/` (`fonts/`, `fonts-terminal/`
  and hashed `assets/*.woff2`) — licensed typefaces (Mondwest, Collapse, Rules
  families) that we have no redistribution rights for. The vendored dashboard
  falls back to system fonts; this is cosmetic and does not affect Mo's own UI.

The Anthropic skills above are governed by Anthropic's Consumer/Commercial
Terms, which prohibit reproducing the materials or creating derivative works
outside Anthropic's services. If you need any of these, install them yourself
from their original sources — they cannot be redistributed under MIT.

## Not bundled

- **MinT LoRA fine-tuning scripts** (`mint-lora-training`) — the fine-tuning
  screen ships as a scaffold only (trajectory collection + dataset generation +
  a run ledger). The cloud-training scripts are not included in the open-source
  distribution. See [`docs/configuration.md`](../docs/configuration.md).
