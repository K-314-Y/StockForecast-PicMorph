# Sprint 18 handoff and reusable prompt

## Implemented decisions

See `SPRINT18_PARTS_DESIGN.md` for schema, Argon-review mitigations and test limitations. Integration remains uncommitted on `feat/s18-parts-assembly`, based on `b3742f649894c7f22d733dc097824d3b94fdc140`. No downloads, remote Git operations, browser automation or original-state edits are required.

## Ready-to-reuse integration prompt

```text
Integrate and review Creature Lab Sprint18 ONLY in isolated clone
/tmp/creature-lab-s18-20261030, branch feat/s18-parts-assembly,
initial HEAD b3742f649894c7f22d733dc097824d3b94fdc140.
Never touch the original Creature Lab or stock prediction repositories,
original local_state, or running services on 8765/8766. No internet,
packages, fetch/push, secrets, browser/Gemini automation, commit or merge.
Use Python stdlib and vanilla JS only. Read docs/SPRINT18_PARTS_DESIGN.md.

Review implemented parts_builder.py, app routes, shared blueprints persistence,
manual-only training constraint, /assemble UI, tests and navigation changes.
Preserve /game behavior, /create three-candidate flow, legacy schemas and MCP
catalog. Verify exact allowlists/types, shares 1..100, strengths 50..150,
2..4 unique registry IDs, largest-remainder tie order, omitted weight 0 and
strength 100, exactly five model fields, immutable drafts under shared quota.
Ensure manual training never reactivates initially zero weights and reports
6/21/56 actual candidates; trait training remains unchanged. Preview must use
only fixed fictional observed prefixes without targets or accuracy claims.
Check localhost/CSRF guards, strict JSON framing <=8192B, duplicate key and
nonfinite rejection, no custom paths/code/cosmetics in compilation, safe errors.
Check edits and in-flight edits invalidate preview/save. ChatGPT integration
performs browser QA manually: 375px without horizontal overflow, keyboard
labels/toggles/sliders, preview, errors, save, gallery and synthetic training.
Run python3 -B -m unittest discover -s tests -q and git diff --check.
Run dependency-free Node UI tests directly. Full npm tests require dependencies
already available AND isolated test services: existing MCP tests hardcode
8765/8766 and must NOT run against existing services. Do not install packages.
Report completed features, exact pass/block counts and remaining limitations.
No claims of fresh Gemini review or browser validation without performing them.
```
