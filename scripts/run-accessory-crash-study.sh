#!/usr/bin/env bash
# Use the exact P9ag runtime even during concurrent development in this checkout.
set -euo pipefail
cd "$(dirname "$0")/.."
baseline=b7cd646ba31016c8cbdf06d90532430b51b582ba
study_dir=$(mktemp -d)
trap 'rm -rf -- "$study_dir"' EXIT
git archive "$baseline" engine.py indicators.py game_runtime/accessory_analysis.py \
  game_runtime/predict_bridge.py game_runtime/practice.mjs scripts/accessory_regime_plans.py \
  scripts/test_accessory_regimes.py | tar -x -C "$study_dir"
cp scripts/{accessory_crash_branches.py,benchmark-accessory-crash.mjs,test_accessory_crash_branches.py} "$study_dir/scripts/"
mkdir -p "$study_dir/mcp/tests"
cp mcp/tests/accessory-crash-branches.test.mjs "$study_dir/mcp/tests/"
cd "$study_dir"
python3 -B scripts/test_accessory_regimes.py >&2
python3 -B scripts/test_accessory_crash_branches.py >&2
node --test mcp/tests/accessory-crash-branches.test.mjs >&2
node scripts/benchmark-accessory-crash.mjs
