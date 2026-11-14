#!/usr/bin/env bash
# Run from anywhere. No ChatGPT account access, no actual player writes.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
echo "[1/6] Portable plugin manifest"
node scripts/verify-plugin-package.mjs
echo "[2/6] Isolated Node tests (legacy mcp.test.mjs intentionally excluded)"
find mcp/tests -maxdepth 1 -name '*.test.mjs' ! -name 'mcp.test.mjs' -print0 | xargs -0 node --test
echo "[3/6] TypeScript types"
npm --prefix game_runtime run typecheck
echo "[4/6] Python model tests"
python3 -B -m unittest discover -s tests -q
echo "[5/6] Dependency audit"
(cd mcp && npm audit --audit-level=moderate)
echo "[6/6] Live protocol check via MCP Inspector CLI"
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
npx --yes @modelcontextprotocol/inspector@2.13.0 --cli node mcp/companion-stdio.mjs --method tools/list > "$tmp"
node scripts/verify-plugin-inspector.mjs "$tmp"
echo "ALL CHECKS PASSED. ChatGPT account installation is a separate user-authorized step."
