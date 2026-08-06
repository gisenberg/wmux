# OpenCode question compatibility

wmux supports the legacy `properties` question events from OpenCode release and
`@opencode-ai/sdk` **1.18.9**, official tag commit
`4da7bb44c84e013fa53e9c5d02ac753d1435c81a`. Production code imports event
types and the `OpencodeClient` type, then runtime-imports the v2
`OpencodeClient` class from `@opencode-ai/sdk/v2/client`.

OpenCode initializes plugins before it has to expose a TCP listener. Its
injected root SDK client already owns the authoritative HeyAPI transport, whose
custom fetch dispatches into `Server.Default().app.fetch`. The generated plugin
accepts only the injected root client's own `_client` data property and requires
that transport to have own `get` and `post` functions. It constructs exactly one
v2 client with `new OpencodeClient({ client: injectedTransport })`. That client
performs `global.health({ signal })`, `question.list({ directory })`,
`question.reply({ requestID, answers }, { signal })`, and structured
`session.get({ sessionID, directory })` calls. It does not create a URL-backed
client, read global/default SDK clients, or retry through external fetch. The
injected root SDK client remains the authority for existing generic lifecycle,
title, and delegation behavior. The reply input type is
`Parameters<OpencodeClient["question"]["reply"]>[0]`. The shared transport is
passed through unchanged: wmux does not call its configuration setters, add
headers, or copy credentials. The generated client
returns a `RequestResult<QuestionReplyResponses, QuestionReplyErrors, false,
"fields">`
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

The compatibility fingerprint's `v9-bounded-snapshot` label is the plugin/broker
wire contract, not the owner-only broker-file schema. A complete snapshot may
contain at most 256 native requests. The plugin rejects an oversized list before
performing any per-session lookups, and every accepted member must pass the
bounded question shape plus a bounded, successful top-level `session.get` check.
It validates at most eight sessions concurrently under one ten-second absolute
list-and-session deadline. The serialized control message must also fit the
128-KiB broker line bound; an otherwise valid but larger aggregate is downgraded
to a compact incomplete snapshot instead of being silently dropped.
The server's expanded native-list envelope is separately capped at 256 KiB,
which includes the worst-case bounded occurrence IDs, hashes, ordinals, and
cut-scope keys added by the broker.
Timeout, malformed data, an oversized list, or any failed member lookup produces
only an incomplete, non-authoritative snapshot: it cannot capture members or
close absent requests. Broker file schema 10 is the separate persistence
envelope that carries this contract and migrates schema 9 as described below.

Before accepting structured events, the generated plugin starts the broker from
pane-bound runtime-file paths. The broker first obtains a cryptographically
random, one-shot server challenge using either the exact pane registration
capability or the current source credential. It then emits that challenge inside
a separate broker nonce challenge with handshake schema 4, the canonical contract
digest, and a five-second deadline. The plugin requires the actual dedicated v2
client's `global.health`, `question.list`, `question.reply`, and `session.get`
methods and calls the fixed health wrapper through the extracted transport. It
returns only bounded runtime evidence: release, digest, fingerprint, event
envelope, method booleans, health fields, and challenge timestamps. A successful
health result must be an exact SDK RequestResult with HTTP status 200, no error,
and a plain data object whose only own properties are `healthy: true` and the
exact supported `version`. Its attestation source is exactly
`plugin.injectedTransport:/global/health`. The broker independently validates the
local nonce, freshness, exact contract, release, health result, and methods
before exchanging or refreshing.
The server atomically validates and consumes its challenge under the exact
capability/source, immutable pane context, and source credential generation, then
stores only the nonce-free sanitized evidence. The root client's `_client` field
is a pinned SDK internal, not a general extension API: wmux accepts it only under
the 1.18.9 digest/fingerprint contract and tests its own-property shape and
in-process behavior. A changed, inherited, accessor-backed, absent, or malformed
field fails closed. Package manifests, package search paths, `NODE_PATH`, tokens,
guessed URLs, and SDK global/default clients are not runtime compatibility
authority or fallback sources.

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
storage. A missing/malformed injected transport, missing/failed v2 import,
client construction failure, missing structured APIs, version/fingerprint
mismatches, malformed question events, and unexpected
reply result shapes disable structured question handling without terminal-input
fallback. Events arriving before `runtime_ready`
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

In an already-running POSIX pane with the current generated plugin and staged
broker paths, `wmux-agent-input-broker refresh` writes an owner-only, bounded
one-shot request beside that pane's broker credential. The exact OpenCode plugin
watching that path consumes it and restarts its broker child. The replacement performs a fresh in-process
runtime attestation and source credential rotation; the standalone command never
receives relay authority or fabricates attestation. If the pane predates broker
staging, the command fails closed with
`refresh_unavailable`; open a fresh pane and restart OpenCode. A plugin
module replacement also terminates the predecessor broker and aborts its
in-flight delivery controller before the replacement can own the shared
credential file. A plugin
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
Before the initial capability exchange, the broker atomically persists a bounded
owner-only intent containing the exact capability, nonce, attestation, and
broker-generated relay seed. Ambiguous responses—including repeated transport
loss, truncated or malformed success bodies, and broker termination after the
server commit—replay that exact intent with capped backoff. An exact
`already_exchanged` response returns metadata only; the broker reconstructs its
credential from the retained seed, commits it locally, removes the intent, and
requests a complete native snapshot. Conflicting responses never consume the
intent, while a typed stale-capability rejection waits for freshly staged pane
authority rather than falling back to a broad credential.
The generated plugin starts the broker with an explicit environment allowlist;
shared, helper, automation, and registration tokens are not inherited by the
broker process.
The broker writes a bounded owner-only sibling status file at
`<pane-credential>.status.json`. It contains only schema, state, stable diagnostic
code, and update time. It records transport-shape, challenge, health, registration, and broker
spawn failures without paths, pane/source IDs, exceptions, content, environment
values, or credentials.

The desktop reference shelf appears only for requests associated with the
active pane. It maps questions in source order, retains one submission ID across
retries, displays typed terminal/source/conflict outcomes, and takes terminal
editability from the server-projected request state rather than one browser's
local response. A deterministic non-retryable SDK rejection persists the public
request as `failed`; later native resolution may reconcile it to answered or
rejected, and authoritative list absence closes it as already resolved when an
identity-only resolution event was missed. The shelf exposes an Open
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
and removed atomically on successful exchange or refresh. During registration,
the pane-local broker temporarily stores the exact capability, relay seed, and
attestation in an owner-only atomic intent file so response loss and broker death
can replay the same exchange; successful local credential commit removes that
file. It never contains a question answer. The broker's source credential, occurrence epoch,
transient server relay epoch and cursor, per-key ordinal/current occurrence and
last event sequence, bounded asked-event receipts, and exact server bindings are
stored in its owner-only pane file under
`~/.wmux/agent-input/`. Its bounded per-key FIFO outbox contains capture, resolution,
and SDK-result metadata only; raw answers are not written there.
Delivery polling carries the server process's transient relay epoch. User answer
submission requires an active authenticated source poll or a successful poll
completed within the narrow five-second reconnect grace; an aborted poll clears
that grace immediately, so no raw answer is accepted for offline delivery. The broker
atomically binds its durable cursor to that epoch before handling a response, so
a high cursor from a prior server process cannot hide new post-restart deliveries.

Notifications contain stable workspace/tab/pane/request identity and generic
attention text only. They never contain question text, option text, answers,
prompts, SDK errors, or credentials. Browser bootstrap/deltas intentionally
contain the bounded question model but exclude credentials, answer digests,
occurrence identities, idempotency records, delivery IDs, and relay cursors.

The default server files are `~/.wmux/agent-input-requests.json`,
`~/.wmux/agent-input-credentials.json`, and `~/.wmux/agent-input-secret`.
`WMUX_AGENT_INPUT_REQUEST_PATH`, `WMUX_AGENT_INPUT_CREDENTIAL_STORE_PATH`, and
`WMUX_AGENT_INPUT_SECRET_PATH` override them for isolated operation or tests.
The old server override `WMUX_AGENT_INPUT_CREDENTIAL_PATH` remains accepted
outside a wmux pane, but is ignored in pane context because that name belongs to
the pane-local broker credential file.
Stores use owner-only atomic writes, validated rolling backups, explicit schema
versions, migrations, and downgrade refusal. Recovery from a validated
credential backup invalidates every recovered registration capability and
revokes every recovered source before authentication resumes; a fresh pane
registration is required. Recovery from a request-store backup closes every
recovered pending request and settles its submission as already resolved,
because the lost primary may have recorded answer exposure. Generation anchors
and already-terminal outcomes remain intact. Credential schema 8 binds every new
registration capability and source to the live pane's backend ID, one
live-attachment session incarnation, and immutable endpoint fingerprint. Abnormal exit or
backend/endpoint replacement retires the old source and pending requests. Its
schema-6 migration invalidates unbound capabilities and sources. Credential
schema 8 also uses
record-ID-scoped HMAC-SHA-256 verifiers and constant-time comparison; plaintext
capabilities, relay secrets, and challenge nonces are never stored server-side.
Its exact registration-request verifier permits metadata-only recovery while the
source credential is current; refresh or revocation fences replay. Schema-7
consumed capabilities migrate without that verifier and remain non-replayable.
Migration from schema 0 or 1
cannot reconstruct HMAC verifiers from legacy salted hashes, so it deliberately
marks every legacy capability used and every legacy source revoked. Open a new
pane to issue fresh credentials after that migration. Migration from schema 2
retains bounded source evidence but invalidates every pre-attestation capability,
revokes every source, and marks it `attestation_required`; a fresh pane is
mandatory. Migration from schema 3 preserves valid source credentials but removes
the old unbound attestation and marks each source `attestation_required`; the
current broker can source-authenticate a fresh challenge and refresh without a
new pane. Migration from credential schema 4 likewise preserves source refresh
authority, removes old injected-client health evidence, clears pending
challenges, and requires reattestation. Credential schema 6 migrated schema-5
`serverUrl` health evidence the same way and requires fresh
`plugin.injectedTransport:/global/health` attestation. Request schema 6 preserves
generation anchors but closes legacy pending records as `migration-unbound`;
it never fabricates occurrence IDs. Broker schema 10 migrates schema-9 source
credentials to require fresh source-authenticated attestation while older unbound
metadata is discarded/quarantined and requires fresh registration.
Future schema files are refused without rewriting them.

Request schema 7 adds durable retired-source evidence and bounded resource
ownership. A source may retain at most 128 pending requests, 256 request records,
512 generation anchors, and 1 MiB of admitted serialized request/anchor evidence;
the store has an 8 MiB admission budget. A separate bounded 512-KiB per-source
and 4-MiB global reserve is available only for already-admitted answer lifecycle,
terminal resolution, and source-retirement mutations, so saturation cannot retain
stale authority or prevent startup recovery. Raw in-memory answer delivery is
separately limited to 16 deliveries and 128 KiB per source within the existing
64-delivery/512-KiB global limits. Quota failures return immediately without a
state mutation. Duplicate same-key HTTP submissions share one delivery but are
limited to 32 waiters per delivery and 256 waiters globally; excess callers
receive a retryable source-unavailable outcome, and abort/settlement releases
the accounting. Generation anchors are removed only after the source is
permanently retired and both request and tombstone evidence have expired;
non-retired replay anchors are retained. Request schema 8 adds the durable
public `failed` state for deterministic non-retryable SDK errors while retaining
`pending` for conservative ambiguous outcomes.

## Failure and rollback behavior

- A user submission is successful only after the plugin acknowledges the typed
  SDK result. Answers are bounded in memory during that handoff and are not
  queued across a server restart. An observed delivery may be redelivered with
  the same delivery ID until the plugin durably marks the SDK call started.
  Timeout, transport failure, disconnect, cancellation, or restart after that
  SDK-start boundary becomes non-retryable ambiguity and can only converge
  through SDK acknowledgement or native `question.replied`,
  `question.rejected`, or `question.list` evidence.
- Source disconnect or browser cancellation before SDK start safely releases
  the in-memory handoff for the same browser submission ID. After SDK start it
  is quarantined; neither server nor plugin retries or redelivers it.
- A source credential and its constructor capability are accepted only while
  `SessionManager` still owns the exact running backend/session incarnation and
  endpoint. Additional viewers preserve that binding, while replacement of an
  idle durable client rotates it and stages fresh authority for the surviving
  broker. Abnormal process exit, same-pane backend replacement, agent-owned
  process recreation, or host retarget also retires it.
- Plugin/broker restart while the same wmux backend attachment remains live
  retains the occurrence stream and replays metadata-only outbox operations.
  A wmux server shutdown is a different authority boundary: graceful shutdown
  retires each active source before detaching, and an abnormal pane/backend exit
  retires the exact binding that exited. After an abrupt wmux restart, old source
  credentials cannot capture or poll while no matching attachment exists; when
  a durable pane reattaches, its new random session-incarnation epoch revokes the
  predecessor even if the pane ID and endpoint are unchanged. Durable terminal
  processes may survive, but structured answering requires a freshly staged
  capability. Reattaching a durable pane stages that replacement; a surviving
  broker waits with capped backoff, discards only its stale source authority,
  and exchanges the fresh capability without restarting OpenCode. Registration
  is a durable local transaction: before exchange, the broker atomically stores
  an owner-only exact intent beside its credential. Ambiguous or truncated
  success responses and broker restarts replay only that intent. The server
  retains an HMAC verifier bound to the capability, pane/session incarnation,
  attestation, nonce, and broker-held relay seed, and returns metadata rather
  than replaying relay plaintext. Local credential commit removes the intent
  and forces a complete native snapshot. The broker never modifies the
  server/session-owned capability mailbox, so a concurrent replacement cannot
  be deleted by an older exchange. Relay rotation or revocation invalidates the
  old intent. A pane that predates agent-input staging still requires a new pane. Server
  restart retains only sanitized request/credential history and never a raw
  answer. A never-exposed interrupted submission can be retried only when a new
  authoritative source owns the still-applicable request; SDK-started or
  otherwise ambiguous submissions remain quarantined and are never redelivered.
- Capture, resolution, and snapshot metadata is strict FIFO for each native key;
  SDK acknowledgements and unrelated keys continue while one key backs off.
  Transport, HTTP 408/429, 5xx, and untyped response failures keep the bounded
  durable operation and retry indefinitely with capped exponential backoff.
  Capture quota responses additionally apply one source-wide backoff so a full
  outbox cannot amplify a persistent quota condition into one retry stream per
  queued capture.
  Only an authenticated typed permanent conflict consumes/quarantines the
  affected operation. An acknowledgement conflict is never treated as success:
  it is quarantined with metadata only and requests native snapshot
  reconciliation so the server can converge from OpenCode state.
- Duplicate native asked event IDs converge on one occurrence. While that
  occurrence is pending, distinct same-payload asked events also converge on it
  and conflicting payloads fail closed; only an asked event after terminal state
  advances the ordinal. Exact retries converge on the original public request
  ID/generation or a terminal retired result; event-sequence fencing prevents an
  old identity-only resolution from binding to a newer occurrence. Generated
  plugin delivery is serialized by assigned event sequence, while the broker
  independently rejects stale asks and resolutions against its durable stream
  sequence and orphan/terminal fences.
- Closing the pane closes its pending requests. Credential rotation or source
  revocation cancels outstanding handoffs and rejects the old principal.

To disable and revoke structured answering, set
`WMUX_AGENT_INPUT_ENABLED=0` in the wmux service environment and restart the
service. This revokes source credentials, invalidates registration
capabilities, resolves pending requests as unavailable, and leaves generic
OpenCode lifecycle telemetry operational. Remove that setting and start a new
pane to roll forward, run `wmux-hooks install opencode` to refresh the generated
plugin, and require `wmux-hooks status` to report `opencodeParity: true` (or
compare `wmux-hooks hash opencode` with the reported expected hash). Rollout must
update wmux, install the generated plugin, and restart each OpenCode process so
it loads handshake schema 4; old processes fail structured handling closed while
generic lifecycle events continue. State schema 8, server credential schema 8,
request schema 8, and pane-local broker schema 10 are downgrade-refused. A binary
rollback must target a specific older release and restore owner-only, pre-upgrade
backups of every store that release cannot read: normally schema-7 `state.json`,
schema-7 `agent-input-credentials.json`, schema-7 `agent-input-requests.json`, and
schema-9 files under `~/.wmux/agent-input/`. Stop wmux and every affected OpenCode
process/broker before restoring the complete matching backup set. Without that
set, do not roll back to a question-enabled older binary. The only safe fresh-
state fallback is to disable structured answering, stop all affected processes,
archive and remove the incompatible server agent-input stores and pane-local
broker files, restore a state file the target binary supports, and open fresh
panes so no old capability or source credential is reused. Never hand-edit or
down-convert a store, and never delete or replace state while wmux is running.
Old browser clients still ignore the additive bootstrap field.

## Automated and live proof boundary

Focused tests cover old-plugin/new-server, new-plugin/old-server, old-client/new-
server, and new-client/old-server compatibility; the supported event contract,
generated-plugin refresh/parity, typed SDK result classification, credential
authority, storage/recovery,
CAS/idempotency races, restart boundaries, projection convergence, notification
redaction, and an isolated reference-to-real-server-to-broker SDK harness with
pane-input call/byte instrumentation. The generated-plugin integration uses a
real root 1.18.9 client with a custom in-process HeyAPI fetch and no OpenCode TCP
listener; it exercises health, list, reply, and structured session wrappers plus
generic root-client hooks, asserts the shared config is unchanged, and rejects
any external OpenCode fetch fallback. Run the complete repository gate with:

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
required injected transport and v2 methods plus the exact live OpenCode health
release through that transport before that gate; it does not itself prove
end-to-end browser answer acceptance. Do not
infer or claim that live gate from fixture results.
