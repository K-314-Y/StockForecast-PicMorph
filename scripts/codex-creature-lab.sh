#!/usr/bin/env bash
# Use local Creature Lab MCP in Codex without editing global/project Codex settings.
# Restrict visible MCP operations to read-only metadata, no binary image or saving.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
exec codex \
  -c 'mcp_servers.creature_lab_local.url="http://127.0.0.1:8896/mcp"' \
  -c 'mcp_servers.creature_lab_local.enabled=true' \
  -c 'mcp_servers.creature_lab_local.required=false' \
  -c 'mcp_servers.creature_lab_local.default_tools_approval_mode="auto"' \
  -c 'mcp_servers.creature_lab_local.enabled_tools=["get_my_character_sheet","get_my_companion","get_my_look","get_my_artwork","get_my_creature_growth","list_my_trained_brains"]' \
  "$@"
