# CCH Dashboard Slowness Elimination (backfill / cache stampede / observability)

Status: Approved (Human, 2026-08-20: A+B first, canary + rolling rollout;
Phase C pg_stat_statements deferred until A+B verified live). Phases A+B
implemented same day: commits 211fcf0a (backfill sync/repair split) and
ba7e5d7d (composite cache + SWR) on codex/compaction-v2. Gates: tsgo clean,
biome clean on changed files, targeted suites 680 passed, full suite 7245/7249
(3 known pre-existing/env failures + 1 flaky, none in changed surfaces),
next build + standalone chain passed. Deployment rides the established canary
ladder after the 4ec57fe2 parse-chain rollout completes (tracked separately).

## Goal

### Target

Eliminate the recurring "everything slow" classes on production CCH, in dependency
order:

- A. Startup ledger backfill no longer runs a full-table per-row plpgsql
  convergence scan on every boot; startup tax drops to a sub-second indexed
  anti-join. Semantic re-derivation becomes an explicit, deliberately-run repair
  script instead of an unconditional boot step.
- B. The big-screen composite (`getDashboardRealtimeData`) is served from a Redis
  composite cache (15s TTL + `:last` SWR) instead of 3 uncached leaderboard
  aggregations per 2s poll. The degenerate "wait 5s then direct-query" fallback in
  leaderboard/overview/statistics caches is replaced by the availability-cache
  stale-while-revalidate pattern (serve `:last` immediately, refresh under lock).
- C. `pg_stat_statements` enabled on the primary Postgres for evidence-based
  follow-ups (index usage, slow query baseline).
- D. Deferred with explicit revisit triggers: usage_ledger index trim (needs C's
  usage data), per-user lifetime totals table (only if allTime leaderboard still
  hurts in healthy state), general rollup framework (rejected at current scale:
  8.4k daily / 1.5M monthly / 4.7M all-time rows, 520 users, 185 models).

Context established 2026-08-20 (see cops note
`2026-08-20-hostdzire-cch-parse-chain-rollout-plan.md` session and dashboard
diagnosis): daily leaderboard plan is healthy (index-only scan, 2.4s only under
backfill I/O saturation); monthly ~1-3s steady; allTime plan cost 508K
(~5-20s cold, rare). usage_ledger is a trigger-maintained read-side derivation
(`trg_upsert_usage_ledger`); the backfill's semantic-repair conditions
(`IS DISTINCT FROM fn_...`) are the sole reason boot scans evaluate plpgsql per
row over 3.66M rows.

### Success conditions

- After a fresh app boot with a consistent ledger, `Ledger backfill complete`
  logs in < 5s with processed=0 and no `WITH batch` query appearing in
  pg_stat_activity beyond that window; DB I/O stays flat across app restarts.
- A deliberately-created ledger gap (delete one ledger row in a test) is picked
  up and repaired by the boot anti-join.
- Big screen open in one tab: HAProxy/DB sees at most 1 leaderboard aggregation
  per 15s window; SWR returns `:last` within milliseconds on expiry; no
  direct-query fallback log lines under lock contention.
- Cache behavior parity tests pass for leaderboard/overview/statistics (fresh,
  stale-serve, single-flight, Redis-down fail-open).
- pg_stat_statements viewable on primary; overhead invisible in app latency.

### Blocked stop conditions

- The write path is found NOT to be fully trigger-maintained (boot anti-join
  alone would miss legitimate repairs) — replan the split before shipping A.
- SWR semantics conflict with an existing UI assumption of strict freshness
  (none known; big screen already tolerates 600s-cached panels).

## Operating Model

- Production shape: A/B app containers + canary slot behind HAProxy; primary
  PG 18.4 (container `cch-docker-postgres-standby`, 2.5GiB limit, launched via
  `-c` flags in compose cmd, `shared_preload_libraries` empty,
  `compute_query_id=auto`, max_connections=100) + pgbouncer + racknerd standby.
- Data: usage_ledger 10GB/4.7M rows (16 indexes, 5.9GB); message_request
  20GB/4.66M rows; ~72k ledger rows/day; 520 users.
- Scale of change: pure CCH code (Phase A/B) rides the established canary
  ladder; Phase C is a host-side PG restart in a low-traffic window.

## Scope and authority

- Agent-delegated: SQL shapes, cache key naming, test placement, exact SWR
  mechanics mirroring availability-cache, script interfaces.
- Human-decided: Phase C restart window; sequencing relative to other releases;
  acceptance of deferred-item triggers.
- Locked: no rollup framework this cycle; no index drops without usage evidence;
  startup backfill keeps advisory lock + idempotency.

## Proposed approach

### Phase A — backfill rework (`src/lib/ledger-backfill/`)

1. Boot path: keep advisory lock + batch loop, but the WHERE becomes a pure
   missing-row anti-join (`NOT EXISTS (SELECT 1 FROM usage_ledger ul WHERE
   ul.request_id = mr.id)` + existing endpoint/warmup filters). No LATERAL
   resolve, no fn_compute, no IS DISTINCT FROM. Add a wall-clock cap (e.g. 60s)
   that logs and exits — belt against pathological cases.
2. Move semantic re-derivation to an explicit repair entrypoint, e.g.
   `backfillUsageLedger({ mode: "repair" })` or a standalone script under
   scripts/, invocable on demand (documented: run when derivation semantics
   change). Not wired to boot.
3. Optional cheap drift alarm: scheduled count comparison ledger vs
   message_request (only if trivial to add; otherwise skip — the anti-join is
   itself the drift detector for missing rows).
4. Tests: fixture-based integration test (consistent ledger → fast zero; forced
   gap → repaired; repair-mode still re-derives outcome columns).

### Phase B — cache unification (`src/lib/redis/`, `src/actions/dashboard-realtime.ts`)

1. Composite cache for `getDashboardRealtimeData`: single Redis key
   (`dashboard-realtime:v1`), TTL 15s, `:last` copy with long TTL (10 min),
   NX single-flight lock, fail-open to direct compute on Redis errors. The
   action returns the cached composite; per-source Promise.allSettled stays
   inside the compute path.
2. Replace the 5s-wait-then-direct fallback in leaderboard/overview/statistics
   caches with the availability-cache SWR shape: on miss, if `:last` exists
   serve it immediately and refresh in background under the existing NX lock;
   waiters poll for the fresh key with a generous bound (>= lock TTL / 2), never
   fan out direct queries. Redis-down fallback to direct query stays (correct).
3. Tests: extend tests/unit/redis/* for stale-serve and single-flight; new test
   for the composite cache.

### Phase C — pg_stat_statements (ops, cops side)

1. Edit `/home/sub2api/cch/migration/docker-postgres-standby/compose.yml` cmd to
   append `-c shared_preload_libraries=pg_stat_statements -c
   pg_stat_statements.max=10000` (track stays default `top`; do NOT enable
   track_planning). Snapshot compose first (rollback dir convention).
2. Low-traffic window (user-picked): `docker compose up -d` (recreate) — brief
   DB outage (~10-30s); apps reconnect via pgbouncer; racknerd standby slot
   reconnects automatically. In-flight streams error once; accept or drain first.
3. `CREATE EXTENSION pg_stat_statements;` on primary (DDL replicates).
4. Verify: view shows entries; restart counts; note in cops host doc.

### Rollout

- Phase A+B as one CCH release on top of the completed 4ec57fe2 parse-chain
  rollout; standard canary ladder (the boot of the new canary itself
  demonstrates the backfill fix live: startup log fast-complete, flat I/O).
- Phase C independent, any low-traffic window; keep until after A+B deploys so
  the new code's query profile is what gets observed.

## pg_stat_statements cost assessment (for the record)

- Enabler cost: it is a preload extension — enabling requires a Postgres
  instance restart. That is the only real cost: ~10-30s DB unavailability;
  in-flight requests fail once; pgbouncer reconnects; standby replication slot
  resumes automatically. Reversible (drop the flags + restart, or leave on).
- Memory: bounded by `pg_stat_statements.max` entries (we set 10000);
  low-single-digit MB of shared memory against the 2.5GiB container limit.
- CPU: per-query normalized-fingerprint counters, sub-microsecond; at our
  ~tens of ops/s load the overhead is unmeasurable. `track_planning=on` is the
  mode that can add real overhead — we leave it off.
- Semantics: stats are in-memory (survive clean shutdown dump only), reset on
  crash restart, resettable manually — fine for diagnosis. Query texts are
  literal-normalized ($1/$2): no data leakage into stats.
- No application changes; reading requires superuser/pg_read_all_stats.

## Deferred items (revisit triggers)

- Index trim on usage_ledger (16 indexes, 5.9GB): after >= 1 week of
  pg_stat_statements + pg_stat_user_indexes idx_scan data, propose drops for
  overlapping entries (key_created_at vs key_created_at_desc_cover vs key_cost
  family). Trigger: evidence collected.
- Per-user lifetime totals table (~20 lines, trigger-path UPSERT): only if
  allTime leaderboard is still complained about in healthy steady state.
  Trigger: post-A/B user report.
- General rollup framework: rejected at current scale; re-evaluate if monthly
  leaderboard > 5s steady or row volume grows > ~10x.

## Current state

- Investigation complete; this plan drafted 2026-08-20 after the 4ec57fe2
  canary went live (its Phase 3/4 tracked separately).
- Next: Human approval, then implement Phase A+B while 4ec57fe2 rollout
  completes; Phase C window scheduled with Human.
