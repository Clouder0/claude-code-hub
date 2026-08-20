# Bio Policy Containment

Status: Integrated and verified — Ready for Acceptance

Extends the framework built in `codex-cyber-security-events.md` (read that plan first; its V1
containment design, invariants, and production history are the baseline this change lives in).

## Goal

### Target

Recognize a structured upstream `bio_policy` rejection on the same transports and decision
boundaries as `cyber_policy`, and contain it: no retry, no provider switch, no circuit-breaker
penalty, session blocked for 24h, one security event recorded. Give administrators visibility of
bio blocks on the existing Security Events page.

`invalid_prompt` (usage-policy rejections) is explicitly out of scope for this change.

### Success conditions

- Non-streaming HTTP, SSE prefix/stream-gate, hedge, and deferred-streaming-finalization paths
  recognize `error.code === "bio_policy"` (top-level error object and `response.failed` event)
  structurally, without message-text matching.
- Once `bio_policy` is confirmed: CCH makes no further attempt for that request, does not switch
  provider, does not count provider/circuit failure, and preserves the upstream failure semantics
  to the client (HTTP 400 with `error.code: "bio_policy"`; committed streams are not rewritten).
- The session id is blocked (Redis `session:{id}:bio_blocked`, TTL 24h). Subsequent requests with
  that session id are rejected before provider selection with a structured `bio_policy` 400.
- Exactly one `security_event` row of type `bio_policy` per request (existing
  `(message_request_id, type)` uniqueness), attributed to the user.
- **No automatic user disable for bio_policy** (Human decision 2026-08-21). Strike counting stays
  cyber-only; bio events never contribute to the cyber strike count.
- Existing `cyber_policy` behavior is byte-for-byte unchanged, including session block, strike
  disable, and guard rejection code.
- The Security Events page lists bio blocks, counts them as policy blocks (separate from safety
  checks), renders a destructive badge, and shows a localized type label in all five locales.
- Focused tests meet the repository 80% coverage bar for new/changed code; build, lint, typecheck,
  and the full suite pass.

### Blocked stop conditions

- Live or fixture evidence shows first-party bio rejections do not use the structured
  `error.code === "bio_policy"` shape (falls back to the codex client evidence already collected;
  re-align before inventing text heuristics).
- Correct handling turns out to require a schema migration or public protocol change (current
  evidence says it does not: `security_event.type` is `varchar(32)` with a TS-level type cast).
- Commit, push, or deployment steps become necessary; those remain separately authorized.

## Operating Model

- Supported scope: the same three transports and four decision sites as the cyber framework
  (categorization, retry loop, hedge path, deferred streaming finalization, guard pipeline).
- Structured signal: confirmed block `error.code === "bio_policy"` in an HTTP error body or SSE
  `response.failed` event. No bio `safety_buffering` variant is recognized (no protocol evidence;
  revisit if one is observed in the wild).
- Containment intensity (Human-decided 2026-08-21): block session + record event + retry
  short-circuit; **no** user auto-disable. Rationale: bio flags hit legitimate medical/pharma/bio
  research traffic (OpenAI runs a Trusted Access program for exactly that population), so
  punishment stays evidence-driven — escalate to strike-disable only after operational event data
  justifies it.
- Internal invariants carried forward from the cyber plan: classification is a small closed type;
  a policy rejection is a request outcome, never a provider-health outcome; containment is decided
  before and independently of event persistence; session-provider affinity is never cleared as
  containment; persistence is best-effort observability.
- Rollback posture: no DB migration; an older image simply ignores bio rows in `security_event`
  and bio Redis keys expire via TTL. Image rollback is a complete rollback.

## Decisions and Authority

### Human-decided / locked

- Bring `bio_policy` into the cyber handling framework; defer `invalid_prompt`.
- Containment intensity: session block + event recording, no auto-disable (2026-08-21 decision
  above).

### Agent-delegated

- Naming/generalization mechanics (see Proposed approach): widening the closed type, renaming
  `cyber-*` modules/types to policy-neutral names, and how the policy identity is carried through
  `ErrorCategory`, containment, and the guard step.
- Guard-step ordering when both block keys exist (first-match wins; document it).
- Repository aggregation details (bio counts as a policy block), dashboard label copy, test file
  organization, scoped coverage config updates.

### Provisional

- Bio session-block TTL = 24h (same as cyber). May be split into its own constant later if
  operational data diverges.
- Guard rejection message reuses the existing hardcoded upstream-policy message; only the
  structured `code` differs.

### Deferred

- Strike/auto-disable for bio (revisit trigger: real bio event volume shows abuse).
- `invalid_prompt` / usage-policy handling (Human explicitly deferred: "之后再说").
- bio `safety_buffering` additional-check variant (no protocol evidence).

## Proposed Approach

### Current system model

The cyber framework (see `.agent/plans/codex-cyber-security-events.md`, deployed 2026-08-20)
consists of: `src/lib/security/cyber-security-signals.ts` (closed-type structural detector),
`src/lib/security/cyber-containment.ts` (block/record/strike), `ErrorCategory.CYBER_POLICY` in
`src/app/v1/_lib/proxy/errors.ts` (classification short-circuit), five forwarder sites (retry
loop 1863, fake-200 prefix 3803, stream-gate upstream_failure 3886, hedge 4534, hedge terminal
5248), response-handler finalization (1030-1286), error-handler (285 override-skip, 516 terminal
code), and the guard pipeline `cyberBlock` step. `security_event.type` is `varchar(32)` typed via
`$type<CyberSecurityEventType>()` — widening the TS union needs no migration.

### Recommended design

1. **Widen and neutralize the signal layer.** Rename `cyber-security-signals.ts` ->
   `security-signals.ts` (git mv), `CyberSecurityEventType` -> `SecurityEventType`, closed type
   `["cyber_policy", "cyber_safety_check", "bio_policy"]` with a `PolicyRejectionType` subset
   (`"cyber_policy" | "bio_policy"`). `detectCyberSecuritySignals` -> `detectSecuritySignals`
   (also detects `error.code === "bio_policy"` in both shapes); keep the raw-text scan covering
   both codes. `SSE_FINALIZATION_MARKERS` in `src/lib/utils/sse.ts` gains `"bio_policy"`.
2. **Generalize the category, carry policy identity as data.** Rename
   `ErrorCategory.CYBER_POLICY` -> `POLICY_REJECTION` (one category; decision semantics are
   identical for both policies). `isCyberPolicyError` -> `isPolicyRejectionError`, plus
   `policyRejectionCodeOf(error): PolicyRejectionType | null` derived from the same parsed /
   rawBody / body inspection. Every existing `CYBER_POLICY` branch switches on the category and
   uses the derived code only where the label matters (terminal code, containment, guard
   response). This avoids a parallel `BIO_POLICY` member that every branch would have to
   remember to also check.
3. **Containment table.** `cyber-containment.ts` -> `policy-containment.ts` (git mv).
   `containUpstreamPolicyRejection(session, policy)`: per-policy action table
   `{ cyber_policy: { block: true, strike: true }, bio_policy: { block: true, strike: false } }`;
   block key `session:{id}:bio_blocked` (TTL 24h); strike-disable SQL remains cyber-only.
   `containCyberPolicy` becomes a thin wrapper (or call sites use the new entry point directly).
4. **Guard step.** `cyberBlock` -> `policyBlock` in `GuardStepKey` and all presets; the step
   checks both block keys, rejects with the matching structured code before provider selection
   (cyber checked first when both exist; documented).
5. **Decision sites.** Apply the category + derived code at: categorization (before DB error
   rules), retry loop stop + containment, hedge containment + terminal error, fake-200 prefix
   (statusCode 400, matcherId = policy code), stream-gate `upstream_failure` (throw the
   structured 400 with the detected code instead of hardcoded cyber), response-handler
   finalization (contain with detected policy, errorMessage = code, matcherId = code, chain
   reason `client_error_non_retryable`, binding untouched, no breaker failure), error-handler
   (override-skip + terminal code for both).
6. **Persistence and dashboard.** Widen `insertSecurityEvent` / `RecentSecurityEvent` types;
   `policyBlockCount` FILTER becomes `type IN ('cyber_policy', 'bio_policy')` (keeps the locked
   blocks-vs-checks distinction). Security Events page: destructive badge for any block type;
   localized `bio_policy` label in en / ja / ru / zh-CN / zh-TW.
7. **Client contract.** Non-streaming: upstream 400 body preserved with `error.code`
   `bio_policy` (codex client then shows its bio safety card). Guard rejection: 400 with the same
   structured code. Committed streams: never rewritten (unchanged rule).

### Meaningful alternatives

- **Parallel `BIO_POLICY` enum member + duplicated branches**: smaller rename diff, but six+
  decision sites must each check both members and every future policy multiplies again. Rejected:
  identical decision semantics belong in one category.
- **Keep `cyber-*` names, just add bio detection**: minimal diff, but module/type names become
  actively wrong; the framework is now multi-policy. Rejected for semantic clarity; git mv keeps
  history.
- **Shared block key / shared strike counter**: muddles per-policy rollback and re-introduces
  uncalibrated punishment through the back door. Rejected.

### High-level roadmap

1. Signal layer + categorization + containment core (rename, widen, generalize). Cyber tests stay
   green throughout — this phase must not change any cyber behavior.
2. Decision sites (forwarder x5, response-handler, error-handler, guard step) + SSE marker.
3. Repository aggregation, schema `$type`, dashboard labels/i18n.
4. Full verification (below), plan update, review.

## Verification strategy

Extend the existing cyber suites in place (rename files to match modules); add bio twins for
every cyber behavior, plus bio-specific negatives:

- **Signals** (`security-signals.test.ts`): bio positives (top-level error code,
  `response.failed` response.error, raw-text scan incl. BOM), negatives (wrong code, string data
  events, partial JSON, `safety_buffering` cyber-only does not emit bio), closed-type exhaustiveness.
- **Containment** (`policy-containment.test.ts`): bio blocks session under `bio_blocked` (24h) and
  not under `cyber_blocked`; contain order (block before event); bio never calls strike-disable
  (user enabled after N bio events); bio events do not inflate the cyber strike count; Redis
  failure stays fail-open; cyber path unchanged.
- **Classification** (`cyber-policy-error.test.ts` -> `policy-rejection-error.test.ts`): bio from
  parsed / rawBody / body -> `POLICY_REJECTION` before DB rules and before override lookup;
  non-policy 400s still fall through to rules/PROVIDER_ERROR; `policyRejectionCodeOf` round-trips.
- **Retry loop / hedge** (existing forwarder test seams): bio 400 -> single attempt, no provider
  switch, containment once, chain entry recorded; hedge path aborts sibling attempts; terminal
  error is the upstream bio error, not all-providers-unavailable.
- **Stream gate**: SSE `response.failed` bio before commit -> structured 400 `bio_policy`, no
  downstream commitment; fake-200 prefix with bio -> statusCode 400, matcherId `bio_policy`.
- **Deferred finalization**: committed stream ending in bio `response.failed` ->
  effectiveStatusCode 400, errorMessage `bio_policy`, event recorded (type bio_policy, once),
  session binding not cleared, no circuit-breaker failure recorded.
- **Error handler**: terminal envelope carries `code: "bio_policy"`; error-override config is
  skipped for bio exactly as for cyber.
- **Guard pipeline** (`guard-pipeline-cyber-block.test.ts` -> `guard-pipeline-policy-block.test.ts`):
  bio-blocked session -> 400 `bio_policy` before provider selection (upstream hit counter
  unchanged); cyber-blocked -> `cyber_policy`; unblocked / no-session pass.
- **Repository** (`security-events.test.ts`): insert bio type; `(request, type)` uniqueness allows
  one cyber + one bio per request; `policyBlockCount` counts both; recent list renders bio rows.
- **Dashboard page**: bio row badge destructive, localized label present in all five catalogs
  (extend existing page test pattern).
- **Regression**: the full existing cyber suite passes unmodified in semantics; `invalid_prompt`
  and ordinary 400s remain on the generic path (explicit negative test).
- **Gates**: `bun run build`, `bun run lint`, `bun run typecheck`, `bun run test`; scoped
  coverage >= 80% for changed feature code (update `tests/configs/cyber-security-events.config.ts`
  include paths, rename accordingly).

Out-of-scope verifications (recorded for the future deployment decision, mirroring the cyber
rollout): canary end-to-end with a mock upstream, production gray release, and migration steps —
none are needed here because there is no migration and no schema contract change.

## Execution notes

- Work in an isolated worktree `.worktrees/bio-policy` on branch `codex/bio-policy` from
  `codex/compaction-v2` HEAD. The main checkout has unrelated in-flight edits
  (session-extractor, proxy-handler, endpoint-family-catalog, endpoint-paths) that must not be
  touched.
- PR target branch: `dev` (AGENTS.md).
- No emoji in code; user-facing strings i18n'd in all five locales; migrations only via
  `bun run db:generate` (none expected here).
- Commit / push / deploy remain outside this Plan's authority.

## Implementation status (2026-08-21)

Implemented on branch `codex/bio-policy` in worktree `.worktrees/bio-policy`, based on
`codex/compaction-v2` HEAD `46a2ad68`. 29 files changed (+845/-236), including git-mv renames
preserving history.

### What was built

- `src/lib/security/security-signals.ts` (renamed from cyber-security-signals): closed type
  widened to `["cyber_policy", "cyber_safety_check", "bio_policy"]`; `POLICY_REJECTION_CODES`
  carries cyber-first priority; detection helpers renamed (`detectSecuritySignals`,
  `detectPolicyRejectionCode[FromText]`, `firstPolicyRejectionCode`, `isPolicyRejectionType`).
- `src/lib/security/policy-containment.ts` (renamed from cyber-containment): session block key
  template preserves the deployed `session:{id}:cyber_blocked` format exactly (suffix strips
  `_policy`; bio gets `bio_blocked`); `findSessionBlockPolicy` checks cyber first; strike
  disable stays cyber-only via `STRIKE_ELIGIBLE`; `containPolicyRejection(session, policy)`
  replaces `containCyberPolicy`.
- `errors.ts`: `ErrorCategory.CYBER_POLICY` -> `POLICY_REJECTION` (enum position unchanged, so
  auto-numbering is identical); `policyRejectionCodeOf` is the single detection path;
  `isPolicyRejectionError` delegates to it, so classification and containment cannot diverge.
- Decision sites: retry loop + hedge + hedge-terminal (forwarder), fake-200 prefix (statusCode
  400, matcherId = policy code), stream-gate upstream_failure (structured 400 with detected
  code), deferred finalization (contain per detected policy, effectiveStatus 400, errorMessage =
  code, no binding clear, no breaker failure), error-handler (override skip + terminal code for
  both), guard step `cyberBlock` -> `policyBlock` (per-policy structured 400, presets updated).
- `sse.ts` finalization markers gained `"bio_policy"`; `security_event.type` `$type` widened
  (varchar(32), **no migration**); repository `policyBlockCount` FILTER now
  `IN ('cyber_policy', 'bio_policy')`; Security Events page shows destructive badge for any
  policy rejection + localized `types.bioPolicy` in all five catalogs (ja uses halfwidth parens,
  zh-TW fullwidth, per the i18n tests).

### Verification evidence

- Focused: 34 security-lib tests, 1651 tests across proxy/repository/dashboard suites — all pass.
- Scoped coverage (`tests/configs/policy-security-events.config.ts`): 97.91% statements /
  92.06% branches / 100% functions / 98.87% lines (bar: 80%).
- `bun run typecheck`: pass. `bun run build`: pass.
- `bun run lint`: 0 findings from changed files; the 4 remaining findings are pre-existing at
  HEAD (verified by diffing lint output against the untouched main checkout; baseline HEAD itself
  exits 1). lint:fix reflows of six unrelated drifted files were reverted to keep the diff clean.
- Full suite: 7287 passed / 13 skipped / 1 failed — `language-switcher.test.tsx` fails
  byte-identically on the untouched main checkout at the same HEAD (pre-existing baseline
  failure, outside this change's causal path).
- A test caught one real defect during implementation: the naive block-key template produced
  `cyber_policy_blocked`, breaking compatibility with deployed Redis keys; fixed to preserve
  `cyber_blocked` exactly.

### Material deviations from the plan

- The "per-policy action table" became a `STRIKE_ELIGIBLE` set (block applies to all policy
  rejections unconditionally; only strike differs). Same information, less structure.
- Everything else follows the approved design.

### Merge considerations (Human attention)

- Resolved during integration into `codex/compaction-v2`: the Alpha Search preset now uses the
  renamed `"policyBlock"` step. A combined regression test proves cyber- and bio-blocked Alpha
  sessions terminate before provider selection and message-context/billing construction.
- Deployment: no DB migration; rollback is image-only. Bio Redis keys expire via 24h TTL.
  Canary end-to-end (mock upstream returning bio_policy, throwaway user/session) is the
  recommended pre-rollout acceptance, mirroring the cyber rollout's Tier 2.
- Commit / push / deployment remain separately authorized.

## Review (2026-08-21, production-grade pass)

Two independent fresh-context reviewers (correctness lens; production-risk + test-gap lens),
plus Primary verification of the highest-stakes claim. Verdict: **no confirmed defects**;
three improvements adopted and applied.

### Verified obligations (no findings)

- **`?? "cyber_policy"` fallback unreachability** (the one claim whose failure would
  auto-disable a production user on a bio rejection): retry loop classifies and derives from
  the same `lastError` assignment (forwarder.ts:1812/1816); hedge derives from the local
  `error` param (4502-4504); `categorizeErrorAsync` returns POLICY_REJECTION only via
  `policyRejectionCodeOf(error) !== null` (same pure function, readonly upstream payload).
  Verified by both reviewers and independently by Primary.
- Cyber parity at every changed site (enum slot/value, detection order, override skip,
  terminal-code precedence, finalization branches, chain entries, guard response shape).
- bio detection mirrors cyber structurally; SSE marker change is consumer-identical
  (field-driven consumers only).
- DB: no migration needed ($type is compile-time); unique constraint permits one cyber + one
  bio row per request; strike SQL cyber-only. Verified from code, not assumption.
- Rollback both directions: old image ignores bio rows/keys; new image byte-preserves
  `cyber_blocked`. Mixed canary only undercounts bio on the old dashboard (expected).
- i18n conventions (ja halfwidth / zh-TW fullwidth enforced by tests).

### Findings adopted (fixed in this pass)

1. **Guard hot path: 2 sequential Redis GETs -> 1 MGET.** `findSessionBlockPolicy` now fetches
   all block keys in one round trip; fail-open and cyber-first priority preserved. The cyber
   rollout risk register had flagged the per-request GET; this keeps the feature's Redis
   contribution at one op regardless of policy count.
2. **Test promise gaps closed**: real-hedge bio test (firstByteTimeout > 0 drives
   sendStreamingWithHedge; containment once with bio, terminal error is the upstream-derived
   400 with matcherId bio_policy, not all-providers-unavailable); both-signals stream
   containment test (cyber then bio, exactly once each); WS adapter bio twin. One test-authoring
   error surfaced and corrected: fake-200-path policy ProxyError keeps the FAKE_200 detector
   code as its message (same as cyber at baseline); policy identity rides on
   statusCodeInferenceMatcherId + rawBody + the client terminal code.
3. **Stale sse.ts consumer comment** updated to mention bio.

### Noted, not blocking

- Six log strings changed (Cyber->Policy wording); nothing in-repo greps them (verified
  against cops runbooks); ship the old->new mapping in the deploy note.
  `[CyberContainment]` prefix deliberately retained on the cyber-only strike-disable logs.
- One-image rollback caveat: bio rows render as generic "additional check" badges on the old
  dashboard; transient mixed-fleet behavior during gray release.

### Final gates (after review fixes)

typecheck pass; lint findings remain a strict subset of baseline (0 new); scoped coverage
97.95% stmts / 92.06% branches / 100% funcs; full suite 7290 passed / 13 skipped / 1 failed
(pre-existing `language-switcher` baseline failure, byte-identical on untouched HEAD checkout);
production build pass.

## Integration result (2026-08-21)

Merged the reviewed `codex/bio-policy` history into `codex/compaction-v2` after Alpha Search commit
`080cf73d`. Git reported no textual conflicts. One predicted semantic conflict was repaired:
`ALPHA_SEARCH_PIPELINE` referenced the removed `"cyberBlock"` key and now uses `"policyBlock"`.

Combined verification on the merged tree:

- Alpha Search plus policy-containment focused run: 23 files, 438 passed, one environment-gated
  real-Pirelay test skipped. The new cross-feature cases cover both policy codes and prove the
  blocked request stops before provider selection and message-context/fixed-billing construction.
- Policy security coverage: 34/34 passed; 97.95% statements, 92.06% branches, 100% functions,
  98.88% lines.
- TypeScript and production build passed. All 24 changed TS/TSX/JSON files pass Biome after one
  in-scope test formatting correction. Full-repository Biome retains exactly the seven unrelated
  pre-existing errors plus two warnings and the schema-version notice seen before this merge.
- Full Vitest: 7,311 passed, 14 skipped, three failed. The OpenAPI drift failure was caused by the
  parent process PATH and passed when Bun was present. The remaining two reload-queue timing tests
  fail with the same 1-vs-2 and 3-vs-2 call counts on the untouched `080cf73d` worktree, proving
  they are baseline failures rather than a merge regression.

No database migration or new persisted compatibility obligation was introduced by the integration.
