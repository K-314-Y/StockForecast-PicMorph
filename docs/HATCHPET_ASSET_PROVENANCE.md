# HatchPet demo asset provenance

[`game_runtime/assets/hatchpet-demo-idle.webp`](../game_runtime/assets/hatchpet-demo-idle.webp) comes from Creature Lab’s original CSS demo chibi. The built-in image generation workflow used a screenshot of that chibi as the character reference. The resulting idle strip was prepared as a transparent, lossless WebP atlas with six 192 × 208 px frames in a single 1152 × 208 px row. Sprint 80 integrates the supplied file byte for byte.

SHA-256 `3454343dd7682facbc2011addea156de564347d84b9c088ec43c5878cbe1de5b`

The source workflow used no external copyrighted character references, third-party brands, or trademarks. The HatchPet skill’s helper code is licensed under Apache-2.0. That code license does not grant rights to third-party designs or guarantee clearance for generated images. Generated output may not be unique, and small changes to a third-party design do not resolve copyright concerns.

## Sprint 82: face-part composite proof of concept

The four image files under game_runtime/assets with names hatchpet-demo-parts-body.webp and hatchpet-demo-parts-face-(ready|happy|cautious).webp are derived **only** from the already documented original Creature Lab demo idle atlas. To reproduce, run game_runtime/tools/build_hatchpet_parts.py with Pillow. The atlas has 6 fixed 192x208 frames (1152x208 overall). The face atlas contains transparency apart from the eyes, brows, mouth and cheeks. Body pixels are retained except for a small interior face patch that conceals the original embedded facial marks. Background art, user-uploaded art, saved expression images, and model/trading calculations are not modified.

All expressions reuse the original **idle body movement**. They are NOT newly generated HatchPet action rows; do not label them as separate full-body animations. Because the original full-body sprite was not authored as editable layers, the face is an approximation and seams may remain at some scales. A commercially robust, fully configurable character requires artwork drawn as separate layers from the start, including parts hidden by hair and motion. This is an optional demo preview: appearance changes and imported artwork disable it, no saving is performed. The source has no third-party VRChat/Live2D model asset. Derivative images do not automatically acquire guaranteed copyright clearance or uniqueness.

Generated output SHA-256 digests (to identify the exact demo assets):
- hatchpet-demo-parts-body.webp: 8fa8b77c79332e1e549a721cd558242d98c59a339d74b460f35a5c53011f13ab
- hatchpet-demo-parts-face-cautious.webp: 0c904e69465b0991006a08e39c9fd538e3b2ddea645287edf48eae49e9d32f35
- hatchpet-demo-parts-face-happy.webp: f588a70fa8abafdd1ae1ab48584d2bcb011d93aa526ebdcfbd35484574740a42
- hatchpet-demo-parts-face-ready.webp: 0d9134ed20cfac5cf1c0bd95a9db2d0b1868deb4bf12b6623682c486640e05f2
