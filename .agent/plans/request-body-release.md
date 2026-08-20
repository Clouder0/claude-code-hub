# CCH request-body release at stream-gate commit (+ B memory alignment)

Status: Phase 1 implemented 2026-08-20 (commit d1820785). Gates: tsgo clean,
biome clean, release tests 8/8, full suite 7254 passed (3 known pre-existing
failures unrelated), next build + standalone chain passed. Scoped decisions
vs the draft: release fires only on commit marker verdict=content AND
high-concurrency mode (legacy/shadow gates never attach content markers ->
non-Responses providers and non-HC keep current behavior; hedge shadows do
not traverse the hooked return path); non-stream release descoped (bodies
die with request scope); B memory alignment intentionally NOT bundled into
this commit (keep the memory-behavior change isolatable; do it as a compose
change at deployment time). Phase 0 measurement (per-stream 1.67MiB) and the
TTFB/burst findings that reframed the benefit case are in cops notes
2026-08-20-hostdzire-cch-loadtest-baseline.md. Next: canary ladder with
memory-RSS comparison at fixed synthetic load as the benefit proof.

## Goal

### Target

Reclaim the dominant per-stream memory retention: after the streaming gate
commits semantic content to the client (`streamGateCommitMarker`), the full
request representation (original parsed tree + post-filter tree +
serialized string, ~2-4.5MB/stream at the measured 107k-token median
context) has zero remaining consumers in this deployment (retry impossible
post-commit by construction; billing needs a ~100-byte projection; HC mode
disables debug snapshots; langfuse unused; hedge off). Release it to a
billing projection, and raise B's container memory cap to match A.

Expected: per-stream steady state ~3-6MB -> ~1-2MB; comfortable concurrent
streams ~250-300 -> ~600-900; comfortable RPM ~300-500 -> ~600-1,200
(stream-duration dependent). The magnitude MUST be validated by measurement
before and after (the tokens/70x lesson).

### Success conditions

- Phase 0 measurement: MB-per-stream slope and the concurrency ceiling
  measured on an isolated canary (no HAProxy weight) with synthetic load;
  model numbers confirmed or corrected.
- Post-change re-run of the same profile shows >=2x reduction in RSS slope
  at equal concurrency; no regressions in latency percentiles.
- Behavior parity: streaming acceptance, abort-post-commit classification
  and billing, provider failover pre-commit (fake-200 throw path), billing
  fields (model/service_tier/prompt_cache_key) all unchanged; accessor
  guard prevents silent post-release tree reads in dev/test.
- B container recreated with mem_limit equal to A (3347054592) as part of
  the release's B replacement.

### Blocked stop conditions

- Phase 0 measurement shows per-stream retention is NOT dominated by the
  request representation (slope much lower than model) -> replan benefit
  case before implementing.
- An unauditable post-commit consumer of the request tree is found that
  genuinely needs the full body -> fall back to compressed retention for
  that consumer or descope.
- Synthetic load perturbs production beyond guardrails (host load > 6.5,
  prod error-rate increase) -> abort test, lower steps.

## Operating Model

- Production: A/B on f60990aa behind HAProxy 50/50; HC mode ON; hedge OFF;
  langfuse OFF (Human-confirmed); canary slot free (direct container-network
  access for tests, weight absent from HAProxy).
- Context distribution (measured 2026-08-20): median 107k tokens (~430KB
  JSON), p95 230k (~920KB), p99 323k (~1.3MB), max 819k; cache-read share
  88.3%. Historical peak 429 RPM; ~4-core host, load ~4 ambient, 5.9GB RAM.
- Retry boundary (code-verified): all retries (transport, non-2xx, gate
  fake-200/overload throw at forwarder.ts:3851) run before gate commit;
  post-commit fake-200 is accounting-only (finalize + breaker).

## Phase 0 — baseline measurement (no code change)

1. Mock upstream container on cch-docker-green network: /v1/responses SSE
   responder (response.created + K output deltas with realistic pacing +
   response.completed with usage/service_tier/prompt_cache_key).
2. Temporary CCH provider pointing at the mock (admin API, named
   loadtest-*), temp key with small limit, providerGroup isolated from
   production groups (precedent: 2026-07-22 provider-111 test pattern).
3. Load generator container on the same network hitting the canary app
   directly (bypasses HAProxy entirely): synthetic 430KB median bodies
   (+ small share of 1MB), stream duration 30-60s; concurrency ladder
   50 -> 100 -> 150 -> 200 -> 250, 2-3 min per step.
4. Record per step: canary RSS (docker stats), heap via
   --max-old-space pressure signals, sustained RPS, p50/p95 first-byte and
   total latency, restarts/OOM. Compute RSS-vs-concurrency slope.
5. Guardrails: host load < 6.5, prod backends econ/eresp flat, DB write
  latency unaffected; abort step on breach. All test requests tagged
  session_id 'loadtest-%'.
6. Cleanup: disable+remove temp provider/key; DELETE message_request /
   usage_ledger rows WHERE session_id LIKE 'loadtest-%' (rows created by
   the test itself; Human to acknowledge deletion step).

## Phase 1 — implementation

1. `ProxySession.releaseRequestBodyAfterCommit(billingProjection)`: clears
   request.message (to a frozen empty + released flag), forwardedRequestBody
   + cached pair; stores projection {model, originalModel?, stream,
   service_tier, prompt_cache_key?}. `getBillingRequestMessage()` prefers
   projection; `getBillingModel()` likewise.
2. Hook at the gate-commit site (where streamGateCommitMarker is set) for
   canonical /v1/responses+codex traffic; non-stream release after response
   body consumption; release in finalizeStream's finally as belt for
   aborted/edge paths. Non-gated provider types keep current behavior.
3. Consumer audit from the existing inventory: convert post-commit readers
   to the projection; pre-commit readers untouched. Accessor guard throws
   a clear error on tree access after release (test/dev surface).
4. B memory alignment: bump B mem_limit to 3347054592 in the B candidate
   compose for this release (applied at replacement time; NODE_OPTIONS
   already 2048).
5. Tests: release lifecycle unit tests (clear + projection + guard),
   billing parity (projection vs tree for model/tier/cache-key), existing
   streaming + abort acceptances stay green; full gates (tsgo, biome,
   vitest, build).

## Phase 2 — rollout and re-measurement (fast ladder per Human preference)

1. Assemble image (established artifact playbook), canary up (no HAProxy
   registration), quick Tier1/2: streaming acceptance, abort-post-commit
   billing, failover pre-commit (fake-200 via mock provider returning an
   error stream: must retry to next provider, proving tree still live
   pre-commit).
2. Re-run the SAME Phase 0 load profile on the new canary -> RSS slope
   comparison is the benefit proof.
3. A/B replacement via the established replace playbook (B's candidate
   compose carries the new mem_limit); retire canary; verify 50/50,
   daytime observation.
4. Record results in cops notes; update this plan status.

## Deferred

- Release for non-gated provider types (claude/openai-chat/gemini) if ever
  needed; compressed retention variant (only if a snapshot consumer
  appears); request streaming-parse (avoid materializing the tree at all).

## Current state

Plan drafted 2026-08-20 after capacity discussion; Phase 0 next on Human
acknowledgment of the load-test cleanup deletion step.
