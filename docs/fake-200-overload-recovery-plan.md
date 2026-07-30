# Fake-200 Overload Recovery Plan

Status: Ready for Human Acceptance — implementation, isolated Codex evidence, and Goal review complete

## Goal

### Target

For a standard streaming `/v1/responses` request, when an upstream OpenAI/Codex-compatible
provider sends an HTTP 200 SSE stream whose pre-output Responses lifecycle ends in a structured
error (in particular `response.failed.response.error.code = server_is_overloaded` or `slow_down`),
CCH must detect it before committing any bytes to the client. It must then cancel that attempt and
reuse the existing provider failure, retry, and failover state machine. The client must receive only
the successful provider's stream, or a real terminal HTTP 503 carrying `server_is_overloaded` when
CCH recovery is exhausted.

The repair also adds bounded, redacted error-only diagnostics for this decision point. They must
remain available in high-concurrency mode without retaining request/response content or adding a
database, Redis, or session-debug write.

### Success conditions

- Existing generic first-payload fake-200 detection continues to protect every SSE route.
- Only canonical streaming `/v1/responses` gets a multi-event, pre-output Responses lifecycle gate.
- `response.created`, `response.queued`, and `response.in_progress` are held; a subsequent
  recognized fake-200 error is raised before client commitment and upstream is cancelled.
- The event's JSON `data.type` is authoritative; an SSE `event:` name is only a fallback when the
  parsed data has no type. Fragmented network chunks and absent `event:` headers work correctly.
- The first actual output-bearing, terminal, unknown, or malformed event passes through unchanged.
  In particular, the repair never retries after potentially visible model/tool/reasoning output.
- A normal stream remains byte-for-byte equivalent and streaming after the bounded held prefix.
- Prefix memory stays capped at 32 KiB. EOF, malformed ambiguous input, and cap exhaustion fail
  open to the existing streaming/finalization path rather than creating unbounded buffering.
- First-byte and streaming-idle timeout semantics remain correct while the gate owns upstream reads:
  no false 524 after a received lifecycle frame and no lifecycle-only stream can bypass idle timeout.
- A gate-detected fake-200 emits one bounded, redacted structured warning before Forwarder re-enters
  provider recovery; logging never includes a raw SSE body, request body, prompt, headers, URL/query,
  credentials, model output, user/session identifiers, or message text.
- Focused tests, required quality checks, and an isolated real Codex retry harness establish the
  complete CCH-to-Codex behavior after the full path is repaired.

### Blocked stop conditions

- Correct pre-output detection requires retaining an unbounded stream or replaying after client bytes
  have committed.
- The current timeout/reader lifecycle cannot transfer gate ownership without a broader, separately
  approved proxy lifecycle redesign.

## Current Model and Material Discovery

The historical Codex trace proves the externally observable failure: `/v1/responses` returned HTTP
200 with `text/event-stream`, and the same Codex turn ended as “Selected model is at capacity.” The
stored trace does not contain the original overload SSE body, so it is not evidence for a particular
wire envelope. The supplied CCH diagnostic screenshot is evidence that an upstream overload body was
classified as `FAKE_200_JSON_ERROR_MESSAGE_NON_EMPTY` with inferred HTTP 503, yet only one provider
attempt occurred despite alternatives.

The detector is not the missing component. It already recognizes top-level error objects,
`response.failed.response.error`, `server_is_overloaded`, `slow_down`, and conservative capacity
messages. The current gate instead returns `pass` after its first complete non-error SSE `data:`
event. This sequence therefore escapes:

```text
HTTP 200 SSE
  response.created
  response.in_progress
  response.failed { response.error.code = server_is_overloaded }
```

After `response.created`, CCH has replayed the stream downstream. `ResponseHandler` can later repair
accounting and circuit-breaker state, but it cannot re-enter Forwarder's provider loop. Codex maps the
later `response.failed` to `ServerOverloaded`, which its turn layer deliberately treats as
non-retryable. This explains why a real pre-stream HTTP 503 retries in Codex while this fake-200 path
does not.

The previous plan's accepted assumption—“the first complete non-error SSE payload is sufficient to
commit”—is therefore false for the Responses protocol. The prior implementation and its tests remain
valuable for generic first-payload errors, retry/failover, byte replay, and HTTP-503 terminal behavior,
but are not complete for this lifecycle sequence.

## Operating Model

### Supported scope

- Streaming `session.requestUrl.pathname === "/v1/responses"` requests using the Responses SSE
  protocol, regardless of the selected provider's marketing type.
- The existing shared streaming gate for generic JSON/SSE fake-200 bodies on all other routes.
- Pre-output `response.failed` error envelopes, including overload and other already-recognized
  structured fake-200 errors.

`/v1/responses/compact`, Chat Completions, Anthropic, Gemini, and unknown future protocol surfaces do
not gain a Responses lifecycle hold. They retain the conservative existing first-payload behavior.

### Gate invariants and decisions

- **Locked:** CCH fixes the failure before client commitment; Codex is not asked to recover an HTTP
  200 terminal SSE error.
- **Locked:** Recovery is limited to the existing provider state machine. No new overload-specific
  same-provider sleep/backoff is introduced; CCH tries eligible providers once and Codex owns later
  temporal HTTP-503 retry.
- **Locked:** Hold only the known non-output lifecycle events `response.created`, `response.queued`,
  and `response.in_progress`. A recognized error before output returns `fake_200`; the first output,
  `response.completed`, `response.incomplete`, `[DONE]`, unknown event, malformed event, or conflicting
  event/data type passes and replays unchanged. This preserves forward compatibility and avoids a
  retry when output might already exist.
- **Agent-delegated:** Exact parser/helper structure and how the bounded event metadata crosses from
  the pure gate to Forwarder.
- **Provisional, validated by tests:** 32 KiB remains the memory cap. It is a safety boundary, not a
  hidden time deadline.

### Timeout and resource ownership

The provider's first-byte timeout means “first nonempty upstream body chunk,” not “first byte exposed
to the client.” Since the gate now reads lifecycle chunks first, it must notify Forwarder exactly once
on that first upstream chunk so the existing first-byte timer is cleared at the correct instant.

Once a first lifecycle chunk is held, `ResponseHandler` has not yet received bytes and cannot own its
normal idle watchdog. The gate must temporarily enforce the configured `streamingIdleTimeoutMs` until
it passes, cancels, reaches EOF/cap, or errors, and must clean its timer and reader/agent ownership on
every exit. Idle expiry retains the existing `streaming_idle` failure category; it must not be
misreported as a first-byte timeout. No new gate-specific wall-clock deadline is introduced.

### Failure and privacy semantics

- A detected pre-output fake-200 cancels the upstream reader, releases timeout/agent resources, and
  becomes a `ProxyError` before deferred streaming finalization is registered.
- Client abort stops inspection and retry; it is never classified as a provider fake-200 failure.
- Existing post-commit finalization remains the accounting/circuit-breaker fallback. It cannot retry
  an already visible stream and this plan does not add a per-frame watcher to every normal stream.
- Diagnostic data is fixed-shape and bounded: no raw body or raw message is persisted or logged. A
  parsed error contributes only normalized/bounded code and type plus message length.

## Proposed Approach

### 1. Replace first-non-error commitment with a Responses pre-output gate

Refactor the existing bounded prefix inspection without creating a duplicate error matcher. For a
canonical Responses request, it parses each complete SSE event while the stream is still pre-output:

```text
created | queued | in_progress  -> retain and inspect the next complete event
recognized fake-200 error        -> cancel and return fake_200 before client commitment
output | terminal | unknown      -> replay exact retained bytes and continue normal streaming
EOF | malformed | 32 KiB cap     -> replay exact retained bytes and keep current finalization fallback
```

Use parsed `data.type` as the canonical event identity, with `event:` only as fallback. If they
conflict, the parsed data type wins; output or unknown data therefore commits conservatively. Generic
top-level error detection remains active before this lifecycle classification so a one-event fake-200
still follows the established path.

Forwarder receives the resulting `fake_200` before it registers deferred finalization, builds the
existing `ProxyError`/inferred status, and lets current provider accounting and alternative selection
run. Hedge commitment must use the same result so a lifecycle-failed participant cannot become winner.

### 2. Make timeout hand-off explicit

Extend the gate call contract with a one-shot first-upstream-byte notification and temporary idle
watchdog ownership. Keep timer classification in Forwarder, where provider context and retry behavior
already live. Verify cancellation, EOF, cap fallback, fake-200, and thrown-reader paths all clean the
watchdog and agent/combined-signal references exactly once.

### 3. Add high-concurrency-safe fake-200 diagnostics

Keep the pure gate logger-free. When Forwarder receives a gate fake-200, write one structured `warn`
before it throws into the current recovery loop. A separate bounded helper may rate-limit only this
error log; it must be process-local and fixed-capacity, never Redis/DB-backed.

The event has a stable shape such as:

```text
event: "proxy.upstream_fake_200"
phase: "responses_pre_output_gate" | "prefix_cap_fail_open"
downstreamCommitted: false
highConcurrencyMode: boolean
provider: providerId, bounded providerName, endpointId, attemptNumber
transport: upstreamStatusCode, contentTypeClass, observedBytes, prefixCapBytes
protocol: eventTypes[<=8], eventCount, detectorCode, overloadMatcherId,
          inferredStatusCode, upstreamErrorCode, upstreamErrorType, messageLength
recovery: selected action when already known
suppressedSinceLastEmission: optional count
```

No raw SSE/event data, raw error text, full request/response, headers, URL/query, prompt cache key,
model content, credentials, session ID, user ID, or dynamic unbounded field map is permitted. The
record is emitted only for a detected pre-output fake-200 or a 32-KiB fail-open anomaly—not for normal
SSE frames. A small process-local bucket, keyed only by bounded provider/detector/matcher identifiers,
retains the first few signals in a fixed window and reports later suppression; it limits a provider
capacity storm without adding network I/O or high-cardinality state. Existing post-commit finalization
logging stays unchanged in this scoped repair.

### 4. Verify the behavior end to end

Add focused unit and integration coverage before broad checks:

1. Fragmented `created -> in_progress -> failed(server_is_overloaded)` is detected without an
   `event:` header, cancels upstream, and replays no failed-attempt byte.
2. `created -> output_text.delta`, `created -> completed` with output, and conflicting
   header/data identities pass byte-exactly; no false retry occurs.
3. Created-only EOF, malformed input, and cap exhaustion pass/replay with the declared fallback.
4. First-byte callback fires once; held lifecycle traffic keeps first-byte timeout from firing;
   gate-phase idle timeout fires and cleans up as `streaming_idle`.
5. Provider A emits the real lifecycle-failed sequence and provider B succeeds: A is recorded as an
   inferred 503, B is selected, and the client observes only B's bytes. The all-provider case returns
   real pre-commit HTTP 503 plus `server_is_overloaded`.
6. Hedge routing cannot commit a lifecycle-failed candidate.
7. The warning is emitted in high-concurrency mode with only approved bounded fields; it does not
   cause session-debug/Redis writes. Rate-limit tests use fake time and prove key/window bounds.
8. Re-run the established focused suite, full tests, lint/fix, typecheck, build, diff check, then an
   isolated Codex retry harness against the repaired full CCH path.

## Scope, Authority, and Roadmap

### In scope after approval

- The Responses-aware gate, its timeout ownership, Forwarder/hedge integration, and focused tests.
- The bounded, redacted, rate-limited fake-200 warning described above.
- Revision of this Plan with decisive implementation and verification evidence.

### Explicit non-goals

- Retrying once any downstream SSE byte or possible output has been committed.
- Broad protocol parsing for non-Responses routes or changing Codex itself.
- Re-enabling high-concurrency session observation/debug snapshots, storing raw diagnostics, or adding
  telemetry databases/Redis writes.
- Changing provider selection policy, retry counts, database-pool work, deployment, or production
  configuration.

### Authority and next checkpoint

The prior ready-for-acceptance state was superseded by the Responses lifecycle evidence. The Human
subsequently approved the coupled gate and diagnostic contract and authorized local implementation and
testing. The local implementation is therefore within scope; it must preserve the unrelated
uncommitted high-concurrency request-retention work. Commit, push, deployment, and production traffic
changes remain separately authorized actions.

The isolated Codex checkpoint is complete. Provider A emitted
`created -> in_progress -> failed(server_is_overloaded)` and provider B succeeded in the same Codex
turn; the all-provider case produced a true pre-commit HTTP 503 and Codex made repeated transport
requests. The final state therefore requires Human acceptance or a separately authorized commit, not
another detector redesign.

### Implemented checkpoint (local, uncommitted)

- The bounded gate now holds only `response.created`, `response.queued`, and
  `response.in_progress` for canonical `/v1/responses`, detects a later structured pre-output failure,
  and otherwise replays the held bytes exactly.
- Gate ownership now clears the first-byte timer on the first upstream chunk and temporarily applies
  the existing streaming-idle timeout while lifecycle frames are held.
- Forwarder records the gate result before it becomes the existing `ProxyError` and provider recovery
  path. The new warning is metadata-only and process-locally rate-limited; it performs no Redis,
  database, or session-debug write, including in high-concurrency mode.
- Focused gate, forwarder, hedge, terminal-error, and logging tests passed (78 tests across 7 files).
  The complete Vitest suite completed successfully, as did `bun run typecheck`, task-file Biome,
  `git diff --check`, and a production build.
- An isolated temporary CCH (high-concurrency mode enabled), loopback mock upstreams, generated test
  key, and isolated Codex home exercised the built standalone server with Codex CLI 0.145.0. Provider
  A sent `created -> in_progress -> failed(server_is_overloaded)`; provider B then returned the sole
  client-visible `CCH_FAKE200_B_SUCCESS` stream. The fixture initially put both providers on one
  vendor endpoint pool because they shared a loopback origin; moving B to a separate temporary port
  made the intended independent-provider assertion valid. This was a harness configuration correction,
  not a source change.
- With both temporary providers pointed at the overload sequence, a direct request returned non-SSE
  HTTP 503 with `error.code = server_is_overloaded` and no `response.created` prefix. Codex configured
  with two HTTP retries raised the mock's overload request counter from 5 to 11: three Codex HTTP
  attempts, each trying CCH's two providers. It no longer terminated on the first fake-200 SSE frame.
- The structured `proxy.upstream_fake_200` warning was observed with
  `phase=responses_pre_output_gate`, `downstreamCommitted=false`, and
  `highConcurrencyMode=true`; its new fixed-shape event includes code/type/message length rather than
  raw SSE or error text. Existing generic provider-error logging remains intentionally out of scope.

## Review State

Verdict: **Ready for Human Acceptance.** The Goal review found no material defect in the supported
Responses SSE path. The gate is limited to `/v1/responses`; it passes on output, terminal, unknown,
malformed, EOF, and prefix-cap boundaries instead of retrying after possible output. The provider
failure remains contained in the existing recovery state machine, while terminal exhaustion becomes a
real client-visible HTTP 503. Timeout ownership, cancellation, rate-bound logging, focused unit paths,
the complete test suite, the production build, and the isolated real-Codex behavior all have direct
evidence. No commit, push, deployment, or production configuration change has been performed.
