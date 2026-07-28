# Vendored dependencies

## Hermes Agent core — `vendor/hermes-agent/`

| | |
|---|---|
| Upstream | <https://github.com/NousResearch/hermes-agent> |
| Version | `0.19.0` |
| Commit | `1dfe781edd5e96d09511cf27d800a03e63b09789` |
| Commit date | 2026-07-28 |
| License | MIT (Nous Research) — see `vendor/hermes-agent/LICENSE` |

Refreshed by `scripts/update-hermes.sh`. **Do not hand-edit the snapshot** —
Mo injects itself from outside via `HERMES_AGENT_ROOT` + `sys.path`, so the
core stays byte-identical to upstream minus the strips below. Fixes belong
upstream.

### What the snapshot omits

- Build/VCS noise: `.git/`, `__pycache__/`, `dist/`, `node_modules/`, `.venv/`,
  `.hermes-bootstrap-complete`.
- Bulk unused by Mo: `tests/`, `tests-js/`, `website/`, `web/`, `apps/`,
  `native/`, `contributors/`, `mcp-research-data/`, upstream's top-level
  `README`/`CONTRIBUTING`/`SECURITY`/`RELEASE_*` docs.
- **License compliance** (non-redistributable under Mo's MIT):
  `skills/productivity/{powerpoint,docx,pdf,xlsx}/` (© Anthropic, PBC — all
  rights reserved), `skills/research/research-paper-writing/templates/`
  (conference LaTeX styles), and all font binaries under
  `hermes_cli/web_dist/` (licensed typefaces). See
  [`THIRD_PARTY_LICENSES/README.md`](../THIRD_PARTY_LICENSES/README.md).

### Mo's coupling surface

Only four upstream APIs are used, all from `server/mo-gateway.py`. Check these
first when a bump breaks:

| Upstream API | Used at |
|---|---|
| `hermes_cli.env_loader.load_hermes_dotenv` | `mo-gateway.py:29` |
| `hermes_constants.get_hermes_home` | `mo-gateway.py:30` |
| `hermes_cli.profiles.{list_profiles,create_profile,seed_profile_skills}` | `mo-gateway.py:863` |
| `hermes_cli.web_server.{WEB_DIST,app}` | `mo-gateway.py:1542` |
