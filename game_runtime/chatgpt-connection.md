# ChatGPT primary conversation provider (Sprint69 pass 3)

ChatGPT is the sole planned conversation provider; the synthetic predictor remains
independent. There is no local LLM, reviewer, automatic request or API-key fallback.
**Sign-in is not implemented.** Default `createGameServer()` exposes no dialogue
route and the explicit button stays hidden. No credentials are read by this code.

A future trusted local host must obtain separate user consent for
`chatgpt.tokens.use.direct` via Sign in with ChatGPT. Use the trusted host's
verified OAuth client and secure credential lifecycle; do not implement a DIY
OAuth flow here. Never reuse Codex credentials, scrape cookies, expose credentials
to the browser, or store them in game state/logs. A successful identity login alone
is insufficient: `getSession().status` must be `connected` and `sharing` must be
true. Account changes must refresh the catalog and invalidate pending UI responses
before enabling the button again.
This pass has no account selector; host account switching remains future work.

The inspected official DevKit has a NONCOMMERCIAL license. No SDK code is vendored or installed here.
Review licensing before using/distributing that code. An OpenAI Platform API key
would use separate paid billing and requires explicit setup; it remains off.

## Injection contract

Create `createChatGPTPlanDialogue({client, model?})`, then pass the returned function
as `createGameServer({chatgptDialogue})`, or inject the trusted client directly as
`createGameServer({chatgptClient: client})`. Do not supply both. Neither form
constructs or signs in a client. This is a developer integration seam,
not working login. The authenticated client must implement:

- `getSession()` returning `{status: "connected", sharing: true}` only for an authorized account.
- `listModels({signal})` returning account-available `{slug, displayName}` entries
  in server order. With no configured model, the first is selected; an explicit
  model must be in this fresh catalog. No arbitrary default model is hardcoded.
- `streamResponse({model, input, instructions, signal, onDelta, store:false,
  stream:true})` returning `{text}` **only after `response.completed`**. It must
  reject failed, incomplete, interrupted and usage-limit streams, honor cancellation,
  and deliver text deltas to `onDelta`. The current SDK enforces store/stream policy
  internally; these explicit flags are also supplied for future adapters. An
  adapter that resolves partial text violates this trusted client contract.

Only the deliberate post-comparison button sends the four validated fields:
choice, reason, note (120 UTF-16 code units), and client-reported ai_action.
Control/direction characters are removed and data is JSON encoded. The route
requires same-origin loopback access and at most 1024 JSON bytes. No image, secret,
local_state, prediction inputs or real trades are included. Dialogue has no tools,
actions, state saves, XP or forecast access. Invalid results/errors return only
unavailable; SDK error messages and session details are never exposed.

The adapter deadline covers session/catalog/inference (45 seconds). Streaming text
is capped at 1200 code units via onDelta and the final result is validated again.
The current SDK does not expose a token-budget option: this is a local output cap,
not a guaranteed remote token cap. Cancellation requires client cooperation;
uncancellable work may continue remotely after the local timeout. The server has
a separate 50-second response deadline and serializes dialogue requests. Browser
invalidation aborts the HTTP request; premature response closure propagates a
signal to the adapter. The adapter and server retain their single-flight guards
until the underlying work settles, including after cancellation/deadline. A
non-cooperative injected client can therefore leave dialogue unavailable rather
than allowing overlapping chargeable work. Valid attempts are limited to six per
minute per server (all tabs combined). No automatic retry occurs. The browser allows 55 seconds and shows a waiting
status throughout. Changing the replay day, editing the reflection, starting a
new practice, switching models or leaving the page cancels the request and
discards late results. Partial stream text is never displayed: only a validated
completed response can replace the waiting status. The read-only server session
status deadline remains three seconds (browser allowance: four seconds).

Normal comparison remains page-only. A ChatGPT click sends the note to OpenAI
using the authorized account; it is not local-only processing. `store:false` does
not imply that OpenAI never processes or retains operational data. Model text is
shown as text, labelled as generated commentary rather than predictor reasoning.
The action is client supplied and unverified. Prompt instructions forbid claims
of improved accuracy, learning, setting changes or real trading advice; wording
is not a proof that a model can never make such claims. No model output executes.

## Optional read-only connection status

Only `chatgptClient` injection enables `GET /api/chatgpt-session` and the
「ChatGPTプランの接続状態を確認」button. Nothing is fetched on load, comparison,
or practice submit. The explicit status click calls only `getSession()`;
this host capability must be read-only and must never open login or infer text.
The endpoint returns exactly `{connected:boolean, sharing:boolean}`; names,
email, profile IDs, SDK diagnostics and tokens are omitted. `sharing` is false
unless status is connected. Reads have a three-second deadline and single-flight
guard. The endpoint has the same loopback, exact-origin and no-store boundary.
Default servers expose neither status nor dialogue routes, and show no buttons.

There is deliberately no sign-in route or connect button. This task has no
configured credential encryption, registration, or approved host permission flow;
a browser route that invokes OAuth would need those concrete integration details
and explicit user consent. The real account permission must be approved later
in the trusted host. Status checking does not sign in, grant sharing, or generate
a model response. Disconnection is checked again on every deliberate dialogue
request before catalog access or inference. Account changes during a request must
be propagated as cancellation by the trusted host; profile selection remains
outside this UI. This code has not contacted ChatGPT.

## Official references

- [Sign-in and credential handling](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [Account model discovery and completed Responses](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [SDK-compatible client examples and licensing links](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt)

Tests use fake authenticated clients and mock DOM only; no real OpenAI calls.
