# CCH lineage unification: perf line x cyber containment v3

Status: Merged and fully gated on `codex/lineage-unify` (74bc61a1) on 2026-09-03; production deployment pending separate authority.

## Incident being repaired

Two production lineages diverged at `5d0ec232` (2026-08-21) and were never merged:

- Lineage A (perf): `perf-bundle-a` → `db-write-churn` → `agg-read-a` → `codex/is-billable` (92ae922b) → `cyber-observe-prod-92ae` (a9a8a0d0, already a merge with compaction-v2@3567a05d). 31 commits of streaming hot-path, memory-release, bounded-aggregation, and stored-`is_billable` work. **a9a8a0d0 was deployed to production A/B on 2026-09-01/02** (see cops `cyber-check-observe-canary.md`).
- Lineage B (cyber): `codex/compaction-v2` accumulated the cyber-check/observe/containment line, then 2026-09-02's heartbeat/524/overload work (68921e82, a7dffb9f, 603b61ed, c62bba36, 45b58904) was developed on it and rolled out to A/B/canary as image `45b58904-overload503` — **silently reverting the 31 perf commits from production**.

Consequences observed before the cause was found: usage-logs/dashboard unbounded aggregation over 4.14M rows, TTFB-path DB/Redis round trips back, slow billing finalize, and evening OOM storms.

Separate root cause for the OOM storms (fix committed on `codex/cyber-containment-v3` as 64d9c02b before the merge): `STREAM_GATE_MODE=off` (deployed 2026-09-02) produces no stream-gate commit marker, so `releaseRequestBodyAfterCommit` never fired and each streaming request retained its parsed tree plus serialized body (2-4.5MB median) until finalization. The release condition now keys on the Forwarder's final-success boundary (canonical `/v1/responses` SSE from a codex provider in high-concurrency mode), which gate-off legacy pass and the precommit heartbeat also establish.

## Merge shape

- Base: `codex/cyber-containment-v3` = `45b58904` + containment v3 (aa3fe5ca) + the release fix (64d9c02b).
- Merged in: `a9a8a0d0`, reusing its already-resolved perf x cyber conflicts (merge-base 3567a05d).
- Result contains: all 31 perf-line commits, the full cyber line through containment v3, and 2026-09-02's heartbeat/overload/hedge-losers/fake-200 fixes.
- Twin commits `8eeaf1ae` (A) / `47c56b94` (B) carry the same alpha-search-timeout fix; content-identical, merged to a single copy (verified by marker grep).

## Conflict resolutions

1. `src/app/v1/_lib/proxy/streaming-response-gate.ts` — the `pass` inspection variant gained one optional diagnostic on each side; both kept (`precommitHeartbeat` from the heartbeat line, `commitDiagnostic` from `61b8b0ca` gate-commit sampling).
2. `drizzle/meta/_journal.json` — both sides claimed idx 115. Sequenced as `0115_guard_usage_ledger_trigger` (applied on prod), `0116_usage_ledger_is_billable` (column live on prod since the is-billable deploy; journal row backfilled per the migration header's own note), and containment-v3's security_event columns renumbered to `0117_happy_iron_monger` (file `drizzle/0115_happy_iron_monger.sql` and its snapshot renamed; **not yet applied on prod**).

## Verified production-DB compatibility (2026-09-03, cch-docker-postgres / claude_code_hub)

- `usage_ledger.is_billable` exists and is trigger-maintained: 0/192123 NULL over 36h (rows written while compaction-v2 code ran are still maintained — the DB trigger computes the flag independent of app code). No backfill needed at redeploy.
- `message_request` carries `trg_upsert_usage_ledger` + `trg_upsert_usage_ledger_on_update` (the split guarded pair from 0115) — prod never runs AUTO_MIGRATE; ops applies migrations manually. Ledger writes flow (192k rows/36h).
- Index sets are compatible: 2026-09-02's dead-index cleanup dropped only 4-week-zero-scan indexes, and its restoration of `idx_usage_ledger_provider_created_at` serves the is-billable fallback path.

## Gates (2026-09-03, workstation)

- Targeted: heartbeat (11), request-body release boundary (3 files), gate commit observation, stream accumulator release — 52/52.
- `tsgo -p tsconfig.json --noEmit` — clean.
- Full `vitest run` — 7491 passed, 14 skipped; single failure was `openapi-types-drift` spawning `bun` outside PATH, passes 2/2 with `~/.bun/bin` on PATH (generated types exactly in sync with the merged API surface).
- `npm run build` — production build (see execution record below).

## Deployment sequence (requires separate authority)

Order matters: containment v3's CCH state parser needs the additive cyber-check source fields.

1. greencloud: deploy cyber-check containment-v3 (`codex/cyber-containment-v3` @ 72125ea in ~/GitRepos/cyber-check, incl. its migration) per the existing rehearsal/cutover playbook pattern.
2. hostdzire: apply `drizzle/0117_happy_iron_monger.sql` to claude_code_hub (additive security_event columns + legacy bio backfill UPDATE).
3. Build the lineage-unify artifact through the established pipeline (next build → zstd-6 → scp → host build, tag `74bc61a1-lineage-unify` or successor), canary at weight 5, watch FAKE_200/heartbeat/memory, then A/B.
4. Fast-path alternative (cyber-check V10 compatible, no 0117): deploy a9a8a0d0 + cherry-picks of the 09-02 five fixes to restore the perf line first; keeps containment v3 for later.

After deploy: heap-stopgap settings (A 1536 / B 640+1792) can likely be relaxed once the release-boundary fix is live; verify with the Full GC CPU comparison already scheduled.

## Process fix (carried to cops backlog)

Deploy images must carry a `git describe` tag, and every rollout must diff the running image's commit against the target branch before cutover, so a lineage revert cannot pass silently again.
