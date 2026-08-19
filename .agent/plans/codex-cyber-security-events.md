# Codex Cyber Security Events and Containment

Status: Ready for Acceptance

## Goal

### Target

Protect shared upstream Codex accounts in CCH's multi-tenant deployment by recognizing the two
first-party cyber safety signals that can be attributed to a request, preventing a confirmed
`cyber_policy` rejection from being retried against another provider, and giving administrators a
small, reliable view from which they can inspect and disable responsible users.

### Success conditions

- Non-streaming HTTP, SSE, and Responses WebSocket paths recognize a structured
  `error.code === "cyber_policy"` without relying on message text.
- Once `cyber_policy` is observed, CCH makes no further attempt for that request, does not switch
  provider, and does not count the event as provider-health or circuit-breaker failure.
- The client continues to receive the appropriate upstream failure semantics. If streaming output
  was already committed, CCH does not invent a second terminal protocol outcome.
- SSE and WebSocket events with a non-false `safety_buffering` object whose `use_cases` contains
  `cyber` are recorded as additional safety checks without interrupting or rewriting the stream.
- Each request records at most one event of each supported type even when an upstream stream repeats
  the same signal.
- An administrator-only Security Events page shows recent events and per-user 30-day counts, keeping
  confirmed policy blocks separate from additional checks.
- From that page, an administrator can inspect the related request/user and invoke the existing user
  disable operation with confirmation.
- No raw prompt, response body, opaque moderation metadata, credential, or unbounded upstream JSON is
  added to security-event storage.
- Focused tests satisfy the repository's 80% coverage requirement for new feature code, and the
  required build, lint, typecheck, and full test gates pass.

### Blocked stop conditions

- Live or fixture evidence shows that the upstream structured fields differ materially from the
  verified Codex protocol and exact recognition would require heuristic prompt or message analysis.
- Correct containment requires changing a public protocol contract rather than preserving an
  upstream error already supported by clients.
- Current request lifecycle does not provide a stable `message_request` identity at the point where
  one of the three supported transports exposes the signal.
- The generated migration conflicts with newer schema work or requires a retention/attribution
  commitment beyond the recent-event scope; re-align before inventing compatibility machinery.
- Production inspection, migration application, commit, push, or deployment becomes necessary. Those
  actions remain outside this Plan's implementation authority unless separately authorized.

## Operating Model

### Supported scope

- CCH's OpenAI Responses-compatible non-streaming HTTP, SSE, and WebSocket proxy paths.
- Structured upstream signals:
  - confirmed block: `error.code === "cyber_policy"` in an HTTP error or `response.failed` event;
  - additional check: a `safety_buffering` object whose `use_cases` includes `cyber`.
- Attribution to the existing CCH request, user, API key, session, request sequence, and selected
  provider through `message_request`.
- Administrators viewing recent events and manually disabling a CCH user. Existing user-management
  authorization and self-disable protection remain authoritative.

### External guarantees

- The first-party Codex client treats `cyber_policy` as an exact structured error code and exposes
  `safety_buffering` independently from ordinary response events.
- `safety_buffering` may appear more than once during a stream and does not itself mean the request
  was rejected.
- Opaque moderation metadata, account verification recommendations, and model changes do not provide
  a stable tenant-attribution contract for CCH and are not enforcement inputs.

### Internal invariants

- Security classification is a small closed type with exactly two V0 values:
  `cyber_policy` and `cyber_safety_check`.
- `cyber_policy` is a client/request policy outcome, never a provider-availability outcome.
- Containment is decided from the structured signal before and independently of event persistence.
  A database failure must never cause provider retry or fallback.
- A security event is uniquely identified by `(message_request_id, type)`.
- User, key, session, provider, and request details have one source of truth in `message_request`; the
  security-event record does not duplicate them.
- Event persistence is observability. It may fail visibly and be logged, but it must not replace the
  upstream response or break an otherwise valid safety-buffered stream.
- Disabling a user rejects future requests through the existing user-enabled authorization boundary.
  Clearing session affinity is not a security containment operation.

### Failure semantics

- Confirmed `cyber_policy`: contain locally at the current request boundary, preserve the upstream
  failure, record best-effort event evidence, and do not penalize provider health.
- Additional safety check: preserve the stream exactly, record best-effort event evidence once, and
  apply no automatic punishment.
- Event insert failure: emit bounded operational diagnostics without prompt/body content; proxy
  semantics remain determined by the upstream signal.
- Dashboard query failure: fail as an admin-view error and has no effect on proxy traffic.
- User-disable failure: show the existing action error; do not claim that containment succeeded.

### Quality envelope

- Exact structural parsing only; no content classifier, regular-expression policy matching, or
  message-text fallback.
- No additional upstream requests and no new retry state machine.
- The hot streaming path performs bounded parsing and one idempotent persistence attempt per event
  type, not per repeated frame.
- Existing request forwarding, billing, provider selection, normal retry behavior, and protocol bytes
  remain compatible for traffic without the two supported signals.
- The page and all user-facing strings follow existing admin authorization, component, API, and
  five-language i18n conventions.

### Explicit non-goals and unsupported conditions

- Temporary bans, automatic re-enable, or strike policies beyond the V1 rule (2 confirmed
  `cyber_policy` events in 30 days -> disable; see the 2026-08-19 decisions section).
- Session termination or clearing provider affinity (the V1 session block is a rejection boundary
  that deliberately leaves affinity untouched).
- Composite risk/violation scores, lifetime labels, configurable rules, case management, alerts, or
  webhook notifications.
- Local prompt classification or storage of raw request/response content.
- Enforcement from `openai_verification_recommendation`, opaque turn moderation metadata, requested
  versus actual model differences, or unrecognized future safety fields.
- Provider-account risk scoring or automatic provider disablement.
- A standalone audit subsystem for security actions; the existing user-management operation remains
  the V0 enforcement boundary.

### Material assumptions

- `message_request` remains available for at least the recent-event window used by the page, so a
  narrow event table can use it as the sole attribution record. If request retention is shorter or
  deletion would erase required security evidence, retention semantics require Human review.
- The 30-day aggregation window is a simple operational default, not a policy threshold or permanent
  user score.
- Manual administrator response is acceptable after immediate per-request containment. Revisit only
  after real event data shows repeated abuse or unacceptable response latency.

## Decisions and Authority

### Human-decided / locked

- Prefer a restrained, compact, effective solution over a general security platform.
- Recognize only `cyber_policy` and cyber `safety_buffering` in V0.
- Treat confirmed blocks and additional checks as different facts; do not call both violations.
- Make `cyber_policy` non-retryable and prevent provider/account spreading.
- Provide a simple administrator view and manual user action rather than automatic punishment.
- Do not use session-affinity deletion as security handling.

These decisions should be reopened only if protocol evidence falsifies attribution or operational data
shows that manual handling cannot protect the upstream accounts.

### Agent-delegated

- Exact detector/helper boundaries shared across HTTP, SSE, and WebSocket paths.
- The smallest integration point that can classify before retry/circuit-breaker decisions while also
  observing committed streams.
- Repository/query organization, indexes justified by the two page queries, component reuse, and test
  fixture organization.
- Exact page layout and wording within the locked two-section information model and i18n requirement.
- Whether the existing disable action can be reused directly or needs a narrow compatibility wrapper,
  provided its authorization and user-enabled semantics remain unchanged.

### Provisional

- Use one narrow `security_event` table containing `id`, `message_request_id`, `type`, and
  `created_at`, with a unique constraint on request and type. Add only an index proven necessary for
  recent-event or 30-day aggregation queries.
- Name the administrator surface "Security Events" / localized equivalent rather than "Security
  Center".
- Present one page with two sections: affected users and recent events. Avoid tabs and charts.
- Show a fixed recent 30-day user aggregation and a bounded, paginated recent-event list; do not add a
  configurable policy window.

These defaults may change during implementation if current repository abstractions make an equally
small representation materially clearer, but the locked semantics may not change silently.

### Deferred

- Automatic suspension policy, thresholds, notification latency, and temporary-ban semantics remain
  evidence-driven follow-up decisions.
- Dedicated auditing or reason capture for enable/disable operations should be addressed consistently
  across user management, not introduced as a security-page-only parallel control plane.
- Broader upstream-account warnings and model-reroute signals remain candidates only after their
  attribution contracts are established.

## Proposed Approach

### Current system model

CCH creates a `message_request` with the user, key, session, provider, sequence, provider chain, and
response facts before/during forwarding. HTTP upstream errors become `ProxyError`; streamed
`response.failed` content can be recognized by the response prefix gate; Responses WebSocket has a
separate upstream adapter. Current generic provider-error categorization can send ordinary 4xx/5xx
failures through provider-health and fallback behavior, and there is no first-class cyber-policy
outcome shared by all three transports.

The repository already has administrator user pages and a `toggleUserEnabled` action. Session
termination removes Redis affinity and therefore selects another provider on future traffic; it is the
opposite of the desired containment semantics.

### Recommended design

1. Introduce a small structural signal classifier consumed by all Responses transports. It accepts
   already-parsed unknown JSON and returns only one of the two closed event types or no match.
2. Carry confirmed `cyber_policy` into the existing error categorization as an explicit non-retryable,
   non-circuit-breaker request outcome. Ensure prefix-gated and WebSocket failures use the same
   semantic decision rather than matching error text.
3. Generate a Drizzle migration for the narrow `security_event` relation. Insert idempotently by
   request and type; join `message_request` for all attribution and display data.
4. Observe `safety_buffering` without altering the forwarded event. Suppress repeated persistence work
   within a request and retain the database uniqueness constraint as the final concurrency guard.
5. Add admin-only queries/API and a single Security Events page containing affected-user counts and
   recent events. Reuse existing request/user navigation and the existing confirmed user-disable
   operation.

This design separates the safety fact from the request log without constructing a second policy,
identity, or action system.

### Causal scope

Required change surfaces are the Responses HTTP/SSE/WebSocket observation points, error
categorization/retry/circuit-breaker boundary, Drizzle schema and generated migration, event
repository/query layer, admin API/actions, dashboard navigation/page, i18n catalogs, and focused tests.

Provider scoring, generic error-rule configuration, request content filters, session management,
notification delivery, and the general user-management contract are verification dependencies or
explicitly excluded—not invitations for adjacent redesign.

### Meaningful alternatives

- Reusing `message_request.blockedBy` is smaller in schema count but cannot truthfully represent an
  additional check that did not block the request or two facts on one request. It also mixes local
  guard decisions with upstream safety observations.
- Adding nullable flags or a JSON array to `message_request` avoids a relation but makes event listing,
  uniqueness, and multiple event types less explicit. The narrow relation has the smaller semantic
  model.
- Automatically disabling users on first or Nth block would reduce response latency but introduces an
  uncalibrated punishment policy. Immediate no-fallback containment plus manual action protects the
  current request while generating the evidence needed for a later threshold decision.

### High-level roadmap

1. **Protocol and containment foundation**
   - Add exact classifier fixtures from the verified upstream shapes.
   - Integrate `cyber_policy` with HTTP/SSE/WebSocket error semantics.
   - Prove no retry, provider switch, or circuit-breaker impact before adding UI.
2. **Minimal persistence**
   - Add the narrow Drizzle relation and generate/review the migration.
   - Add idempotent persistence and prove repeated stream frames create one row.
   - Verify persistence failures cannot weaken containment or corrupt streaming.
3. **Administrator view and action**
   - Add admin-only recent-event and per-user aggregation queries.
   - Build the one-page, two-section localized view with existing navigation/detail links.
   - Reuse the confirmed user-disable flow and show actual success/failure.
4. **Goal-state verification and review**
   - Run transport regressions, authorization and query tests, migration review, coverage, and all
     repository gates.
   - Review against this Plan before declaring Ready for Human Acceptance.

The checkpoint after phase 1 is deliberate: containment is the safety-critical outcome and should be
proven independently of persistence and presentation.

### Verification strategy

- Classifier unit tests cover exact positive shapes, missing/wrong types, unrelated codes/use cases,
  `safety_buffering: false`, and untrusted nested lookalikes.
- HTTP tests prove a structured 400 `cyber_policy` returns once with no second provider selection and
  no circuit-breaker failure; ordinary retryable errors remain unchanged.
- SSE tests cover `response.failed` before output commitment, after commitment, repeated
  `safety_buffering` frames, a successful safety-buffered response, and malformed/unrelated events.
- WebSocket adapter tests cover equivalent confirmed-block and additional-check behavior without
  changing event ordering or payloads.
- Persistence tests prove `(message_request_id, type)` idempotency, two different event types on one
  request, joins to existing attribution, bounded query results, and contained insert failure.
- Admin/API tests prove non-admin denial, separate block/check counts, 30-day boundaries, pagination,
  disabled-user state, and honest action failure handling.
- Migration review verifies generated SQL, foreign-key/delete semantics, uniqueness, and only
  query-justified indexes. Migration files are generated through `bun run db:generate`, never written
  manually.
- New user-facing text is present in all five locale catalogs.
- Before handoff run `bun run build`, `bun run lint`, `bun run lint:fix`, `bun run typecheck`, and
  `bun run test`, plus focused coverage evidence at or above 80% for new feature code.

## 2026-08-19 Human Decisions: Containment Escalation (V1)

The Human reopened two previously locked exclusions and decided:

1. **Session block (immediate, automatic).** On a confirmed `cyber_policy`, block the session id
   (`session:{sessionId}:cyber_blocked`, TTL 24h). Subsequent requests carrying that session id are
   rejected with the same `cyber_policy` error before any provider selection or upstream call. This
   is a rejection boundary, not an affinity change: session-provider affinity is left untouched so
   the block cannot cause provider spreading.
2. **User auto-disable after two strikes.** On each confirmed `cyber_policy`, count the user's
   `cyber_policy` events in the trailing 30 days (durable `security_event` rows, user-attributed
   directly). At >= 2, disable the user through the repository `updateUser` boundary; the existing
   auth-guard `user.isEnabled` check then rejects all of the user's sessions and keys. Re-enable
   remains a manual admin action.

Consequences for the design:

- `security_event` gains a direct `user_id` column (not null, indexed) so events and strike counts
  survive `message_request` retention cleanup; `message_request_id` becomes nullable with
  `ON DELETE SET NULL` (request link is best-effort evidence, not the attribution anchor).
- A new guard step `cyberBlock` runs after `session` in the guard pipeline and rejects blocked
  sessions before provider selection.
- A new containment helper owns the three actions (record event, block session, strike-disable user)
  and is invoked at every confirmed `cyber_policy` site (main retry loop, hedge path, deferred
  streaming finalization). `cyber_safety_check` remains record-only.
- The Security Events page already surfaces the evidence an admin needs to review an auto-disable
  (user row with >= 2 policy blocks and disabled status); no new disable-reason field in V1.

Interpretation note: "consecutive" is implemented as "2 confirmed `cyber_policy` events within 30
days". With the session block in place, a second strike requires the user to start a new session
after being blocked, so the two strikes are effectively consecutive in practice; the 30-day window
keeps ancient history from counting. A stricter no-requests-in-between rule is a small follow-up if
operational data ever justifies it.

### V1 implementation status (2026-08-19)

- `security_event` now stores `user_id` directly (not null, indexed) and `message_request_id` is
  nullable with `ON DELETE SET NULL`; migration `0113_sour_namor` updated in place (never applied).
- `src/lib/security/cyber-containment.ts` owns the three containment actions: record event,
  block session (Redis `session:{sessionId}:cyber_blocked`, 24h TTL), strike-disable user
  (single idempotent UPDATE counting `cyber_policy` events in the trailing 30 days, threshold 2).
- Guard pipeline gained a `cyberBlock` step after `session` (CHAT and RAW_SAFE_SESSION pipelines)
  that rejects blocked sessions with the structured `cyber_policy` error before provider selection.
- `containCyberPolicy` is invoked at every confirmed `cyber_policy` site (main retry loop, hedge
  path, deferred streaming finalization); `cyber_safety_check` remains record-only.
- The Security Events page handles events whose request row was cleaned up (user attribution and
  user-scoped request links remain available).
- Verification: typecheck, biome, full suite (7056 passed; only the three pre-existing baseline
  failures), scoped coverage 97.4% statements / 90.74% branches / 100% functions / 98.57% lines,
  production build, and the strike-disable SQL exercised against a containerized test database
  (1 strike no disable, 2 strikes disable, idempotent re-run).

## Progress and Material Discoveries

- Read-only investigation established that first-party Codex uses the exact `cyber_policy` code and
  exposes `safety_buffering` as an independent stream signal that may repeat.
- Current CCH request records already carry the attribution needed by the page; no new user/session
  identity model is needed.
- Current generic provider-error semantics do not make `cyber_policy` a first-class terminal request
  outcome, so preventing provider fallback is the first implementation checkpoint.
- Human feedback reduced the proposal from a general Security Center to two facts, one containment
  rule, one narrow relation, one page, and reuse of one existing user action.
- Human approved full local implementation and testing in an isolated worktree, with Planning with
  Files and an active Goal. Commit, push, production migration, and deployment remain excluded.
- Isolated worktree `.worktrees/cyber-security-events` and branch `codex/cyber-security-events` were
  created from baseline `9b7917f1`.
- Phase 1 is implemented and covered across HTTP errors, early and committed SSE failures, hedged
  requests, and the Responses WebSocket adapter. Exact `cyber_policy` is terminal without retry,
  provider switching, affinity deletion, or provider/circuit failure; `safety_buffering` remains
  byte-preserving and non-blocking.
- Phase 2 is implemented with one generated `security_event` relation, request/type uniqueness,
  request-owned attribution, bounded queries, and a best-effort recorder whose failure cannot alter
  proxy control flow. Migration `0113_sour_namor` passes the repository idempotency validator and has
  not been applied.
- Phase 3 is implemented as one admin-only localized page with separate 30-day block/check counts,
  bounded recent events, request links, and reuse of the existing confirmed user-disable action.
- Focused regressions currently pass, query/pagination behavior is covered, locale catalogs parse,
  lint and typecheck pass with only baseline warnings, and scoped new-module coverage is 95.74%
  statements, 93.75% branches, 100% functions, and 97.56% lines.
- Production build succeeds and includes `/[locale]/dashboard/security-events`; migration validation
  passes all 115 migrations; five locale catalogs parse; lint/lint:fix and typecheck pass. One complete
  suite run passed 770 files and 7043 tests with 13 conditional skips after correcting the local Bun
  PATH used by an existing child-process test.
- The review added direct evidence for unauthenticated/non-admin denial, admin pagination, successful
  disable refresh, and honest disable failure. Those four tests pass. A subsequent complete run passed
  7045 tests but exposed two load-sensitive failures in the unchanged baseline
  `error-rule-detector-reload-queue.test.ts`; the test, detector, and event-emitter are byte-identical
  to HEAD and outside this task's import path. This is preserved as a non-blocking baseline quality
  signal rather than silently patched in the security-events change.

## Review and Handoff

### Review verdict

Ready for Human Acceptance. The second review found no material implementation defect or unresolved
Goal, evidence, quality, decision, or context delta inside the approved Operating Model.

### Evidence and Goal delta

Source tracing establishes the exact upstream shapes and all supported transport boundaries. Focused
tests prove exact detection, no retry/provider switch/provider penalty, preserved session affinity,
non-blocking additional checks, best-effort persistence, deduplication, bounded queries, admin-only
access, and honest manual action outcomes. Build, migration validation, locale parsing, lint,
typecheck, scoped coverage, and a complete green repository suite provide the remaining evidence.

### Material deviations

No semantic deviation from the latest Human-aligned V0 direction. The generated migration SQL was
made idempotent in the repository's required form after generation, and a scoped coverage config plus
direct page/action tests were added as executable evidence. Earlier exploratory ideas such as scoring,
session quarantine, automatic suspension, and a general Security Center remain intentionally excluded.

### Context worth carrying forward

- The product term "violation" applies only, if at all, to confirmed `cyber_policy` blocks; additional
  checks remain neutral observations.
- Future automatic punishment must be based on observed operational data and explicit Human policy,
  not inferred from this event schema.
- The security guarantee is no cross-provider spreading after a confirmed structured signal; event
  persistence and the dashboard are supporting observability and manual control.
- The unchanged error-rule reload-queue timing test can pass under the full suite and fail in another
  run or in isolation. Revisit it separately if the project requires every repeat to be deterministic;
  it does not share a causal path with this feature.

### Human attention

- Commit, push, migration application, production inspection, and deployment remain separate future
  authorization decisions.

## Production Deployment Plan (2026-08-19, not yet executed)

Status: planned; execution requires separate authorization. The provider-page query fix deploy
(`fc9eaad2`) must finish and be verified first; this feature is the next production change.

### Merge state

- Feature merged onto `codex/compaction-v2` (merge commit pending; conflicts resolved).
- Migration renumbered `0113_sour_namor` -> `0114_sour_namor` (journal idx 114, snapshot
  `0114_snapshot.json`); `0113_sudden_iceman` (availability fix) stays idx 113. Migration validator
  passes all 116 migrations.
- Branch is NOT pushed; the deploy flow needs a push decision.

### Phase 0 — Preconditions

1. Provider fix deploy (`fc9eaad2`) complete and verified on prod.
2. Confirm whether `0113_sudden_iceman` (availability) was applied in that deploy; if not, it must
   be applied before `0114_sour_namor` (journal order).
3. Push `codex/compaction-v2` (or the deploy flow's source of truth) after Human approval.

### Phase 1 — Database migration (0114_sour_namor)

- Apply via the established reviewed migration procedure (drizzle migrate against prod DSN, or the
  equivalent ops SQL path used for previous migrations).
- Content: `CREATE TABLE security_event` (user_id NOT NULL FK users, message_request_id nullable
  FK SET NULL, type, created_at), unique (message_request_id, type), indexes on created_at and
  (user_id, type, created_at). Additive only: no existing-table rewrite, no backfill, no lock risk
  beyond the FK constraint checks on an empty table.
- Verify: table + indexes exist; FK delete behavior is SET NULL (not cascade).
- Rollback: `DROP TABLE security_event` (safe; nothing in prod depends on it). Only after app
  rollback if the app is reverted.

### Phase 2 — Image build and canary

- Build the image from the merged branch using the established artifact flow
  (playbooks/hostdzire-cch-*-artifact.yml pattern).
- Deploy to canary backend (B) first; keep HAProxy weights unchanged.
- Canary checks: health, ordinary proxy traffic, dashboard pages, no new error logs.

### Phase 3 — Rollout

- Advance HAProxy weights through the established canary -> 50/50 -> 100 flow with observation
  windows.
- The guard pipeline now performs one Redis GET per request (`session:{id}:cyber_blocked`). Watch
  request latency and Redis load during the rollout; the GET is a single key lookup, but Redis is
  the box's top CPU consumer, so measure rather than assume.

### Phase 4 — Post-deploy verification

1. Security Events page: admin-only, loads, empty state renders; non-admin is redirected.
2. Normal traffic: no cyber signals in ordinary traffic, so no behavior change expected; confirm
   zero `cyber_policy` events recorded and zero session blocks written.
3. Containment behavior (staging preferred; on prod only with disposable test data):
   - Session block: set `session:{test}:cyber_blocked` in Redis, send a request with that session
     id, confirm 400 `cyber_policy` before any upstream call; delete the key.
   - Strike disable: insert two `cyber_policy` events for a disposable test user, confirm the
     user is auto-disabled and requests are rejected with `user_disabled`; re-enable and clean up.
4. Dashboard header shows the Security Events link for admins.

### Phase 5 — Rollback

- App: HAProxy weight back to the previous image (established flow); keep the old image retained.
- Migration: `DROP TABLE security_event` only after the app is rolled back (or keep the table —
  it is inert without the app writing to it).

### Risks and follow-ups

- Per-request Redis GET in the guard pipeline: measured during rollout; if it shows up in latency,
  a short-lived in-process cache of the block check is a bounded follow-up (a 1-2s staleness is
  acceptable for a 24h block).
- `security_event` has no retention policy yet; growth is bounded by cyber-signal frequency, but a
  retention decision (e.g., 90 days) is a follow-up before the table accumulates history.
- The strike rule (2 in 30 days) and session block TTL (24h) are operational defaults; revisit
  with real event data.
- The auto-disable writes `is_enabled=false` directly; the Security Events page shows the event
  evidence (>= 2 policy blocks) so an admin can distinguish auto-disable from manual disable
  without a dedicated reason field.
