# Codex SSE High-Concurrency Request Memory Reduction

Status: Ready for Acceptance

## Goal

### Target

Reduce per-request and burst memory retained by high-concurrency OpenAI Codex
`POST /v1/responses` SSE traffic by eliminating request representations that have no consumer,
without changing the bytes ultimately derived for the upstream attempt or the existing retry,
provider-fallback, filtering, billing, and streaming state machines.

### Success conditions

- High-concurrency sessions do not clone the original request solely for disabled debug snapshots.
- High-concurrency parsed standard JSON `/v1/responses` SSE sessions do not retain an `ArrayBuffer`;
  normal mode, non-SSE, raw-passthrough, and multipart paths retain their current behavior.
- High-concurrency Codex sessions never construct or retain a full pretty-printed request log; they
  retain a bounded diagnostic summary. Normal mode preserves current diagnostics.
- High-concurrency standard `/v1/responses` parsing consumes the original Request stream rather than
  leaving an unread tee branch capable of retaining the full inbound body.
- Existing fake-200 overload recovery, provider switching, request filters, model redirects, hedging,
  compressed input handling, priority/cache billing, and SSE behavior remain unchanged.
- Focused regression tests, a representative memory-behavior test/experiment, and the repository's
  required build, lint, typecheck, and full test gates pass.

### Blocked stop conditions

- A required downstream consumer is proven to depend on the original JSON buffer for standard
  `/v1/responses` semantics.
- Bounding high-concurrency diagnostics would remove data required for correctness rather than
  optional observability.
- Correctness would require changing retry, billing, or SSE response semantics; that is outside this
  approved low-risk phase and requires replanning.

## Operating Model

### Supported scope

- JSON request bodies sent to the exact standard `/v1/responses` endpoint.
- Requests whose response is SSE, including fake-200 overload recovery, retry, provider fallback,
  hedge attempts, and client abort handling.
- Both encoded and identity request bodies already supported by the request-body codec.
- High-concurrency mode for bounded diagnostics; normal mode remains behaviorally compatible.

### Internal invariants

- `session.request.message` is the canonical parsed request used to derive every processed upstream
  attempt; retry and fallback do not require the original decoded buffer on the standard endpoint.
- Endpoint policy establishes whether raw forwarder preprocessing is bypassed. Raw-passthrough paths
  own and retain their byte buffer.
- Debug snapshot persistence and session observability are disabled when high-concurrency mode is
  enabled.
- Request diagnostics are not an upstream serialization source on the standard endpoint.

### Failure semantics

- Invalid or unsupported request encoding continues to fail at the existing request boundary.
- If system settings cannot be loaded before parsing, the implementation falls back to normal
  retention, favoring diagnostics and compatibility over optimization.
- Errors keep a bounded, redacted-useful request description; no expected request failure becomes a
  process-level failure.

### Quality envelope

- No public API, database, configuration, retry timing, provider-selection, or billing semantic
  changes.
- No new unbounded allocations. Diagnostic text has a small explicit upper bound independent of
  request size.
- New behavior has focused unit coverage; coverage must satisfy the repository's 80% rule.

### Explicit non-goals

- Replacing the 10 MiB SSE accumulator with an incremental Codex event parser.
- Removing `ReadableStream.tee()`, changing client-abort drain, or changing hedge ownership.
- Releasing the canonical request object after final-attempt commitment.
- Changing Langfuse or normal-mode full-debug behavior beyond consuming the bounded high-concurrency
  diagnostic representation.

## Decisions and Authority

### Human-decided / locked

- Work in the canonical checkout on `codex/gpt56-priority-billing`.
- Preserve and remove the previous temporary worktree.
- Implement the low-risk/high-gain request-memory phase fully and test it.
- Restrict semantic scope to high-concurrency Codex `/v1/responses` SSE traffic.

### Agent-delegated

- Exact retention-policy type, summary schema, helper boundaries, and test organization.
- Whether high-concurrency settings are loaded before session construction or passed through another
  existing cache boundary, provided settings failure remains fail-safe.
- Small adjacent refactors required to make ownership and lifetime explicit.

### Deferred

- Incremental SSE accounting and single-reader streaming are preserved as a separate higher-risk
  phase.
- Final-attempt facts and early release of `request.message`/`forwardedRequestBody` are deferred until
  their billing and observability consumers can be refactored coherently.

## Proposed Approach

### Current system model

`ProxySession.fromContext()` currently reads a cloned Request, materializes decoded bytes, a parsed
object, and a pretty log before `handleProxyRequest()` attaches the cached high-concurrency setting.
Reading the clone tees the body and leaves the original branch unread while the Hono Context remains
reachable. The session guard then clones the parsed object before checking whether debug persistence
is enabled. Standard forwarding serializes the canonical object and does not consume the decoded
buffer, while raw-passthrough does.

### Recommended design

1. Gate the pre-mutation snapshot clone on debug-artifact persistence.
2. Express request parsing retention as a small policy known before body parsing. High-concurrency
   standard `/v1/responses` consumes the original Request stream so no unread tee branch remains; its
   SSE JSON form omits the decoded buffer after parsing.
3. Under high-concurrency Codex retention, build a bounded structural diagnostic directly from the
   parsed body instead of full pretty JSON. Keep normal-mode logging unchanged.

This leaves one canonical mutable request representation for retries and one final serialized attempt,
while preserving byte ownership on paths that genuinely require it.

### Causal scope

Expected changes are limited to proxy handler/session construction, request parsing/diagnostics,
session guard snapshot creation, and focused proxy tests. Response streaming and billing code are
consumers to verify, not intended edit targets.

### Verification strategy

- Unit tests assert clone suppression and normal-mode snapshot preservation.
- Session parsing tests assert buffer absence for standard `/v1/responses`, buffer preservation for
  `/v1/responses/compact` raw passthrough and multipart, and encoded-body compatibility.
- Diagnostic tests use a large Codex `input` sentinel to prove it is absent from bounded
  high-concurrency logs while normal mode retains current behavior and error metadata stays useful.
- Existing fake-200, hedge, raw-passthrough, request-filter, redirect, and billing-focused tests run as
  a regression set.
- A bounded memory experiment compares retained `arrayBuffers`/heap behavior for many delayed SSE
  requests before and after the implementation when feasible and records its limits.
- Run `bun run build`, `bun run lint`, `bun run lint:fix`, `bun run typecheck`, and `bun run test` before
  handoff.

## Progress and Material Discoveries

- Canonical checkout switched to `codex/gpt56-priority-billing` at `9f5bad78`; the clean temporary
  worktree was removed.
- Legacy dirty work and generated test artifacts are preserved in two named Git stashes.
- Confirmed that exact `/v1/responses` uses the normal endpoint policy while
  `/v1/responses/compact` bypasses forwarder preprocessing and requires raw bytes.
- Confirmed `ProxySession.context` has no current consumers. A cloned Request body would otherwise
  leave its original tee branch unread and potentially retain the complete inbound body.
- Focused request-retention and snapshot-clone tests pass; current focus is broader retry/filter/
  billing regression and deterministic retained-representation measurement.
- The retention policy is isolated in `request-retention.ts` with a dedicated repository coverage
  command; its statements, branches, functions, and lines are all measured at 100%.
- Relevant fake-200, hedge, raw-passthrough, redirect, priority, and cache-write regression tests
  pass. A correctly configured full suite passed 7004 tests with 13 expected skips.
- Final-tree gates pass: production build, lint, lint:fix, typecheck, and the full test suite (765
  passed files, 7008 passed tests, 2 files/13 tests skipped by configuration).
- Goal-state review found no material defects. Structural retention evidence is decisive for the
  removed buffer/log/tee-branch ownership, but no production RSS reduction percentage is claimed.

## Review and Handoff

### Review verdict

Ready for Human Acceptance

### Evidence and Goal delta

The accepted high-concurrency Codex SSE request-memory phase is implemented and verified. Normal
mode, non-SSE buffer/log retention, raw passthrough, fake-200 recovery, provider fallback, hedge,
redirect, filtering, priority billing, and cache-write accounting retain passing evidence.

### Material deviations

- Investigation found that reading `Request.clone()` left the original tee branch unread. The
  implementation therefore directly consumes the original Request for high-concurrency standard
  Responses paths in addition to dropping the explicit SSE buffer. This remains inside the locked
  request-lifecycle objective and is covered by `bodyUsed` ownership tests.
- The retention policy was extracted into a small module with a dedicated 100% coverage gate instead
  of leaving policy branches embedded in the large session module.

### Context worth carrying forward

- This phase does not release the canonical parsed request or final serialized upstream body.
- SSE response accumulation, `tee()` backpressure, client-abort drain, and hedge body ownership remain
  the next higher-risk memory phase.
- A production or rehearsal load profile is still needed before claiming a specific RSS reduction;
  current evidence proves eliminated retained representations, not allocator-level RSS reclamation.

### Human attention

- Review and accept the local uncommitted change. Commit/push/deployment remain separate authority.
