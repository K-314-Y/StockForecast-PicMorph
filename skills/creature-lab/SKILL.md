---
name: creature-lab
description: Use when the user wants to inspect, design, preview, compare or update their own Creature Lab character, image, growth or synthetic stock forecast practice through the private MCP server. Avoid activating for actual trades or investment advice.
---

# Creature Lab: 自分で作る予測クリーチャー

The user controls their character. The plugin only talks to an authorized
private local Creature Lab Node game. It has no real-trading capability.

1. To learn the current state, use `get_my_character_sheet`. Use
   `get_my_artwork` for image metadata only. **Only when the user explicitly
   requests to see or analyze their artwork**, call `view_my_artwork_image`
   with exactly one slot from `base/hair/face/outfit`. That call sends the
   actual saved illustration to ChatGPT for analysis; do not retrieve images
   merely because metadata mentions they exist. Interpret cautiously. Image
   recognition is uncertain and it does not automatically separate parts.
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
5. To create a new original chibi from appearance choices, call
   `generate_character_parts` on the full private connection. Supply a
   display name, hex hair and clothing colors, and optionally an accessory
   and a seed. Describe the results as original procedural template artwork
   (`engine=original-template`). Call `package_character_parts` with the
   generated ID and give the user the local ZIP path to select in Parts Lab.
   For one-click preview, call register_demo_character, then open or refresh
   Parts Lab and select the character in Registered Demo Gallery. Registration
   alone never changes the game's avatar. On the game's appearance manager,
   the user can explicitly click 「このキャラに切り替える」 to save only the
   registered visual ID, or 「自分の外見を表示」 to stop displaying that
   registered visual. The latter never deletes or rolls back saved artwork,
   looks, colors, prediction settings or XP. Both controls are in the
   appearance studio and the user can check the current visual at the top.
   Existing artwork uploads and manual crop actions belong in the local web
   game. Image data must not be sent to arbitrary destinations.
6. Never expose private images publicly, automate account approvals, modify
   V6 forecast freeze, or place real stock orders.

Useful requests: “今の私のキャラを確認”, “保存前に12日間の模擬相場で
試して”, “登録済みの完成イラストを見て”, “この設定で保存して”.
