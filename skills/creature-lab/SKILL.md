---
name: creature-lab
description: Use when the user wants to inspect, design, preview, compare or update their own Creature Lab character, image, growth or synthetic stock forecast practice through the private MCP server. Avoid activating for actual trades or investment advice.
---

# Creature Lab: 自分で作る予測クリーチャー

The user controls their character. The plugin only talks to an authorized
private local Creature Lab Node game. It has no real-trading capability.

1. To learn the current state, use `get_my_character_sheet`. If images
   matter, use `get_my_artwork` and `view_my_artwork_image` with exactly
   one slot from `base/hair/face/outfit`. The last tool returns the actual
   saved illustration; interpret cautiously. Image recognition is uncertain
   and it does not automatically separate hair, face or clothing.
2. To explore a proposed prediction approach, use `preview_my_companion`
   before saving. Explicitly call results **synthetic game outcomes**, not
   real market backtests or investment returns. The preview must not issue XP.
3. For a save, request or rely on the user's explicit save/edit intent.
   Read the current revision, pass `expected_revision` to
   `save_my_companion` or `save_my_look`, and handle 409 by rereading and
   asking before overwriting conflicting edits.
4. Use `list_my_trained_brains` to find training IDs and
   `get_my_creature_growth` only to read progression. Do not fabricate
   models, training, images, XP or results.
5. All illustration uploads and manual crop actions currently belong in the
   local web game. Image data must not be sent to arbitrary destinations.
6. Never expose private images publicly, automate account approvals, modify
   V6 forecast freeze, or place real stock orders.

Useful requests: “今の私のキャラを確認”, “保存前に12日間の模擬相場で
試して”, “登録済みの完成イラストを見て”, “この設定で保存して”.
