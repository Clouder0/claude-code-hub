# Upstream v0.8.10 Integration Plan

## Baseline and safety

- Base the integration on `origin/dev@595a7d98` (`v0.8.10`).
- Preserve the original dirty `hotfix/v0.8.2-self-userfix` worktree unchanged.
- Treat the three local self-user commits as already upstreamed; do not cherry-pick them.
- Adapt local behavior by feature. Do not overlay old whole files on the new upstream architecture.

## Product decisions

- A read-only key can access only `/my-usage` and `/api/v1/me/*`, scoped to the current key.
- A normal Web user can manage all keys owned by their user and inspect their own requests and
  sessions across those keys.
- A normal Web user can view only the global per-user cost/usage leaderboard, independent of the
  legacy `allowGlobalUsageView` switch. Provider, model, cache-hit, and per-user drill-down views
  remain admin-only.
- `ENABLE_API_KEY_ADMIN_ACCESS=false` downgrades an admin user's database key to normal Web
  self-scope, including sessions created by logging in with that key.
- Unknown request content encodings and encoded multipart bodies fail closed with HTTP 415.
- Deployment images stay on Node 26 while preserving the upstream `node >=22.15.0` engine floor.
- Discard the local root-layout-wide force-dynamic/no-store change; retain targeted dynamic
  rendering only on authenticated routes.

## Implementation slices

1. Auth/session foundation
   - Port the `web` auth tier, effective `adminAuthority`, opaque session provenance, CSRF context,
     and legacy action-adapter propagation onto the v0.8.10 code.
   - Make header and cookie behavior agree when database-key admin access is disabled.
2. Self-service and data isolation
   - Keep upstream `/users:self/keys` session targeting and machine-readable errors.
   - Permit Web users to list/reveal/edit/enable/renew/delete only their own keys.
   - Keep last-active-key protection and provider-group authorization.
   - Restrict dashboard logs/sessions to Web users and enforce user ownership in actions.
   - Keep read-only `/me` operations scoped to the current key.
3. Leaderboard policy
   - Let normal Web users access only the per-user aggregate cost/usage ranking, independent of the
     legacy `allowGlobalUsageView` switch.
   - Keep all other scopes, filters, and user drill-downs admin-only.
4. Proxy and persistence hardening
   - Adopt upstream request-body codecs and proxy lifecycle changes.
   - Add the local JSONB sanitizer to insert, sync update, buffered update, winner cost, and hedge
     loser JSONB paths, preserving valid Unicode surrogate pairs.
   - Isolate poison writes so one malformed record cannot drop a batch.
5. Remaining local behavior
   - Port Redis cold-start waiting, non-default provider-group self-key behavior, normal-user system
     settings projection, Playwright self-service coverage, and Node 26 Docker pins.
   - Do not port the local usage-summary dual read. Verify production ledger consistency before
     deployment and repair the ledger if discrepancies exist.

## Deferred follow-up and release preflight

- Keep the existing upstream session-ID namespace behavior in this integration. Cross-user
  session-ID collision hardening is deliberately deferred to a separate, schema-aware change.
- Before deployment, run a read-only production audit for any `session_id` associated with more
  than one user. Stop the release and resolve collisions before rollout if the audit finds any.
- Verify production usage-ledger consistency before deployment because the old local dual-read
  fallback is intentionally not carried forward.
- Do not connect to, migrate, or otherwise mutate the production database during this integration
  work. Database migration decisions belong to the later deployment runbook.

## Acceptance criteria

- Anonymous callers cannot reach protected management data.
- Read-only keys cannot enter the dashboard, reveal/manage keys, see user-wide logs/sessions, or
  view the leaderboard.
- Normal Web users can manage only their own keys, see only their own requests/sessions, and view
  only the per-user aggregate leaderboard.
- A database key belonging to an admin has no cross-user authority when
  `ENABLE_API_KEY_ADMIN_ACCESS=false`, including after Web login.
- Effective admins retain full management access.
- Binary/encoded request bodies and all message-request JSONB write paths cannot poison logging or
  buffered persistence.
- Upstream v0.8.10 pricing, provider, public-status, usage-export, proxy lifecycle, dependencies,
  and migrations remain intact.
- Focused regression tests, migration validation, generated OpenAPI checks, full Vitest, Biome,
  TypeScript, and production build all succeed after the final edit.
