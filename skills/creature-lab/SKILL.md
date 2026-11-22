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
5. For existing user-supplied PNG or WebP body, ready, happy, cautious parts,
   the preferred workflow is the **drag-and-drop upload**, NOT generating an
   original-template character. On Linux /game, click
   「PNG・ZIPをドラッグ＆ドロップして登録する」 next to the character, then
   drop four named images (body/ready/happy/cautious), optional hair/outfit
   layers, or a ZIP. To use already prepared assets without selecting files,
   click 「用意済みのHatchPet画像パーツを試す」. To mix custom PNG/WebP
   layers, expand 「体・表情・髪・服を個別に選ぶ」. Confirm the
   preview, enter the character name and explicitly click
   「このPNGキャラを登録する」. The four PNGs are normalized locally to
   1152x208 six-frame RGBA atlases; name and transparency are checked.
   After registration the new ID appears in the character dropdown; click
   「このキャラに切り替える」 to activate the visual.
   Registration does not edit existing art, model, XP or display selection.
   The old PNG Parts Lab /parts-lab/preview.html is preview only.
   Windows is an independent viewing copy and cannot save PNG registrations;
   use Linux to register, Windows only to review the UI.
   Separately, for a new procedural illustration, use the optional
   「別機能：図形のサンプルキャラを新しく作る」, or call
   generate_character_parts and then register_demo_character on the
   authorized MCP. These procedural templates are not AI-generated art.

6. Use the SAME private Creature Lab MCP (no separate MCP) for AI-guided
   component cutouts from already registered PNGs:
   a) On explicit request to view a registered character, call
      inspect_character_image_for_parts with generated_id and source_part.
      It returns the actual six-frame PNG (each frame 192x208), so visual AI
      can identify approximate component positions.
   b) Call preview_segment_candidate with part_type (eyes, mouth, eyebrows,
      cheeks, hair, outfit, ribbon, glasses, hat, earrings, accessory),
      frame=0..5, seeds=[{x,y}] (1..6), tolerance=0..64.
      Inspect the transparent PNG preview before proceeding.
   c) Only after approval, call save_segment_candidate with the SAME args
      and the preview's expected_sha256. It writes to isolated
      local_state/segment_candidates/sg_<id>/part.png. No automatic game
      registration or original art / XP / prediction mutation occurs.
      Source SHA mismatch fails closed.
   IMPORTANT: this is AI-guided, seed-based COLOR segmentation, not a trained
   semantic image-segmentation model. The model chooses the region/label, but
   the local algorithm may mix overlapping shapes. Never call it fully
   automatic AI separation. Do not view private saved artwork without an
   explicit user request. The metadata-only MCP cannot access these tools.
7. On the full private Linux MCP, use `register_independent_part` only after
   the user explicitly approves catalog registration and its kind ID, layer
   anchor and rights metadata. Pass the saved cutout's `candidate_id` and
   `part_png_sha256` as `expected_candidate_sha256`. A review-required flag
   records the workflow requirement. Confirm user approval separately.
   `list_independent_parts` validates stored entries and returns metadata.
   The two tools are unavailable through the six-tool metadata-only MCP.
   On Linux the Parts Lab can list verified catalog metadata after an
   explicit click. It fetches an image only when the user selects that part.
   Layer and position changes stay in the preview until the user confirms
   the explicit equipment save for the loaded registered character. Remove
   transient file parts before saving. After reloading, select the character
   and use the explicit restore button. The equipment configuration has no
   link to the active character, XP, coins, forecasts or AI models.
8. Never expose private images publicly, automate account approvals, modify
   V6 forecast freeze, or place real stock orders.

Useful requests: “今の私のキャラを確認”, “保存前に12日間の模擬相場で
試して”, “登録済みの完成イラストを見て”, “この設定で保存して”.
