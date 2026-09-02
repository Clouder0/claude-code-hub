# CCH/Cyber Check containment v3

Status: Ready for immutable artifact preparation (strict bio policy)

## Goal

On the CCH `codex/compaction-v2` code line, make confirmed upstream policy outcomes produce
consistent, low-latency, explainable containment at request, session, installation, and principal
scopes, with an administrator UI that can inspect and operate the state. Installation policy is:
first actionable `cyber_policy` hit -> 5 minute restriction; second distinct actionable hit for the
same `(principal_id, installation_id)` within 30 days -> indefinite restriction until reset.
Principal policy remains two distinct actionable `cyber_policy` hits in 30 days -> indefinite
principal restriction and CCH user disable. One confirmed `bio_policy` permanently restricts every
available session/installation/principal scope until source-specific administrator reset;
`cyber_safety_check` remains audit only.

## Operating model

- `cyber_policy` and `bio_policy` are exact upstream structured policy rejections. They are terminal:
  no retry, provider switch, hedge continuation, or circuit-health penalty.
- CCH's `security_event` is audit/UI evidence. Cyber Check owns automatic strike/restriction/reset
  state; CCH must not recompute a competing automatic counter.
- `CYBER_CHECK_MODE=shadow/observe` disables predictive reviewer enforcement only. It must not make
  an already confirmed upstream policy restriction executable as allow.
- No outbox, queue, or second asynchronous state machine. A confirmed provider event is reported
  synchronously once with idempotent central semantics. Local session containment is applied first.
- Installation identity is scoped to `(principal_id, client_instance_id)`, is not a credential or
  hardware identity, and can be absent or replaced. Never create a global installation blacklist.
- Manual installation restriction is separate from automatic restriction and is scoped to the same
  principal/installation pair. This task may establish the central data/API/UI needed for it, but no
  cross-principal or IP/device fingerprint policy is in scope.

## Authority and failure semantics

- Cyber Check is the authority for automatic provider events, strikes, restrictions, and reset
  watermarks. CCH is the authority for user enablement, local fast rejection, and operator audit.
- Normal requests perform one bounded local/shared-state containment read, not a synchronous Cyber
  Check review call. Target added hot-path latency is sub-millisecond for local state.
- On provider-event transport failure, preserve current request rejection and local session/first-hit
  containment; report central state as unconfirmed rather than fabricating principal/install state.
  Do not introduce durable outbox recovery.
- Reset/release operations are explicit, scoped, audited, idempotent, and never delete evidence or
  implicitly clear another scope.

## Scope

1. Cyber Check: configurable 5-minute first installation restriction, transactional distinct-event
   counting, principal/install state/reset semantics, and explicit manual installation restriction
   API if it can be added without a second state authority.
2. CCH: policy containment integration, central result handling, local execution lookup for active
   automatic/manual restrictions, event correlation/idempotency, and admin actions.
3. CCH UI: Security Events becomes the primary investigation/containment entry; reuse the user Cyber
   state component as a secondary entry. Show signal type, scope, source, expiry, strikes, central
   confirmation, and separate automatic/manual operations.
4. Tests: transport matrices, concurrency/idempotency, 5m/forever transitions, reset isolation,
   authorization, degraded central/Redis behavior, UI states, and focused/full repository gates.

## Non-goals

- No outbox or message broker; no global installation identity; no prompt-text classifier; no new
  scoring system; no automatic action from `cyber_safety_check`, ordinary text, `invalid_prompt`, or
  reviewer prediction; no production deployment, merge, push, or commit without separate authority.

## Roadmap

1. Implement and test Cyber Check automatic 5m/forever semantics and central state model.
2. Implement CCH local/central containment seam and preserve existing terminal policy handling.
3. Add manual installation restriction as an independent central source with append-only operation
   audit, actor/reason, idempotency, and source-isolated release. It never changes automatic strikes;
   automatic reset never releases it.
4. Make Security Events the primary operator entry by opening the live central state and scoped
   operations for an affected user; retain the user-edit view as a secondary entry.
5. Synchronize the CCH Redis execution index only after central success. Re-read combined central
   state after reset/block/release so releasing one source cannot accidentally release another.
6. Run focused and full repository gates, then stage/fake-upstream acceptance before production.

## Blocked stop conditions

- Correct automatic state requires an unapproved identity or policy assumption.
- No-outbox constraint makes required reliability impossible without silently weakening semantics.
- Existing deployed schema/API compatibility requires migration or public behavior beyond this
  envelope.
- Tests cannot prove concurrent event/reset ordering or a failure would be represented as success.

## Review and handoff

- Automatic and manual installation restrictions coexist as separate rows and release independently.
  Manual operations are append-only audited and idempotent; they never change provider strikes.
- Security Events opens the live central state and scoped operations for affected users. The existing
  user-edit entry remains available for users without a recent security event.
- CCH re-reads central state after every installation reset/block/release and strictly synchronizes
  Redis with the central absolute expiry. A local synchronization failure returns an operation failure
  instead of claiming the request path is protected.
- Review found and fixed an expiry drift where source reconciliation could have restarted a complete
  five-minute local TTL after the central restriction had partly elapsed.
- Cyber Check full tests pass; CCH full tests, typecheck, generated OpenAPI drift check, changed-file
  formatting, and both worktree diff checks pass. Production deployment order must be Cyber Check
  migration/API first, then CCH, because the new CCH state parser requires the additive source fields.
- A real local Cyber Check process using fresh temporary SQLite/Fjall stores passed authenticated HTTP
  acceptance: unauthenticated state was 401; manual block was 204 and visible with zero strikes;
  automatic reinstatement preserved the manual source; manual release was 204 and removed the state.
  The temporary process and stores were removed after the run.
- Strict bio implementation is complete in both worktrees. Its initial completion pass covered the
  full CCH and Cyber Check suites plus OpenAPI generation/check, typecheck, migration validation,
  changed-file formatting, and diff checks.
- Artifact-readiness review additionally made the provider-event version boundary executable:
  `bio_policy` is rejected on V1 and requires V2. It also fixed the bio-release administration path
  so a disappeared CCH user row cannot be reported as successfully enabled.
- Final post-review evidence: CCH production build passes; full Vitest passes 800 files / 7419 tests
  (14 skipped); targeted containment/admin tests pass 67/67. Cyber Check fmt, clippy with warnings
  denied, and the full suite pass with 61 API-contract, 8 maintenance, 7 fixture, 6 reviewer-wire,
  56 unit, and 1 reviewer-eval tests.

## Proposed amendment: strict bio policy

Human changed the bio policy commitment: one exact upstream `bio_policy` rejection must immediately
restrict the request's session, scoped installation when present, and principal indefinitely until an
administrator explicitly resets each affected scope. It also disables the mapped CCH user. Bio remains
an upstream-confirmed fact, not a Reviewer prediction or text classifier result.

Recommended model:

- Generalize the central provider-event protocol from cyber-only to exact `cyber_policy | bio_policy`.
  Preserve policy code in storage and idempotency so one upstream response can retain both signals
  without conflict.
- Add `provider_bio_policy` as an independent restriction source. A bio event creates indefinite
  session, client-instance (if identity exists), and principal restrictions in one central transaction.
  It has no strike counter or time window; one distinct confirmed event is sufficient.
- Keep cyber and bio reset epochs/source releases independent. Resetting bio must not erase cyber
  strikes; resetting cyber must not release bio. Manual restrictions remain independent from both.
- Replace the Cyber-only administration projection with an additive policy-containment projection that
  exposes source, policy, session/installation/principal scope, creation time, central confirmation and
  reset actions. Security Events remains the primary operator entry.
- CCH immediately writes permanent local bio execution keys for every available scope and disables the
  mapped user before reporting the central event. Its security event stores the installation identity
  and a `pending | confirmed | unconfirmed` delivery status; this is execution/audit state, not a second
  strike authority. Central confirmation upgrades only that status. Every source-specific reset re-reads
  combined central state before changing Redis or enabling a user.
- No outbox and no automatic retry worker. A failed central report leaves the strict local containment in
  force and marks it `unconfirmed`; the UI may explicitly retry the same idempotent event or release the
  local unconfirmed containment with an audited administrator decision. It never presents unconfirmed
  state as central truth.

Acceptance additions:

- one confirmed bio event creates permanent restrictions at every available scope in both observe and
  enforce Reviewer modes, without retrying/switching provider or affecting circuit health;
- missing installation identity still permanently restricts session and principal, while clearly
  representing that no installation scope could be applied;
- cyber, bio and manual restrictions coexist and every reset releases only its selected source/scope;
- a principal cannot be re-enabled while any central principal restriction source remains;
- duplicate and concurrent bio events are idempotent, and a response containing both cyber and bio
  retains both facts while bio's stricter containment wins execution;
- central-report failure still blocks all locally identifiable scopes, is visible as unconfirmed, and
  can be explicitly retried/reset without an automatic delivery queue;
- migration from the current provider-event schema preserves all existing cyber events, restrictions,
  reset watermarks and manual audit history.
