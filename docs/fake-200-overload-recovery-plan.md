# Fake-200 Overload Recovery Plan

Status: Ready for Human Acceptance

## Goal

### Target

When an upstream OpenAI/Codex provider labels a response as HTTP 200 SSE but the first complete
payload is an overload error, CCH must detect the failure before committing any bytes downstream,
then reuse the existing provider retry and failover state machine. Codex must receive only the
eventual successful provider stream or a real HTTP 503 response that enters Codex's transport retry
loop; an overload must never escape as an HTTP 200 stream error before CCH recovery is exhausted.

### Success conditions

- A fake-200 overload split across arbitrary network chunks is classified before downstream commit.
- Structured overload codes (`server_is_overloaded`, `slow_down`) take precedence over conservative
  overload-message fallbacks; generic `try again later` text alone is not classified as overload.
- The failed upstream attempt is cancelled and released, then the existing same-provider retry or
  alternative-provider selection actually executes.
- A normal SSE response remains byte-for-byte equivalent and streaming; only a bounded prefix is
  retained.
- Client cancellation propagates through prefix inspection and replay without leaking readers,
  listeners, or agent references.
- If every CCH recovery attempt fails, the complete proxy path returns HTTP 503 with a top-level
  `server_is_overloaded` error code before committing any SSE bytes.
- A real Codex client retries that terminal HTTP 503 according to its request retry policy and can
  complete the same turn when a later request succeeds.
- CCH and Codex retry composition has a measured, documented upstream-attempt bound.
- Focused tests, full tests, lint, typecheck, and production build pass.

### Blocked stop conditions

- The current connection lifecycle cannot give a failed pre-commit attempt ownership of its cleanup
  without a broader proxy lifecycle redesign.
- Correct detection would require buffering an unbounded response or replaying after downstream
  bytes have already been committed.

## Operating Model

### Supported scope

- Standard `/v1/responses` streaming requests and the shared streaming-forwarder boundary.
- HTTP 200 responses labelled `text/event-stream` whose first complete JSON/SSE payload contains a
  top-level error or a Responses `response.failed` error.
- Normal responses whose first complete payload is non-error and can be replayed unchanged.

### Internal invariants

- Upstream request bodies are already represented by `ProxySession` and are replayable by the
  existing Forwarder attempt loop.
- No downstream response bytes are committed before the prefix gate returns `pass`.
- Detection may decode a copy, but replay always uses the original `Uint8Array` chunks.
- Prefix memory has a hard byte limit; reaching it fails open to normal streaming rather than
  growing without bound.
- Once a response is passed downstream, later stream failures remain ResponseHandler finalization
  concerns and are not transparently replayed.

### Failure semantics

- Confirmed fake-200 errors become `ProxyError` inside Forwarder, preserving inferred status and
  matcher metadata.
- Confirmed overload identity survives all-provider exhaustion so the terminal HTTP response can
  carry an accurate client-facing error code without relying on message parsing.
- Client abort is not a provider failure and stops inspection/retry immediately.
- Reader/transport failures retain existing transport categorization.
- Ambiguous or oversized prefixes pass through and retain the existing deferred finalization safety
  net.

### Quality envelope

- Default prefix cap: 32 KiB.
- No fixed delay on normal streams; the gate waits only for a complete JSON/SSE payload, EOF, abort,
  or the byte cap.
- No database migration, UI string, i18n surface, or public API schema change.

### Non-goals

- Replaying a response after any downstream byte has been emitted.
- Treating every 503 or every `try again later` message as model overload.
- Replacing the existing provider selector, retry limits, or circuit breaker policy.
- Adding overload-specific backoff before the pre-commit recovery path is proven.
- Depending on a stream-internal error-code trick to make Codex retry an already committed HTTP 200.

## Decisions and Authority

### Human-decided / locked

- Fix the fault in CCH rather than relying on a custom Codex client.
- Use bounded response-prefix buffering and implement and test the complete repair.
- Other providers are available; a single recorded attempt is evidence that the present SSE path
  never returns to Forwarder failover.

### Agent-delegated

- Helper/module boundaries, exact parser structure, cleanup ownership mechanics, and test layout.
- Whether hedge integration can directly reuse the same gate or needs a small adapter.

### Provisional

- Use 32 KiB as the prefix cap and pass through after the first complete non-error payload.
- Preserve `service_unavailable_error` as the terminal error type while independently setting the
  overload error code to `server_is_overloaded`; HTTP 503 owns retryability and the code owns final UI
  classification.

### Agent-decided after verification

- A confirmed overload gets one attempt per eligible provider in a CCH request. CCH does not repeat
  the same provider after 100 ms; after one provider round is exhausted, the terminal HTTP 503 lets
  Codex own time-based recovery through exponential backoff.

## Proposed Approach

### Current system model

`ProxyForwarder.send()` returns any SSE response immediately and records deferred finalization.
`ProxyResponseHandler` detects fake 200 only after consuming the stream; it can repair accounting,
circuit state, and session binding, but cannot return to the provider attempt loop. The displayed
`retry_failed` chain entry therefore records a failed first attempt without proving a retry occurred.

### Recommended design

1. Add a pure, structured overload classifier that extracts error descriptors from top-level OpenAI
   errors and Responses `response.failed` payloads. Prefer exact codes, then conservative messages.
2. Add a bounded streaming prefix gate that incrementally accumulates original bytes until a
   complete JSON document or SSE event is available, EOF occurs, or the cap is reached.
3. On error, cancel and release the attempt and throw a `ProxyError` before deferred finalization is
   registered. On pass, return a replay Response that emits original prefix chunks followed by the
   untouched upstream reader with backpressure and cancellation propagation.
4. Reuse the same classification/gate semantics in streaming hedge commitment so hedge-enabled
   providers cannot bypass the repair.
5. Preserve ResponseHandler's full-stream fake-200 detection as a post-commit accounting fallback.
6. Preserve overload identity through the synthetic all-providers-unavailable error and emit a real
   HTTP 503 JSON response with `code: server_is_overloaded`.

### Verification strategy

- Pure classifier tests for structured codes, exact overload messages, generic service unavailable,
  model-generated text, and Responses `response.failed`.
- Gate tests for fragmented JSON/SSE, byte-exact normal replay, EOF, cap fallback, cancel propagation,
  and error cleanup.
- Forwarder integration tests proving same-provider retry and alternative-provider success while the
  client observes none of the failed attempt's bytes.
- A complete proxy-handler test in which every provider returns fake-200 overload and the client
  receives HTTP 503 rather than an HTTP 200 stream error.
- A real Codex retry harness proving repeated HTTP requests and eventual same-turn success.
- Focused checks for client abort during prefix inspection and hedge attempts that must not commit an
  overload participant as winner.
- Regression tests for normal streaming and deferred finalization.
- Repository-required lint, typecheck, full test, and production build gates.

## Progress and Material Discoveries

- Confirmed the latest clean worktree at `codex/gpt56-priority-billing@77874e00`.
- Confirmed `/v1/responses` permits retry and provider switch; raw endpoint policy is not the cause.
- Confirmed the actual SSE path returns at response headers and detects fake 200 only during deferred
  finalization, explaining the single attempt despite available providers.
- Added a conservative structured overload classifier for OpenAI error objects, Responses
  `response.failed`, and explicit SSE error events. Generic retry advice and model output text remain
  outside overload classification.
- Added a 32 KiB streaming response-prefix gate in `doForward()`. It preserves original response
  bytes on pass, cancels confirmed fake-200 attempts, releases their timeout/agent runtime, and throws
  before deferred streaming finalization or downstream commitment.
- Proved with a real Forwarder integration test that provider A fake-200 overload is recorded as an
  inferred 503, provider A is excluded, provider B is selected, and the client observes only provider
  B's SSE bytes.
- Focused classifier, gate, and Forwarder tests pass. Typecheck passes; lint has only two pre-existing
  unrelated warnings and a Biome CLI/schema version notice.
- Completion review found that moving the first-byte read into Forwarder also moved first-byte timeout
  ownership. The gate catch now preserves the existing 524 provider-timeout semantics instead of
  leaking a raw abort error; the existing Gemini no-first-byte regression test was updated to assert
  the new pre-commit boundary.
- Before strengthening the terminal-client contract, the initial implementation passed 764 test files
  and 6991 tests (2 files / 13 tests skipped), plus production build, `lint:fix`, lint, and typecheck.
- Added a terminal proxy-handler contract proving an exhausted overload returns a real HTTP 503 with
  top-level `code: server_is_overloaded`, including the hedge terminal path.
- Ran Codex CLI 0.145.0 in a disposable Podman pod with both `HOME` and `CODEX_HOME` mounted from an
  isolated `/tmp` directory. A mock that returned two 503 overload responses and then valid SSE caused
  Codex to issue three requests (229 ms and 371 ms intervals) and complete the same turn with
  `RETRY_OK`.
- In the same isolated harness, an always-503 mock produced exactly five Codex HTTP attempts with
  200, 376, 777, and 1537 ms intervals, then displayed `Selected model is at capacity`. This confirms
  one initial request plus four transport retries and exponential backoff.
- Measured retry composition and removed immediate same-provider retries for confirmed overload. With
  `N` eligible providers, the default bound changed from `5 * 2 * N = 10N` upstream attempts to
  `5 * 1 * N = 5N`; the 20-provider safety limit therefore bounds the complete Codex turn at 100
  upstream attempts instead of 200 (and avoids the previous configured worst case of 1000).
- The overload retry-bound regression sets `maxRetryAttempts: 3` and proves only one attempt reaches
  the overloaded provider before failover. The focused overload/gate/hedge suite passes 59 tests.
- Final repository verification after the retry-bound change passed: production build, `lint:fix`,
  lint, typecheck, `git diff --check`, and 764 test files / 6995 tests (2 files / 13 tests skipped).
  The first full-test invocation exposed only an invocation-path issue (`bun` absent from child
  `PATH`); rerunning with Bun's directory explicitly in `PATH` passed the entire suite. Lint retains
  only the two unrelated baseline warnings and Biome CLI/schema version notice.
- Removed the disposable Codex pod, mock, and isolated HOME after recording evidence. Existing
  `cch-reh-*` pods were not modified.

## Review and Handoff

### Review verdict

Ready for Human Acceptance. No material Goal, evidence, or quality delta remains in the local change.
The pre-commit gate prevents fake-200 bytes from escaping, internal failover is proven, exhausted
overload preserves a real 503 plus `server_is_overloaded`, and a real isolated Codex TUI is proven to
retry that contract both through eventual success and terminal exhaustion.

The implementation keeps post-commit fake-200 detection as a fallback, preserves exact bytes for
normal streams, bounds inspection to 32 KiB, and proves that an OpenAI/Codex overload fake-200 reaches
the existing provider failover state machine before any failed-attempt bytes reach the client. A
confirmed overload is attempted once per eligible provider per CCH request; temporal retry is then
owned by Codex's bounded exponential-backoff loop.

### Human attention

The local worktree is ready for review. Commit, publication, deployment, and production verification
remain outside the authority granted for this task.
