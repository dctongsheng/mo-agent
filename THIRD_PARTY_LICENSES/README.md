# Third-party licenses

Mo (MIT) bundles the following third-party components. Each component's full
license text is preserved in-tree at the path shown; this index summarizes them.

| Component | Where | Copyright | License |
|-----------|-------|-----------|---------|
| **Hermes Agent** core | `vendor/hermes-agent/` | Nous Research | MIT — see [`hermes-agent-MIT.txt`](hermes-agent-MIT.txt) and `vendor/hermes-agent/LICENSE` |
| `hermes-achievements` plugin | `vendor/hermes-agent/plugins/hermes-achievements/` | Hermes Achievements contributors | MIT — `…/LICENSE` |
| `security-guidance` plugin | `vendor/hermes-agent/plugins/security-guidance/` | (see NOTICE) | Apache-2.0 — `…/LICENSE` + `…/NOTICE` |
| `humanizer` skill | `vendor/hermes-agent/skills/creative/humanizer/` | Siqi Chen | MIT — `…/LICENSE` |

All bundled components are under permissive licenses (MIT / Apache-2.0),
compatible with this project's MIT license. Per the Apache-2.0 terms, the
`security-guidance` plugin's `NOTICE` file is retained unmodified in-tree.

## Removed for license compliance

The upstream Hermes Agent install ships some skills under non-redistributable
terms. These were **removed** from this distribution and are not part of Mo:

- `skills/productivity/powerpoint/` — © Anthropic, PBC, "all rights reserved".
- `skills/research/research-paper-writing/templates/` — conference LaTeX styles
  (AAAI / ACL / ICML / ICLR / NeurIPS / COLM), each under its own copyright.

If you need those skills, install them yourself from their original sources;
they cannot be redistributed under MIT.
