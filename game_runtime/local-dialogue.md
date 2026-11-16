# Sprint67: optional local dialogue

OFF by default; normal startup has no dialogue adapter or active button. No real
LLM was called. Codex implementation/tests are not Argon review; Argon is pending.

Developer setup (not activated): import `createLocalDialogue` from
`local-dialogue.mjs` and explicitly pass
`localDialogue: createLocalDialogue({model: '<local-model-id>'})` to `createGameServer`.
A separately managed local backend is required. This document starts no service.
No environment switch, client-selected model, credentials or configurable host.
The only destination is `http://127.0.0.1:11434/v1/chat/completions`; redirects fail.
Backend logging, retention and outbound network behavior are unknown and must be
reviewed separately. Loopback transport alone cannot enforce those policies.

Normal reflection comparison never transmits its input. Only the explicit button
sends choice, reason, note (<=120 UTF-16 code units) and reported LONG/CASH action
through this app's local API. All fields come from the client; neither server nor
LLM verifies the action or retrieves the predictor's actual explanation. Fixed
instructions and a provenance disclaimer accompany the request. No history,
prediction access, tools, automatic memory/training, trading or game mutations.
The app does not persist or log dialogue text; backend behavior is separate.

The button stays hidden without injection or a compared reflection. Editing or
invalid submission requires comparison again. Late replies after editing,
comparison, day/model changes, new practice, errors or page exit are discarded.
One request remains pending until settled; navigation never triggers another.
Comments render through textContent, with a generated-response label; normal
deterministic comparison remains usable when dialogue is unavailable.

Bounds: same-origin loopback checks; JSON request <=1024 bytes; one independent
dialogue slot; 5-second adapter deadline including stream reading; JSON response
<=8192 bytes; commentary <=1200 UTF-16 code units; max_tokens 320. Controls and
invisible direction overrides are stripped. Unknown input/result fields, malformed
bodies, stream errors, invalid UTF-8, multiple choices, truncated/tool responses,
timeout and offline fail closed. Prompt rules cannot guarantee factual output or
model obedience; comments have no action execution path or remote fallback.

PASS 2 verification (no installs, services, real model calls or local_state writes):
- `node mcp/tests/local-dialogue.test.mjs`: 11/11; fake transport and real HTTP
  handler with socket-free requests, including malformed bodies and timeout.
- `node mcp/tests/quick-home-ui.test.mjs`: 65/65; mock DOM, including stale replies,
  literal markup, explicit click, reload and unchanged practice payload/storage.
- `node mcp/tests/leverage-practice.test.mjs`: 11/11 unchanged calculation tests.
- Existing focused runtime typecheck and separate `tsc --allowJs --checkJs
  --noEmit --target ES2022 --module NodeNext --lib ES2022,DOM --skipLibCheck
  game_runtime/local-dialogue.mjs`: passed with main's game_runtime/node_modules/.bin
  prepended to PATH. Existing tsconfig covers contracts/practice, not the whole UI.
- Runtime syntax and `git diff --check`: passed.
- Inside the Codex sandbox, OS sockets and Python subprocesses were blocked
  (EPERM). Outside the sandbox, the full Node suite ran with 335/337 passing.
  The two failing appearance-preview tests also fail on original main.
- External device/browser checks: the default-disabled UI made zero dialogue
  POSTs. With an explicitly injected dummy provider, one POST occurred only
  after the user clicked, and the generated-response label appeared. This was
  a TEST DUMMY, not an actual language model response.
- On the device, typecheck, dialogue tests 11/11, game Python 132/132 and
  image Python 152/152 succeeded (image tests with TMPDIR=/var/tmp).
- Real backend behavior and logging, and Argon-only review remain unverified.
  The prototype stays OFF by default and has not been merged into main.
