# Cyber containment coverage completion (Codex scope)

Status: Implemented — local gates and cross-process proof green; awaiting Human review and the separate rollout go

Repos: claude-code-hub (`clouder`), cyber-check (`main`)
Production baseline at planning: CCH `19d17b16-cyberscope-hotfix` on A/B/canary;
cyber-check `72125ea` on greencloud. Fork default branch `clouder`, fork Actions disabled.

## Goal

Close the remaining gaps between today's behavior and the Human's target operating
model for Codex-related traffic:

> Upstream-confirmed policy rejections (cyber_policy, bio_policy) trigger real
> session/installation/principal containment; the local precheck + LLM reviewer
> system performs no enforcement of its own.

Remaining gaps established by production investigation on 2026-09-02/03:

1. `ALPHA_SEARCH_PIPELINE` lacks `cyberScopeBlock`: an installation- or
   principal-restricted client can still use `/v1/alpha/search` (755 req/48h).
2. Installation second hit is not locally permanent: CCH writes a permanent Redis
   block only when `policy === "bio_policy" || containment.principal_strikes >= 2`;
   an installation that reaches its own threshold alone gets another 5-minute block.
3. Blocking coverage for managed raw paths (remote compaction v2 = wire
   `/v1/responses` + `compaction_trigger`; `/v1/messages/count_tokens`) depends on
   the `allowNonConversationEndpointProviderFallback` system setting being enabled
   (default true). Disabled ⇒ these paths fall back to the guard-free
   RAW_PASSTHROUGH_PIPELINE.
4. The central strike chain (provider-event report → ledger → strike epoch →
   containment response → CCH execution-index writes) has never been exercised by
   any real or synthetic event; `provider_events` is empty in production.

### Success conditions

- An installation/principal-restricted principal requesting `/v1/alpha/search`
  receives the same scoped 400 rejection as on `/v1/responses`.
- Two actionable provider cyber_policy events for the same installation within the
  strike window produce a locally permanent installation block (no expiry), without
  requiring the principal to reach its own threshold. First hit remains a
  5-minute block; exact tier semantics stay owned by cyber-check's response.
- Guard coverage for the managed raw endpoints no longer depends on any system
  setting: compaction and count_tokens requests always run a pipeline containing
  `policyBlock` and `cyberScopeBlock`.
- A cross-process integration proof exercises the full chain twice: report →
  ledger → first-hit temporary → second report → indefinite → containment response
  → CCH Redis write with correct permanence → guard rejection path.
- All existing gates pass in both repos; production rollout follows the
  established ladder with its verification signals green.

### Stop conditions

Re-align before implementation if: the deployed containment response already
carries installation-level threshold state (field may exist unused), if the
raw-pipeline selection is load-bearing for an in-flight upstream feature, or if
production drift is found between system settings and the assumed defaults.
Stop before rollout if the 24h memory window on lineage-unify shows a regression
unrelated to but conflated with this change.

## Operating Model

- Enforcement split (unchanged): cyber-check is the strike/restriction authority
  (SQLite ledger, epochs, reset watermarks); CCH's Redis execution index is the
  enforcement point consulted by the guard pipeline; the reporting CCH always
  stamps provider events `enforce` (upstream fact, independent of reviewer modes).
- Tier semantics (Human-ruled 2026-09-03): installation first hit = 5 minutes,
  second hit within the 30-day window = permanent until admin reset. Session:
  24h per hit. Principal: 2 strikes = permanent + user disable. bio_policy:
  first hit = all scopes permanent immediately (strict bio, unchanged).
- Endpoint model: remote compaction v2 arrives on wire `/v1/responses` with
  `input:[{type:"compaction_trigger"}]` and is remapped to managed endpoint
  `/v1/responses/compact`; observe eligibility is decided by the wire path, so
  compaction is already observed. Guard pipeline selection follows the managed
  endpoint.
- Predictive side stays observational: observe mode, reviewer not invoked,
  precheck for triage/evidence only. No change in this work.
- Out of scope (Human-ruled): Anthropic-protocol paths (`/v1/messages` observe,
  count_tokens observe work), websocket Responses clients (zero production use,
  opt-in header only). The pipeline hardening incidentally keeps guards on
  count_tokens; that is acceptable and protocol-agnostic.
- Deferred (recorded, not in scope): automatic central↔Redis reconciliation with
  drift alarm (revisit trigger: any future unexplained execution-index divergence);
  Retry-After/expiry in block responses; un-hardcoding the local session TTL.

## Decisions and Authority

### Human-decided / locked

- Installation tiers: 5-minute first hit, permanent second hit.
- Codex-only scope; Anthropic-protocol observe work excluded.
- alpha search: block-only, no observe (no generation ⇒ policy strikes cannot
  originate there; revisit if alpha becomes generation-capable).
- Local precheck/reviewer never enforce (status quo preserved).

### Agent-delegated (after approval)

- Exact response field shape in the containment contract (e.g. a boolean
  `client_instance_restricted_indefinite` vs strikes+threshold pair) and its
  parsing/naming on the CCH side.
- How the raw-preset pipeline selection is made unconditional (always
  RAW_SAFE_SESSION for the raw preset vs adding guards to the naked pipeline),
  provided no setting can remove the guards.
- Test organization, local integration harness details, docs alignment.

### Provisional

- Local cross-process integration as the verification gate, with a production
  synthetic drill as an optional separately-authorized step (production mutation
  with a synthetic principal; would also serve as the strike chain's first
  live proof).

## Current system and required changes

- cyber-check: extend the provider-event containment response with the
  installation's own restriction permanence (derivation already exists in the
  restrictions table/state machine; this is a surface addition). Additive and
  backward compatible with the deployed CCH.
- CCH `guard-pipeline.ts`: add `cyberScopeBlock` to `ALPHA_SEARCH_PIPELINE`
  (messageContext already runs there, the existing step works unmodified).
- CCH pipeline selection: make the raw-preset guards setting-independent.
- CCH `provider-event.ts`: permanence condition for `blockCyberInstallation`
  switches from `principal_strikes >= 2` to the installation's own state
  (bio_policy stays unconditionally permanent).

Blast radius: one response field (additive), one pipeline list entry, one
selection branch, one condition. No schema migration on either side. No behavior
change for unrestricted traffic.

## Meaningful alternatives

- **Central-authority enforcement (cyber-check denies at admission):** rejected
  for now — puts cyber-check on the request critical path, reverses the
  non-blocking-observation direction, and requires CCH enforce-mode handling of
  restriction denials; the dual-ledger design is working and was just hardened.
- **Full observe for alpha/count_tokens:** rejected — no generation, strikes
  cannot originate there; cost without signal.
- **Auto-reconciliation now:** deferred — valuable after any real drift incident,
  not required to close the Human's stated gap.

## Verification strategy

- cyber-check: contract tests for the extended response; fmt/clippy(-D
  warnings)/full test suite.
- CCH: unit tests for pipeline composition (alpha pipeline contains the scope
  guard; raw preset selection ignores the setting) and permanence conditions;
  focused + existing suites; tsgo; scoped Biome; production build.
- Cross-process: real cyber-check process + real CCH containment client proving
  the two-hit → indefinite → response → Redis-write sequence.
- Production rollout (Human go required): established ladder — bundle, isolated
  host build, canary private acceptance, A, verification signal, B. Post-deploy
  signals: eresp stable, no-iid flow unchanged, blocked-principal behavior on
  alpha assertable via a controlled key.

## Sequencing

1. Approval of this Plan.
2. cyber-check response field + tests (deployable independently, additive).
3. CCH changes + tests.
4. Cross-process integration proof; Goal-state review.
5. Human go → rollout (cyber-check first, then CCH) with ladder verifications.
6. Optional Human-gated production synthetic drill of the strike chain.
7. Review, handoff, plan promotion to repo guidance where durable.

## Human attention

Approve this Plan (or adjust locked items). At rollout time, the separate go per
the established pipeline. Optionally authorize the production synthetic drill.

## Implementation record (2026-09-03)

Commits: cyber-check `ded58a0` (containment response field + derivation +
contract assertions), CCH `f67cf388` (this branch, includes the Plan).

Evidence:

- cyber-check: fmt, clippy --all-targets --all-features -D warnings, full
  test suite green (139 tests); contract tests now assert first-hit
  temporary, same-installation second-hit indefinite, cross-installation
  principal escalation with the installation itself still temporary, and
  bio permanence.
- CCH: 1766 focused tests green, tsgo clean, scoped Biome clean,
  production build passes. Guard tests prove alpha-scope rejection and
  unconditional raw-preset guards; provider-event tests prove the
  permanence condition (first hit temporary at principal threshold,
  indefinite when the service says so); client tests prove strict parsing
  with an absent-field false default and non-boolean rejection.
- Cross-process: `tests/integration/cyber-check-service.test.ts` run live
  against a real service process (review+enforce, zero sampling, benign
  reviewer stub) — 3/3 green including the new same-installation
  second-hit indefinite assertion after principal reinstatement.

Deviations from the Plan: none material. Notes: the alpha scope guard
fires after provider selection and billing context, matching the CHAT
pipeline's established ordering (session-level blocks still stop earlier).
The live integration harness now requires an `instructions` field in its
packets (complete coverage posture) and a reachable reviewer endpoint
(any provider event puts the principal in strict posture).

Next checkpoint: Human review, then the established rollout ladder
(cyber-check first — the response field is additive and old CCH parsers
ignore it; then CCH), with the same verification signals as the 09-03
hotfix.
