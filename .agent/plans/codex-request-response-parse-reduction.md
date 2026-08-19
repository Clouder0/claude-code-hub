# Codex Request/Response Parse-Chain Reduction (Production-Safe)

Status: Approved (Human, 2026-08-20: both phases land together, single canary rollout,
no runtime flag; rollback = revert one phase's commit and rebuild, or redeploy previous image)

## Goal

### Target

Eliminate redundant full-body JSON parsing on the Codex `/v1/responses` hot path in two
stages, without changing forwarded bytes, billing results, error/cyber detection, or
streaming semantics:

- Phase 1 (request side): remove the `JSON.parse(bodyString)` performed only to read
  `.stream` before forwarding, and remove the billing-time lazy re-parse of
  `forwardedRequestBody` by caching the post-filter request object at serialization time.
- Phase 2 (response side): collapse the four independent full `parseSSEData` passes over
  `allContent` at stream finalization (cyber signals, usage, service tier, codex
  `prompt_cache_key`) into one shared pass that skips `JSON.parse` for SSE events whose
  data cannot contribute.

Deployment context (verified with Human, 2026-08-20): production runs high-concurrency
mode ON, streaming hedge OFF; Codex traffic dominates. Work continues from the deployed
`codex-sse-high-concurrency-memory.md` plan state.

### Success conditions

- Every forwarded request performs exactly one full-body `JSON.parse` (intake) and one
  `JSON.stringify` (forward serialization); the `.stream` re-parse and the billing lazy
  re-parse are gone.
- `getForwardedRequestMessage()` returns a value structurally identical to today's lazy
  parse of the serialized upstream body (billing model, `service_tier`, priority billing
  inputs unchanged). `tests/integration/billing-model-source.test.ts` stays green.
- Stream finalization performs at most one full SSE event-materializing parse per stream
  for the four consolidated consumers; fake-200 detection keeps its existing regex-gated
  independent path.
- Parity tests prove: for a fixture corpus spanning codex completion / `response.failed`
  cyber / client-abort truncation / openai-chat / anthropic `message_start`+`message_delta`
  / gemini SSE / adversarial marker-substring-in-text cases, consolidated outputs equal
  current-implementation outputs exactly (usage metrics, tier, signals, cache key).
- Repo gates pass: `npm run typecheck` (tsgo), `npm run lint` (biome), `npm test` (vitest).
- Production: canary window shows no regression in error rate, billing rows, or stream
  behavior, and measurable CPU reduction vs baseline at comparable load.

### Blocked stop conditions

- A post-serialization mutation of `messageToSend` is discovered in `doForward` that would
  make the cached object diverge from the serialized body (Phase 1b) — replan to a copy or
  freeze strategy before proceeding.
- A consolidated consumer is found to read a field whose literal key substring is not
  covered by the marker set, breaking the skip-parse gate (Phase 2) — widen markers or
  exclude that consumer from consolidation.
- Billing parity fails on any fixture in a way not explainable by test artifact — stop and
  reassess rather than loosening the parity assertion.
- Production canary shows billing or streaming regressions — rollback image, replan.

## Operating Model

### Supported scope

- Primary workload: high-concurrency Codex `POST /v1/responses` SSE, multi-MB request
  contexts (growing per session turn), response outputs typically smaller than inputs.
- Secondary (must not regress): anthropic/openai-chat/gemini providers on the same
  streaming finalization path; normal (non-HC) mode; non-streaming requests.
- Codebase: `claude-code-hub` fork, branch `codex/compaction-v2`. Upstream-only commits
  (e.g. d6aa890f dedup) are out of scope — do not merge upstream as part of this task.

### Key facts (verified 2026-08-20, code refs)

- `forwarder.ts:2975-2984`: chat/codex branch does `JSON.stringify(messageToSend)` then
  `JSON.parse(bodyString)` solely for `isStreaming`. On the TTFB path. Pure waste.
- `session.ts:776-797`: `getForwardedRequestMessage()` lazily `JSON.parse`s
  `forwardedRequestBody` (third full parse). Triggered every codex request via
  `getRequestedCodexServiceTier` (`response-handler.ts:523-533`) in
  `resolveCodexPriorityBillingDecision`.
- `forwarder.ts:2575-2577`: Gemini branch is the second `forwardedRequestBody` string
  assignment site. `forwarder.ts:3012-3027` (debug snapshot consumer of the string) is
  gated off under high-concurrency mode.
- Hedge interplay (hedge OFF in production, code must stay correct):
  `forwarder.ts:5090` nulls `forwardedRequestBody` on shadows; `forwarder.ts:5111`
  `syncWinningAttemptSession` copies it. Both must handle the new cached pair.
- Response side, per finalized stream: `detectCyberSecuritySignalsFromText`
  (`cyber-security-signals.ts:69`, unconditional), `parseUsageFromResponseText`
  (`response-handler.ts:3917`), `parseServiceTierFromResponseText` (`:562`), codex
  cache-key loop (`:3004`) — four full `parseSSEData` passes; fake-200
  (`upstream-error-detection.ts:543`) is regex-gated and stays independent.
- All four consumers type-guard `typeof event.data !== "object"` and skip string data;
  every field they read arrives under a literal JSON key containing one of:
  `usage`, `service_tier`, `prompt_cache_key`, `cyber_policy`, `safety_buffering`
  (`usageMetadata` contains `usage`; anthropic `message_start`/`message_delta` carry
  `usage`). This is the correctness basis for the skip-parse gate.
- Existing incremental early-exit precedent: `actual-response-model.ts` `extractJsonChunks`.

## Scope and authority

- Outcome scope: Phases 1 and 2 as defined; per-phase deployable.
- Causal scope: request-side chain in `session.ts` + `forwarder.ts`; response-side
  finalization consumers in `response-handler.ts` + `cyber-security-signals.ts` +
  shared SSE helper in `lib/utils/sse.ts`.
- Agent-delegated: helper naming/signatures, test file placement, fixture construction,
  exact threading of the shared events through call sites, commit granularity.
- Deferred (recorded, not planned): `filterPrivateParameters` tree-rebuild avoidance
  (mutation-identity risk vs `applyFinal`, low ROI vs Phases 1-2); accumulator
  `finish()` chunk release; dropping `forwardedRequestBody` string retention under HC;
  upstream merge of d6aa890f; incremental iterLines finalization scanner.
- Human-decided: phase sequencing/approval, production deployment timing and execution,
  canary host/window, acceptance of observed metrics.

## Proposed approach

### Phase 1 — request-side waste elimination (small diff, TTFB-path win)

1. **1a**: `forwarder.ts:2979-2984` — read `messageToSend.stream === true` directly;
   delete the re-parse. The strict-equality semantics on the same logical value are
   identical to parsing the serialization of that value.
2. **1b**: add `ProxySession.setForwardedRequestBody(bodyString, message)` storing the
   string plus seeding the existing `forwardedRequestMessage`/`forwardedRequestMessageSource`
   cache. Replace both direct assignments (`forwarder.ts:2577`, `:2977`). Lazy parse in
   `getForwardedRequestMessage()` remains as fallback for any string-only writers.
   Update hedge shadow-null (5090) and winner-sync (5111) to carry/clear the pair.
   Implementation precondition to verify: no mutation of `messageToSend` after
   serialization inside `doForward` (snapshot at 3014 uses the string, not the object);
   if violated, seed the cache with a shallow-protected copy instead.
3. Tests: extend billing-source integration test (string-setter path now pre-seeded);
   new unit tests asserting `getForwardedRequestMessage()` identity vs lazy parse on
   fixtures; forwarder test asserting `isStreaming` for stream/non-stream bodies without
   re-parse (can assert via parse-count instrumentation hook if cheap, else behaviorally).

### Phase 2 — finalization single-pass consolidation

1. Shared helper (e.g. `parseSseEventsWithMarkers(text)` in `lib/utils/sse.ts`): like
   `parseSSEData`, but events whose concatenated `data:` text contains none of the marker
   substrings keep `data` as the raw string (no `JSON.parse`). One line-split, one pass.
2. Compute once per finalized stream (both finalization call sites: `finalizeStream` at
  `response-handler.ts:2897` context and the Gemini passthrough path feeding
  `finalizeRequestStats`), only when `isSSEText`; thread as optional parameter into the
  four consumers (each keeps its internal parse when the parameter is absent —
  non-streaming and any unthreaded callers unchanged).
3. fake-200 detection, status inference, completion-marker checks, langfuse emit: keep
   current behavior exactly (regex-gated / string scans / independent).
4. Parity harness: fixture corpus (see Success conditions) comparing consolidated vs
   legacy outputs field-for-field; plus a gating test proving text-delta events are not
   JSON.parsed (observable via a parse-counter option on the helper).

### Verification and rollout (combined, per Human decision 2026-08-20)

1. Local: targeted suites then full gates (`typecheck`, `lint`, `vitest run`).
2. Micro-benchmark (manual script, not CI): synthetic 4-8 MB codex request body and
   1-4 MB codex SSE stream; measure per-request parse/serialize chain time and
   finalization time before/after. Expect: request side drops to 1 parse + 1 stringify;
   finalization reduces to 1 pass with per-event parse skipped for deltas.
3. Land as two separate commits (Phase 1, Phase 2) so a regression can be attributed and
   surgically reverted by rebuilding with one commit dropped.
4. Production: single canary deploy of the combined image (Human executes, established
   hostdzire-us canary pattern), observe a busy window (CPU%, RSS, P95 TTFB, error rate,
   spot-check billing rows incl. service_tier/priority and cache-key binding), then
   promote to main compose; previous image retained for instant rollback. No runtime
   feature flag — image rollback is the safety mechanism at this deployment scale.

### Rejected / deferred alternatives

- Runtime feature flag for Phase 2: image-level rollback is equally fast at this
  deployment scale and avoids new settings surface. (Confirm with Human.)
- Incremental iterLines scanner replacing the one-shot split: further win but new
  machinery; the shared-pass + marker gating captures most of the benefit.
- Reusing `extractJsonChunks` directly: its event-boundary semantics differ from
  `parseSSEData` consumers' expectations; a gated variant of `parseSSEData` is the
  smaller, parity-testable step.

## Current state

Status: Implemented (both phases), pending Human review and canary deployment.

### Implemented outcome

- Phase 1: `.stream` re-parse removed (chat/codex branch); `setForwardedRequestBody` /
  `clearForwardedRequestBody` / `copyForwardedRequestBodyFrom` added to ProxySession;
  both serialization sites seed the cache; hedge shadow-clear and winner-sync carry the
  pair. Verified: no post-serialization mutation of the forwarded object in doForward.
- Phase 2: `parseSSEDataForFinalization` added to `lib/utils/sse.ts` (marker-gated);
  cyber/usage/tier consumers accept optional shared events (fallback = legacy path);
  cache-key loop uses shared events; all three streaming finalization call sites wired
  (normal finalizeStream, Gemini passthrough, passthrough error fallback) plus
  `finalizeRequestStats`. Fake-200 detection untouched by design.

### Verification evidence (2026-08-20, this machine, npx vitest)

- New tests: 66 passed (`forwarded-request-body-cache.test.ts`,
  `stream-finalization-parity.test.ts` — parity across 9 fixtures x 4 provider types for
  usage/tier/cyber, gating assertions, index-alignment with parseSSEData).
- `tsgo` typecheck: clean. biome: changed files clean (repo has pre-existing format
  drift in untouched files).
- Full suite: 7233 passed / 3 failed / 13 skipped. All 3 failures attributed
  pre-existing or environmental (verified by re-running with src/ changes stashed),
  none caused by this change:
  - `tests/unit/lib/error-rule-detector-reload-queue.test.ts` (2 tests) — fails
    identically with changes stashed and in isolation; branch issue, untouched module.
  - `tests/unit/api/v1/openapi-types-drift.test.ts` — `spawnSync bun ENOENT`
    (bun runtime not installed on this machine).
  - Note: `tests/integration/billing-model-source.test.ts` "GPT-5.6 long-context"
    failed once in an isolated targeted run and passed in both full runs — flaky;
    when it failed, it failed identically with changes stashed.
- Micro-benchmark (manual harness, recorded then removed from tree; synthetic 5.1MB
  codex request JSON, 2.1MB codex SSE / 2k deltas, 10 iters after warmup):
  - Request chain: 12.35ms -> 6.40ms per request (-48%; the two eliminated parses cost
    ~6ms per 5MB request on the TTFB path).
  - Finalization chain: 5.94ms -> 0.93ms per stream (-84%, ~6.4x; single gated pass,
    deltas skipped).

### Next

1. Human review of the diff; commit as two commits (Phase 1, Phase 2).
2. Build image, canary deploy per cops practice, observe busy window (CPU%, RSS, P95
   TTFB, error rate, billing rows spot-check), then promote.
