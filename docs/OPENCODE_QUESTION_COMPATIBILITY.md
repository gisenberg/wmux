# OpenCode question compatibility

wmux supports the legacy `properties` question events from OpenCode release and
`@opencode-ai/sdk` **1.18.9**, official tag commit
`4da7bb44c84e013fa53e9c5d02ac753d1435c81a`. Production code imports
`OpencodeClient` and event types from `@opencode-ai/sdk/v2/client`.

The list and reply inputs are derived from `OpencodeClient`: wmux calls
`client.question.list({ directory })` and
`client.question.reply({ requestID, answers }, { signal })`, where the reply
input type is `Parameters<OpencodeClient["question"]["reply"]>[0]`. The generated
client returns a
`RequestResult<QuestionReplyResponses, QuestionReplyErrors, false, "fields">`
object rather than necessarily throwing: HTTP 200 contains a boolean, HTTP 400
contains `BadRequest` or `InvalidRequest`, and HTTP 404 contains
`QuestionNotFound`. wmux classifies the typed result; 404 is already resolved.
The SDK contract does not guarantee that `question.replied` has arrived before
the reply promise resolves, so the broker accepts either acknowledgement or the
native event race. The plugin forwards the native asked event ID and metadata,
but does not allocate a server generation. The plugin assigns a monotonic
question-event sequence and complete snapshots carry the pre-list sequence cut.
The owner-only broker state allocates a monotonic occurrence ordinal for each
source/session/native-request key and fences snapshot membership and absence at
that cut.

Before accepting structured events, the generated plugin starts the broker from
pane-bound runtime-file paths. The broker first obtains a cryptographically
random, one-shot server challenge using either the exact pane registration
capability or the current source credential. It then emits that challenge inside
a separate broker nonce challenge with handshake schema 3, the canonical contract
digest, and a five-second deadline. The plugin requires the actual injected
`question.list`, `question.reply`, and `session.get` methods, validates the
plugin-provided `serverUrl` as an HTTP(S) `URL`, and performs a credential-free,
no-redirect, body-bounded fetch of the fixed `/global/health` route. It returns
only bounded runtime evidence: release, digest, fingerprint, event envelope,
method booleans, health fields, and challenge timestamps. A successful health
result must be an HTTP 200 plain JSON object whose only own properties are
`healthy: true` and the exact supported `version`. Its attestation source is
exactly `plugin.serverUrl:/global/health`. The broker independently validates the
local nonce, freshness, exact contract, release, health result, and methods
before exchanging or refreshing.
The server atomically validates and consumes its challenge under the exact
capability/source, immutable pane context, and source credential generation, then
stores only the nonce-free sanitized evidence. Injected `client.global.health`,
package manifests, and package search paths are not runtime compatibility authority.

This runtime attestation is a trusted same-UID plugin compatibility check, not
cryptographic proof against a compromised OpenCode process, plugin host, or user
process. Its security boundary is narrower: an untrusted caller with only the
public helper constructor cannot register, and an observed attestation cannot be
replayed across capabilities, panes, sources, credential generations, or server
challenges. Each plugin/broker restart obtains a source-authenticated challenge
and replaces the stored evidence during credential refresh. If a challenge
response is lost, the broker requests a fresh challenge; issuance invalidates the
older pending challenge, so concurrent attempts have one newest winner and an old
response cannot later be replayed.

Fixtures under `test/fixtures/opencode-question` are synthetic and sanitized at
the capture boundary. In particular, `question.replied` is identity-only; its
SDK `answers` property is dropped before fixture, broker, logging, or durable
storage. Missing question APIs, version/fingerprint mismatches, malformed
question events, and unexpected reply result shapes disable structured question
handling without terminal-input fallback. Events arriving before `runtime_ready`
are dropped; startup reconciliation recovers still-pending native questions only
after readiness. Snapshot, capture, polling, and delivery remain disabled unless
the exact attestation and server registration both succeed. Generic agent
telemetry is unchanged.

## Setup and verification

Structured questions are enabled by default on the server. They remain inert
until a compatible plugin registers from a live pane. On each POSIX account
that runs OpenCode:

```bash
wmux-hooks install opencode
wmux-hooks status
wmux-hooks hash opencode
```

`status` reports the generated and installed SHA-256 values and
`opencodeParity`; parity must be `true`. Restart OpenCode after installing or
updating the plugin. New local and SSH panes receive the broker and a short-lived
pane-bound registration capability. Existing SSH panes are not retroactively
restaged; open a new pane when the helper or capability is absent.

The standalone broker `refresh` command cannot establish runtime identity and
therefore fails closed with `attestation_required`. Open a fresh pane after this
upgrade, then restart OpenCode so it loads the current generated plugin and runs
the challenge. A plugin
restart uses `question.list({ directory })`, validates every member and session,
filters out child sessions, and sends full member metadata. Only a completely
validated list is an authoritative absence barrier; a partial or failed list
performs no capture or closure. Its cut sequence is captured before asynchronous
list/session validation. Keys changed by a later event are preserved, and stale
members for those keys cannot allocate or supersede an occurrence. The broker
persists a per-key event fence even when an identity-only resolution arrives
before any occurrence, and a snapshot request received during an in-flight list
queues one immediate rerun instead of being dropped. Snapshot absence is applied
to both the broker occurrence state and the cut-scoped server keys, so a later
reuse advances the ordinal without allowing post-cut unrelated keys to be
closed. A listed
exact occurrence remains pending;
if its answer was already exposed to the SDK, it remains quarantined and is
never delivered again. An absent exposed request converges to already resolved.
The same list reconciliation runs after an ambiguous SDK transport/timeout
result; it is evidence for native convergence, never authority to retry
`question.reply`. The broker's legacy `retryable` acknowledgement bit is used
internally to classify that uncertainty, but the server converts it to a
durable, browser-visible `retryable: false` quarantine. Credential loss cannot
fall back to the broad wmux, helper,
or automation credential; create a new pane to obtain a fresh registration
capability.
The generated plugin starts the broker with an explicit environment allowlist;
shared, helper, automation, and registration tokens are not inherited by the
broker process.
The broker writes a bounded owner-only sibling status file at
`<pane-credential>.status.json`. It contains only schema, state, stable diagnostic
code, and update time. It records challenge, health, registration, and broker
spawn failures without paths, pane/source IDs, exceptions, content, environment
values, or credentials.

The desktop reference shelf appears only for requests associated with the
active pane. It maps questions in source order, retains one submission ID across
retries, displays typed terminal/source/conflict outcomes, and exposes an Open
Terminal action that only focuses the pane. Browser answers use
`POST /api/agent-input/requests/:id/answer`; neither the shelf nor the plugin
uses pane input as an answer transport.

## Persistence and privacy

The server persists request identity, bounded question/option content, state,
generation, server-only occurrence identity/key/ordinal and payload digests, keyed
answer digests used for idempotency, and contentless attention markers. It does
not persist raw answers or relay deliveries. Source and registration secrets and
pending challenge nonces are stored only as keyed HMAC verifiers in the server's
owner-only credential store. Challenge records are bounded, short-lived, pruned,
and removed atomically on successful exchange or refresh; plaintext exists only
in the challenge response and runtime attestation in flight. The broker's source credential, occurrence epoch,
transient server relay epoch and cursor, per-key ordinal/current occurrence and
last event sequence, bounded asked-event receipts, and exact server bindings are
stored in its owner-only pane file under
`~/.wmux/agent-input/`. Its bounded per-key FIFO outbox contains capture, resolution,
and SDK-result metadata only; raw answers are not written there.
Delivery polling carries the server process's transient relay epoch. The broker
atomically binds its durable cursor to that epoch before handling a response, so
a high cursor from a prior server process cannot hide new post-restart deliveries.

Notifications contain stable workspace/tab/pane/request identity and generic
attention text only. They never contain question text, option text, answers,
prompts, SDK errors, or credentials. Browser bootstrap/deltas intentionally
contain the bounded question model but exclude credentials, answer digests,
occurrence identities, idempotency records, delivery IDs, and relay cursors.

The default server files are `~/.wmux/agent-input-requests.json`,
`~/.wmux/agent-input-credentials.json`, and `~/.wmux/agent-input-secret`.
`WMUX_AGENT_INPUT_REQUEST_PATH`, `WMUX_AGENT_INPUT_CREDENTIAL_PATH`, and
`WMUX_AGENT_INPUT_SECRET_PATH` override them for isolated operation or tests.
Stores use owner-only atomic writes, validated rolling backups, explicit schema
versions, migrations, and downgrade refusal. Recovery from a validated
credential backup invalidates every recovered registration capability and
revokes every recovered source before authentication resumes; a fresh pane
registration is required. Recovery from a request-store backup closes every
recovered pending request and settles its submission as already resolved,
because the lost primary may have recorded answer exposure. Generation anchors
and already-terminal outcomes remain intact. Credential schema 5 uses
record-ID-scoped HMAC-SHA-256 verifiers and constant-time comparison; plaintext
capabilities, relay secrets, and challenge nonces are never stored. Migration from schema 0 or 1
cannot reconstruct HMAC verifiers from legacy salted hashes, so it deliberately
marks every legacy capability used and every legacy source revoked. Open a new
pane to issue fresh credentials after that migration. Migration from schema 2
retains bounded source evidence but invalidates every pre-attestation capability,
revokes every source, and marks it `attestation_required`; a fresh pane is
mandatory. Migration from schema 3 preserves valid source credentials but removes
the old unbound attestation and marks each source `attestation_required`; the
current broker can source-authenticate a fresh challenge and refresh without a
new pane. Migration from schema 4 likewise preserves source refresh authority,
removes injected-client health evidence, clears pending challenges, and requires
fresh `plugin.serverUrl:/global/health` attestation. Request schema 6 preserves
generation anchors but closes legacy pending records as `migration-unbound`;
it never fabricates occurrence IDs. Broker schema 10 migrates schema-9 source
credentials to require fresh source-authenticated attestation while older unbound
metadata is discarded/quarantined and requires fresh registration.
Future schema files are refused without rewriting them.

Request schema 7 adds durable retired-source evidence and bounded resource
ownership. A source may retain at most 128 pending requests, 256 request records,
512 generation anchors, and 1 MiB of serialized request/anchor evidence; the
store has an 8 MiB serialized global budget. Raw in-memory answer delivery is
separately limited to 16 deliveries and 128 KiB per source within the existing
64-delivery/512-KiB global limits. Quota failures return immediately without a
state mutation. Generation anchors are removed only after the source is
permanently retired and both request and tombstone evidence have expired;
non-retired replay anchors are retained.

## Failure and rollback behavior

- A user submission is successful only after the plugin acknowledges the typed
  SDK result. Answers are bounded in memory during that handoff and are not
  queued across a server restart. Each request generation is single-shot once
  raw answers cross the durable exposure boundary: timeout, transport failure,
  disconnect, cancellation, or restart after exposure becomes non-retryable
  ambiguity and can only converge through SDK acknowledgement or native
  `question.replied`, `question.rejected`, or `question.list` evidence.
- Source disconnect before exposure safely releases the in-memory handoff for
  the same browser submission ID. Disconnect after exposure is quarantined;
  neither server nor plugin retries or redelivers it.
- Plugin/broker restart retains the occurrence stream and replays metadata-only outbox
  operations. Server restart retains requests and credential metadata, but
  never a raw answer. A never-exposed interrupted submission can be resubmitted
  with the same submission ID; startup clears a stale delivery binding created
  before poll exposure so retry can bind a new delivery. An exposed, SDK-started,
  or otherwise ambiguous submission remains quarantined and is never redelivered.
- Capture, resolution, and snapshot metadata is strict FIFO for each native key;
  SDK acknowledgements and unrelated keys continue while one key backs off.
  Transport, HTTP 408/429, 5xx, and untyped response failures keep the bounded
  durable operation and retry indefinitely with capped exponential backoff.
  Only an authenticated typed permanent conflict consumes/quarantines the
  affected occurrence.
- Duplicate native asked event IDs converge on one occurrence. While that
  occurrence is pending, distinct same-payload asked events also converge on it
  and conflicting payloads fail closed; only an asked event after terminal state
  advances the ordinal. Exact retries converge on the original public request
  ID/generation or a terminal retired result; event-sequence fencing prevents an
  old identity-only resolution from binding to a newer occurrence.
- Closing the pane closes its pending requests. Credential rotation or source
  revocation cancels outstanding handoffs and rejects the old principal.

To disable and revoke structured answering, set
`WMUX_AGENT_INPUT_ENABLED=0` in the wmux service environment and restart the
service. This revokes source credentials, invalidates registration
capabilities, resolves pending requests as unavailable, and leaves generic
OpenCode lifecycle telemetry operational. Remove that setting and start a new
pane to roll forward, run `wmux-hooks install opencode` to refresh the generated
plugin, and require `wmux-hooks status` to report `opencodeParity: true` (or
compare `wmux-hooks hash opencode` with the reported expected hash). Rolling
back to a build without structured-question routes is compatible: the generated
plugin's structured path fails closed while generic lifecycle events continue;
an old plugin continues to use the unchanged agent-event route against a new
server, and old browser clients ignore the additive bootstrap field. Do not
delete state files while wmux is running, and do not reuse schema-2 files with a
binary that only understands an older credential schema.

## Automated and live proof boundary

Focused tests cover old-plugin/new-server, new-plugin/old-server, old-client/new-
server, and new-client/old-server compatibility; the supported event contract,
generated-plugin refresh/parity, typed SDK result classification, credential
authority, storage/recovery,
CAS/idempotency races, restart boundaries, projection convergence, notification
redaction, and an isolated reference-to-real-server-to-broker SDK harness with
pane-input call/byte instrumentation. Run the complete repository gate with:

```bash
npm run check
```

These automated fixtures are not proof that a particular live OpenCode TUI
release accepted an answer and continued the same session. That requires the
separate live HARD SERVER PROOF GATE: a real top-level OpenCode request with
single-select, multi-select, and custom questions; browser submission; observed
typed SDK acceptance and session continuation; final client convergence; and
instrumentation proving zero answer bytes or synthetic Enter events reached
pane input. Runtime attestation verifies that the generated plugin observed the
required injected-client methods and exact live OpenCode health release from the
plugin-provided server origin before that gate; it does not itself prove
end-to-end browser answer acceptance. Do not
infer or claim that live gate from fixture results.
