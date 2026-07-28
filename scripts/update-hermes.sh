#!/usr/bin/env bash
# Mo — refresh the vendored Hermes Agent core.
#
# Replaces vendor/hermes-agent/ with a fresh upstream snapshot, re-applies the
# license strips, and records the exact upstream commit in vendor/VENDOR.md.
#
#   ./scripts/update-hermes.sh            # track upstream main
#   ./scripts/update-hermes.sh <git-ref>  # pin a tag/branch/sha
#
# Run the verification block it prints before committing.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

REF="${1:-main}"
UPSTREAM="https://github.com/NousResearch/hermes-agent"
DEST="vendor/hermes-agent"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "==> Cloning $UPSTREAM @ $REF"
git clone --quiet --depth 1 --branch "$REF" "$UPSTREAM" "$TMP/src" 2>/dev/null \
  || git clone --quiet --depth 1 "$UPSTREAM" "$TMP/src"
if [ "$REF" != "main" ]; then
  git -C "$TMP/src" fetch --quiet --depth 1 origin "$REF" && git -C "$TMP/src" checkout --quiet FETCH_HEAD
fi

SHA="$(git -C "$TMP/src" rev-parse HEAD)"
VERSION="$(sed -n 's/^version *= *"\(.*\)"/\1/p' "$TMP/src/pyproject.toml" | head -1)"
DATE="$(git -C "$TMP/src" log -1 --format=%ad --date=short)"
echo "==> Upstream v$VERSION @ ${SHA:0:9} ($DATE)"

# Exclusions. Three groups, each load-bearing:
#   1. build/VCS noise      — never belongs in a source snapshot
#   2. bulk not used by Mo  — tests, docs site, upstream's own desktop app.
#                             Note /web/ is the dashboard SPA *source*: excluded
#                             here, but built below into hermes_cli/web_dist,
#                             which Mo does need. Don't confuse the two.
#   3. LICENSE COMPLIANCE   — non-redistributable under Mo's MIT. Do not remove
#                             these lines; see THIRD_PARTY_LICENSES/README.md.
echo "==> Syncing into $DEST"
rm -rf "$DEST"
mkdir -p "$DEST"
rsync -a \
  --exclude '.git/' \
  --exclude '__pycache__/' \
  --exclude '*.py[cod]' \
  --exclude '.venv/' \
  --exclude 'node_modules/' \
  --exclude 'dist/' \
  --exclude '.hermes-bootstrap-complete' \
  \
  --exclude '/tests/' \
  --exclude '/tests-js/' \
  --exclude '/website/' \
  --exclude '/web/' \
  --exclude '/apps/' \
  --exclude '/native/' \
  --exclude '/contributors/' \
  --exclude '/mcp-research-data/' \
  --exclude '/README*.md' \
  --exclude '/CONTRIBUTING*.md' \
  --exclude '/SECURITY*.md' \
  --exclude '/AGENTS.md' \
  --exclude '/RELEASE_*.md' \
  \
  --exclude '/skills/productivity/powerpoint/' \
  --exclude '/skills/productivity/docx/' \
  --exclude '/skills/productivity/pdf/' \
  --exclude '/skills/productivity/xlsx/' \
  --exclude '/skills/research/research-paper-writing/templates/' \
  "$TMP/src/" "$DEST/"

# The dashboard SPA is a build artifact — upstream .gitignore's it, so it is
# absent from a source clone. Mo *requires* it: hermes_cli/web_server.py serves
# the /api/mo/* routes only when WEB_DIST exists, and the Electron renderer
# discovers the gateway port by fetching /health through the SPA. Without it the
# gateway starts but never listens, and the app can't connect.
echo "==> Building dashboard SPA (web/ -> hermes_cli/web_dist)"
(
  cd "$TMP/src/web"
  npm install --silent --no-audit --no-fund
  npm run build --silent
)
rsync -a "$TMP/src/hermes_cli/web_dist/" "$DEST/hermes_cli/web_dist/"
[ -f "$DEST/hermes_cli/web_dist/index.html" ] || {
  echo "ERROR: web_dist build produced no index.html — dashboard would not start." >&2
  exit 1
}

# The SPA build embeds licensed font binaries (Mondwest / Collapse / Rules).
# We don't have redistribution rights, so strip them — the dashboard falls back
# to system fonts. Cosmetic only; Mo's own UI does not use web_dist.
echo "==> Stripping bundled font binaries from web_dist"
rm -rf "$DEST/hermes_cli/web_dist/fonts" "$DEST/hermes_cli/web_dist/fonts-terminal"
find "$DEST/hermes_cli/web_dist" -type f \( -name '*.woff' -o -name '*.woff2' \
  -o -name '*.ttf' -o -name '*.otf' -o -name '*.eot' \) -delete

# Fail loudly rather than shipping a license violation.
for p in skills/productivity/powerpoint \
         skills/productivity/docx \
         skills/productivity/pdf \
         skills/productivity/xlsx \
         skills/research/research-paper-writing/templates; do
  if [ -e "$DEST/$p" ]; then
    echo "ERROR: $p survived the strip — license compliance broken. Aborting." >&2
    exit 1
  fi
done
if find "$DEST" -type f \( -name '*.woff' -o -name '*.woff2' -o -name '*.ttf' \
     -o -name '*.otf' -o -name '*.eot' \) | grep -q .; then
  echo "ERROR: font binaries survived the strip — license compliance broken. Aborting." >&2
  exit 1
fi
[ -f "$DEST/LICENSE" ] || { echo "ERROR: upstream LICENSE missing from snapshot." >&2; exit 1; }

cat > vendor/VENDOR.md <<EOF
# Vendored dependencies

## Hermes Agent core — \`vendor/hermes-agent/\`

| | |
|---|---|
| Upstream | <$UPSTREAM> |
| Version | \`$VERSION\` |
| Commit | \`$SHA\` |
| Commit date | $DATE |
| License | MIT (Nous Research) — see \`vendor/hermes-agent/LICENSE\` |

Refreshed by \`scripts/update-hermes.sh\`. **Do not hand-edit the snapshot** —
Mo injects itself from outside via \`HERMES_AGENT_ROOT\` + \`sys.path\`, so the
core stays byte-identical to upstream minus the strips below. Fixes belong
upstream.

### What the snapshot omits

- Build/VCS noise: \`.git/\`, \`__pycache__/\`, \`dist/\`, \`node_modules/\`, \`.venv/\`,
  \`.hermes-bootstrap-complete\`.
- Bulk unused by Mo: \`tests/\`, \`tests-js/\`, \`website/\`, \`web/\`, \`apps/\`,
  \`native/\`, \`contributors/\`, \`mcp-research-data/\`, upstream's top-level
  \`README\`/\`CONTRIBUTING\`/\`SECURITY\`/\`RELEASE_*\` docs.
- **License compliance** (non-redistributable under Mo's MIT):
  \`skills/productivity/{powerpoint,docx,pdf,xlsx}/\` (© Anthropic, PBC — all
  rights reserved), \`skills/research/research-paper-writing/templates/\`
  (conference LaTeX styles), and all font binaries under
  \`hermes_cli/web_dist/\` (licensed typefaces). See
  [\`THIRD_PARTY_LICENSES/README.md\`](../THIRD_PARTY_LICENSES/README.md).

### Mo's coupling surface

Only four upstream APIs are used, all from \`server/mo-gateway.py\`. Check these
first when a bump breaks:

| Upstream API | Used at |
|---|---|
| \`hermes_cli.env_loader.load_hermes_dotenv\` | \`mo-gateway.py:29\` |
| \`hermes_constants.get_hermes_home\` | \`mo-gateway.py:30\` |
| \`hermes_cli.profiles.{list_profiles,create_profile,seed_profile_skills}\` | \`mo-gateway.py:863\` |
| \`hermes_cli.web_server.{WEB_DIST,app}\` | \`mo-gateway.py:1542\` |
EOF

echo "==> Wrote vendor/VENDOR.md (v$VERSION @ ${SHA:0:9})"
cat <<'NEXT'

==> Snapshot in place. Now verify:

  # rebuild the core venv (dependencies may have changed)
  rm -rf vendor/hermes-agent/.venv
  (cd vendor/hermes-agent && python3.11 -m venv .venv && ./.venv/bin/pip install -e ".[messaging]")

  # the 4 coupling points must import
  vendor/hermes-agent/.venv/bin/python -c "
import sys; sys.path.insert(0,'vendor/hermes-agent')
from hermes_cli.env_loader import load_hermes_dotenv
from hermes_constants import get_hermes_home
from hermes_cli import profiles as P; P.list_profiles, P.create_profile, P.seed_profile_skills
from hermes_cli.web_server import WEB_DIST, app
print('coupling OK')"

  cd app && npm run build:all    # then: npm run dev, smoke-test chat + Self-Evolution

  # web_dist is force-added: upstream's own .gitignore excludes it, and that
  # rule outranks the root .gitignore. Its filenames are content-hashed, so new
  # assets land as ignored-untracked on every rebuild — always -f after a bump.
  git add -f vendor/hermes-agent/hermes_cli/web_dist
NEXT
