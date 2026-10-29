# Sprint 18: parts assembly

## Scope and decisions

Python stdlib compiler/storage/API and vanilla JS `/assemble`; independent of active `/game` model. Existing `/create` still generates three trait candidates. The only game change is navigation. Catalog v1 has three window cores, three risk cores and the four exact registry indicators. Each part has a stable ID, kind, version and declarative config. No executable input, custom path, image or cosmetic property enters the compiler.

Strict allowlisted fields; required name (60 chars), optional concept (300 chars), 2–4 unique indicators. Share is an actual integer 1–100; strength is an actual integer 50–150. Booleans and floats are rejected. Integer largest remainders normalize to 100 in registry tie order. Omitted strengths default to 100 and weights to zero. Very small equipped shares can round to zero; training uses positive compiled weights as requested, so such parts remain inactive during training.

Compiler emits canonical versioned parts, five engine parameters validated by `Model`, summary and declarative MCP interoperability metadata. Preview uses three fixed 24-observation fictional prefixes, predicting observation index 24 without a target value or accuracy calculation. Risk changes allocation, not probabilities. Names/concepts are retained but not analyzed.

Manual drafts use existing schema 1, `indicator_composition_v1`, `manual_parts_v1`, null visual/job/deployment fields and competition eligibility false. `parts_assembly` is optional provenance. Both draft generators share `_persist_draft`, `STORE_FILE`, `LOCK`, quota and atomic replacement. Save recompiles input; client preview results are never trusted.

## Review pitfalls and mitigations

ChatGPT directly consulted Gemini 4 Argon through the user-connected Chrome via Playwright before briefing Codex. Gemini reviewed architecture, nine risks and a reusable prompt. Codex itself did not operate Gemini; its proposals were checked against the source code.

- **OFF parts reenabled during training:** manual drafts filter the existing 20-point weight grid to zero on every initially zero indicator. Two/three/four active indicators yield 6/21/56 candidates; actual count is reported. Trait drafts retain the original 56-candidate search. Equipped parts may themselves reach zero during optimization.
- **Stale preview saves:** every input/change invalidates preview and disables save; revision checks discard in-flight previews after edits. Save is explicit and uses the previewed payload.
- **Schema drift and racing writes:** one persistence helper and lock, existing immutable recipe schema, shared quota; training only adds a generator-specific constraint.
- **Code/CSRF/framing hazards:** `_blueprint_access` protects page and routes; exactly one JSON content type and decimal content length, no Transfer-Encoding, max 8192 bytes, UTF-8, no duplicate JSON keys or nonfinite constants. Safe errors contain no filesystem details.
- **Future leakage or misleading claims:** fixed observed prefixes only, no evaluation targets, no accuracy promises, Japanese fictional-data labels, independent cosmetic data.

## UI and verification

Japanese compact cards, native selects/toggles/numeric inputs/sliders, text-only safe DOM rendering and live status. Responsive grid uses a minimum bounded by 100% with wrapping navigation/actions. Browser QA at 375px is explicitly left to ChatGPT integration; no browser automation ran.

`python3 -B -m unittest discover -s tests -q`: 109 tests, 108 passed; existing `test_meta` socket test fails because sandbox prohibits sockets. New parts tests: 10 passed. `npm test` attempted without installation: MCP/stdio imports blocked by missing SDK; challenge test blocked by subprocess EPERM. Individual dependency-free existing UI tests: 8 passed; added parts UI test: 1 passed. No services were started, no 8765/8766 requests completed (MCP imports fail before execution). `git diff --check` is required before handoff.

## Future MCP image-code swapping

Future tooling may exchange versioned identities such as `namespace:name@version` plus reviewed configuration and immutable provenance. Metadata is an interoperability contract placeholder, not a new MCP tool or a code execution path. Image assets stay in the cosmetic layer; replacing an image never replaces predictor code. Any future code-part support needs an explicit trusted registry, version compatibility, review and isolation design; uploads/scripts remain rejected today. Existing MCP tool catalog is unchanged.

## Gemini Argon risk checklist (9 items)

1. Preserve the former three-candidate draft workflow and its schema.
2. Normalize all legal relative shares deterministically to four integer weights totaling exactly 100.
3. Preview contrasting up, flat, and down fictional scenes so equivalent or constantly bullish loadouts are visible.
4. Constrain training: any unequipped part must stay at zero; do not auto-equip parts during optimization.
5. Label every synthetic rehearsal as educational rather than evidence of market skill.
6. Show separate directional probabilities instead of rewarding always-UP predictions.
7. Keep training and validation time ranges disjoint and never use validation labels to choose weights.
8. Preserve the absolute separation between cosmetic image settings and calculation parameters.
9. Protect live port 8765, existing state and the separate V6 repository; test in isolated copy with protected hashes.

## Verified QA outside Codex sandbox

An independent Linux run found Python 109/109 and Node 12/12 passing; Playwright observed a 3:1 parts loadout becoming 75%/25%, previewing fictional bull/flat/bear scenes, saving a draft, gallery loading, synthetic practice comparison, and rejecting a single equipped indicator. A 375px viewport had no page-width overflow. The Codex sandbox itself was restricted from one socket-bound legacy test; the independent Linux run passed.
