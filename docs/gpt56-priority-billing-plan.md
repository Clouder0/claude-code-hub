# GPT-5.6 Standard and Priority Billing Plan

## Scope

- Support GPT-5.6 Standard and Priority billing for OpenAI-compatible and private Codex response
  usage.
- Treat upstream `input_tokens` as the observed total input and split it into mutually exclusive
  ordinary-input, cache-read, and cache-write buckets.
- Preserve the existing Anthropic 5-minute and 1-hour cache buckets; represent OpenAI cache writes
  as a generic/default cache-write remainder.
- Persist enough provenance and unit-rate data to explain a charge after request-log cleanup.
- Do not implement Flex, Batch, regional uplift, cache affinity/session binding, breakpoint
  injection, historical repricing, or cache leaderboards.

## Pricing contract

All prices below are USD per one million tokens, ordered as input / cache read / cache write /
output.

| Model | Standard at or below 272K | Standard above 272K | Priority at or below 272K |
| --- | --- | --- | --- |
| GPT-5.6 / Sol | 5 / 0.5 / 6.25 / 30 | 10 / 1 / 12.5 / 45 | 10 / 1 / 12.5 / 60 |
| GPT-5.6 Terra | 2.5 / 0.25 / 3.125 / 15 | 5 / 0.5 / 6.25 / 22.5 | 5 / 0.5 / 6.25 / 30 |
| GPT-5.6 Luna | 1 / 0.1 / 1.25 / 6 | 2 / 0.2 / 2.5 / 9 | 2 / 0.2 / 2.5 / 12 |

- The long-context threshold is strict: 272,000 stays in the short tier; 272,001 switches the full
  request to long-context pricing.
- Long-context input, cache read, and cache write cost 2x; output costs 1.5x.
- OpenAI currently documents Priority processing as not supporting long context. Do not synthesize
  a Priority-plus-long-context price.
- For public OpenAI-compatible traffic, an actual response `service_tier` overrides the requested
  tier; a missing actual tier may fall back to the request. Private Codex traffic retains the
  existing configured requested/actual policy.
- Requested Priority that is actually returned as Standard uses Standard pricing. If an upstream
  unexpectedly reports actual Priority above 272K, preserve the response, mark settlement as an
  unsupported pricing combination, and alert rather than guessing a price.

Official sources:

- https://developers.openai.com/api/docs/pricing
- https://developers.openai.com/api/docs/guides/prompt-caching
- https://developers.openai.com/api/docs/guides/priority-processing

## Usage accounting contract

```text
observedInput = max(input_tokens, 0)
cacheRead = clamp(cached_tokens, 0, observedInput)
remaining = observedInput - cacheRead

if reported cache_write_tokens > 0:
  cacheWrite = clamp(reportedWrite, 0, remaining)
  source = reported_positive
else if inference is eligible:
  cacheWrite = remaining
  source = inferred_input_minus_cache_read_v1
else:
  cacheWrite = 0
  source = none

ordinaryInput = observedInput - cacheRead - cacheWrite
```

Inference is eligible only when all of these are true:

- the settled model is GPT-5.6, Sol, Terra, Luna, or a supported alias;
- the provider uses OpenAI subset usage semantics;
- the selected price has an explicit cache-write rate;
- `observedInput >= 1024`;
- `cached_tokens` is explicitly present, including an explicit zero;
- the request is not explicit-cache mode without any cache breakpoint.

The invariant `ordinaryInput + cacheRead + cacheWrite = observedInput` must hold after clamping.
Missing and explicitly zero reported writes can both infer, but their raw observations remain
distinguishable for audit.

## Implementation slices

1. Terminal usage observation and allocation
   - Parse nested Responses and Chat cache-write fields.
   - Make Responses `response.completed.response.usage` authoritative and Chat usage last-wins.
   - Introduce a pure allocation module and use its settled result throughout the proxy lifecycle.
2. Atomic price resolution
   - Add the Priority cache-write price field and CPT conversion support.
   - Add a versioned, exact OpenAI GPT-5.6 Priority supplement while the live CPT lacks the track.
   - Resolve all four rates atomically; GPT-5.6 Priority must never mix Standard fallback buckets.
   - Derive the generic cache-write amount from aggregate minus 5m/1h details.
3. Durable audit persistence
   - Add observed input, reported write, accounting source, and cost/pricing provenance to
     `message_request` and `usage_ledger` through a generated Drizzle migration.
   - Update trigger, backfill, synchronous and buffered writes, client-abort drain, and hedge-loser
     billing. Historical rows remain null and historical costs are not recalculated.
4. Read surfaces
   - Show observed/reported/effective usage, inference source, effective service tier, long-context
     tier, and actual unit rates in request details and CSV/XLSX exports.
   - Add all user-facing labels to zh-CN, zh-TW, en, ja, and ru catalogs.

## Production-review hardening

- Resolve the cache-write inference gate from the same effective Standard/long/Priority four-rate
  tier used for settlement; GPT-5.6 rates must be finite and strictly positive.
- Resolve model, requested service tier, and explicit-cache controls from the final serialized
  upstream request after provider overrides and final request filters. Every streaming hedge
  attempt, including the initial provider, uses an isolated session; only the winner is synchronized
  back to the tracking session, so losers retain the exact request they sent without a large deep
  snapshot.
- Settle the authoritative request row, including cost, provider attribution, usage, multipliers,
  provider chain, and pricing audit, in one durable database update before publishing any related
  Redis rate-limit event, active-session snapshot, or Langfuse trace. This ordering applies to
  ordinary winners, hedge winners, and each hedge loser. A failed durable write is a failed
  settlement and must not publish billable side effects.
- Track every hedge winner/loser with a stable billing-event ID so equal-cost events from the same
  request remain distinct in rolling windows while retries of one event remain idempotent.
- Use the original request session for shadow-loser Redis identity, but the losing provider's own
  pricing and multipliers for its charge.
- Publish the authoritative loser-inclusive request total to active-session cost with a
  request-sequence guard. Update the whole sequenced usage snapshot atomically so a late request
  cannot combine its tokens/status with a newer request's cost.
- When an idempotent loser retry finds its write already applied, read back the authoritative DB
  total so an ambiguous commit still propagates the loser-inclusive amount to active-session state.
- Preserve unsupported winner and loser price-book provenance, including official supplement and
  conflict metadata, and render/export them as unsettled rather than successful zero-dollar costs.
  Unsupported winners use a retried direct database write even when ordinary details are buffered;
  the write leaves `cost_usd` untouched so no unresolved combination becomes a ledger charge.

## Provider billing-event contract

Provider quotas, alerts, statistics, provider leaderboards, and provider-filtered user insights use
one ledger-derived event stream:

```text
settledLosers = first valid settled record for each (requestId, providerId, attemptNumber)
winnerCost = max(requestTotalCost - sum(settledLosers.cost), 0)
winnerEventId = "<requestId>:winner"
loserEventId = "<requestId>:hedge-loser:<providerId>:<attemptNumber>"
```

- A missing legacy `billingStatus` means `settled`; any explicit non-settled status is excluded.
- Legacy numeric-string provider and attempt IDs are accepted consistently by both filtered and
  unfiltered queries.
- Non-array JSON, non-object entries, invalid or out-of-range IDs/tokens, invalid costs, and negative
  costs are ignored without failing the containing query.
- All time windows are half-open `[start, end)`, and every event inherits the request timestamp.
- Winner events retain the winning request's usage. Loser events carry the separately measured
  loser usage. This represents actual upstream work rather than redistributing winner tokens.
- The total request charge stays authoritative. If settled loser cost exceeds it, winner cost is
  clamped to zero and the row is a data-consistency anomaly to investigate; loser facts are not
  silently rewritten.
- Cache leaderboards intentionally retain their existing request-level semantics and are outside
  this change.
- Usage-log provider filters also remain request-level: they select rows whose final/winning
  provider matches, so list pagination, summary, and exports describe the same requests. They are
  not a provider-spend report and must not be used for quotas or provider cost reconciliation.

Production-copy profiling showed that combining winner and loser predicates with one `OR` forced a
parallel scan over 2.1 million ledger rows: the busiest provider's all-time total took about 1.12s.
Adding a GIN index alone did not change that plan. Provider total queries therefore use three
independent sources: an index-only winner aggregate, sparse winner rows that actually contain
losers, and provider-specific loser rows. The latter two are backed by:

- `idx_usage_ledger_hedge_losers_gin` using `jsonb_path_ops`;
- `idx_usage_ledger_winner_hedge_losers` on `(final_provider_id, created_at)` with a partial
  `blocked_by IS NULL AND hedge_losers IS NOT NULL` predicate.

After targeted `ANALYZE`, the same production-copy total ran in about 206ms with no sequential
scan, JIT, or temporary-file spill. The post-migration analyze is part of green readiness, not an
optional maintenance task.

## Migration and history boundary

- A normal 0.8.2 production database at migration 0103 advances through 0104-0110. The 0109 and
  0110 billing-audit columns are nullable and do not reprice existing rows.
- The resolver selects the last valid `hedge_winner`, `request_success`, or `retry_success` provider
  from the chain. With no valid success node it falls back to `message_request.provider_id`.
- Backfill may repair `usage_ledger.final_provider_id` from a retained request log, but it must not
  overwrite an existing ledger `cost_usd` or retroactively apply GPT-5.6 pricing.
- A ledger-only row whose `message_request` was already deleted has no provider chain to replay.
  Its historical provider attribution remains unchanged because guessing would corrupt the ledger.
- Before production rollout, verify the current migration watermark, check for manually added
  conflicting columns, take a database backup, migrate a production copy, compare historical
  `cost_usd` sums byte-for-byte, and wait for the provider-attribution mismatch query to reach zero.
- Zero-downtime production deployment is intentionally two-stage. First use the already-verified
  `42663dd5` candidate only as a migrator to advance 0103 through 0110. Then create the two indexes
  above with `CREATE INDEX CONCURRENTLY`, using their final names and definitions, and run targeted
  `ANALYZE`. Only after those online operations pass should the new application candidate apply
  0111-0112. Those migrations first inspect the catalog: a missing index is created for fresh
  installations, while a pre-created index must be ready, valid, and match the exact access method,
  columns, operator class, and predicate. The production path therefore performs catalog validation
  only and advances the Drizzle watermark; an invalid or conflicting same-name index fails closed.
  The ordinary index-build branch is allowed only when `usage_ledger` is empty. A missing index on
  a non-empty ledger fails immediately and instructs the operator to pre-create it concurrently.
  Running the new candidate directly from a populated 0103 production database is therefore both
  prohibited by the runbook and rejected by the migration itself.

## Redis rollout transition

Existing rolling-window ZSET members use the legacy request-ID identity. They are not rewritten by
the application upgrade and can collapse equal-cost winner/loser events. Deleting the shared keys
before cutover is unsafe: blue remains available for existing SSE/WebSocket connections and can
recreate legacy members after the deletion. Green therefore never reads or writes those keys.

The new application uses a `v2` namespace for every rolling cost ZSET:

```text
key:*:cost_5h_rolling:v2
provider:*:cost_5h_rolling:v2
user:*:cost_5h_rolling:v2
key:*:cost_daily_rolling:v2
provider:*:cost_daily_rolling:v2
user:*:cost_daily_rolling:v2
```

Rolling key/user leases and every provider lease also end in `:v2`. Provider total snapshots use
`total_cost:provider:<id>:v2:<reset-at-or-none>`. Blue continues to use v1; green cold-builds v2 from
the corrected ledger; the generations cannot overwrite one another. The unused v1 rolling ZSETs
expire naturally after at most about 25 hours, so no pre-cutover Redis deletion is required.

Fixed 5-hour, fixed daily, weekly, and monthly cost counters deliberately retain their existing
names and must never be deleted during this release. They cannot be reconstructed with their
original window start, and clearing them would reset active limits. Provider fixed-window counters
therefore retain their pre-upgrade attribution until their natural reset; this bounded transition is
preferred to silently under-enforcing a live limit. Leaderboard caches may expire under their short
TTL.

Rollback is generation-aware. Hot-switch new connections back to blue, then delete only the v1
rolling ZSET/rolling-lease/provider-lease/provider-total families before relying on blue limits, so
blue rebuilds from the authoritative ledger instead of reusing a stale pre-cutover snapshot. Never
delete a fixed-window cost counter. Green and its v2 keys remain intact while it drains.

## Replay boundary

- The forwarder starts loser finalization once per hedge attempt in the current in-process
  lifecycle. Stable billing-event IDs additionally make rolling 5-hour/daily ZSET writes
  idempotent.
- Fixed-window counters and lease decrements are not yet independently idempotent across a future
  durable/cross-process replay. Do not add replay of completed hedge finalizers until each
  `(billingEventId, entity, window)` side effect has its own atomic deduplication contract.

## Zero-downtime production runbook

This runbook intentionally leaves the current app running after cutover. Stopping it is a separate
maintenance task: the server has a bounded shutdown watchdog, so sending `SIGTERM` while an SSE or
WebSocket is still open would violate the strict zero-downtime requirement.

### Immutable inputs and stop conditions

Record the following before the approval gate:

```text
BLUE_CONTAINER=claude-code-hub-app
DB_CONTAINER=claude-code-hub-db
REDIS_CONTAINER=claude-code-hub-redis
CLOUDFLARED_CONTAINER=claude-code-hub-cloudflared
MIGRATOR_IMAGE_ID=d036c689ddf017192772e8d5bd96a7a7ee0ba976c837ec319b501a5b449f54a3
GREEN_IMAGE_ID=<final-verified-image-id>
GREEN_CONTAINER=claude-code-hub-green-<release-sha>
GREEN_ORIGIN=app-green-<release-sha>:3000
```

Stop immediately if health is non-200, any shared container changes identity or restart count,
there is an ungranted database lock, a target index is invalid/not-ready, historical cost hashes
change, green restarts, or a HTTP/SSE/WebSocket canary fails. Never restart app, DB, Redis, or
cloudflared to recover a failed step. No command below is authorized for production until the final
rehearsal report has been explicitly approved. Freeze administrative edits to 5-hour reset modes
from preflight until the tunnel cutover is verified, so the old app cannot run its legacy broad
cache cleanup during the overlap.

### 1. Read-only preflight

1. Capture container IDs, image IDs, `StartedAt`, `RestartCount`, health, network aliases, and the
   current cloudflared configuration version.
2. Confirm `/api/v1/health` and the external health endpoint are 200 and report the blue version.
3. Confirm PostgreSQL has 104 migrations through 0103, zero ungranted locks, zero lock waiters, and
   no old transaction.
4. Capture `message_request` and `usage_ledger` row counts, numeric totals, and ordered-COPY SHA-256
   fingerprints. Capture the exact two target index definitions if either name already exists.
5. Confirm Redis is ready; record counts for v1 and v2 rolling/lease/provider-total families. Do
   not delete anything.
6. Take and verify a PostgreSQL custom-format backup to a new timestamped path.

### 2. Advance 0103 to 0110 without replacing blue

Start an unrouted, uniquely named container from `MIGRATOR_IMAGE_ID` on the backend network with the
production environment, a unique unused port, and:

```text
AUTO_MIGRATE=true
PGOPTIONS=-c lock_timeout=2s -c statement_timeout=600s
```

Blue continues to serve all traffic. Wait for the migrator to report startup/migration success,
verify the database has exactly 111 migrations through 0110, then stop only the unrouted migrator.
If the lock timeout fires, the transaction must roll back to 104 migrations; investigate and retry
later rather than increasing the timeout.

Re-run row counts, totals, fingerprints, provider/success/cost mismatch checks, and the zero-lock
check before continuing. The expected ledger backfill is I/O-heavy even though the DDL lock window
is short, so monitor database latency throughout this phase.

### 3. Build indexes online and update statistics

Run each online DDL as its own `psql -c` invocation. Apply the timeouts through `PGOPTIONS`; do not
put `CREATE INDEX CONCURRENTLY` inside an explicit transaction or a multi-statement `-c` string.

```bash
podman exec \
  -e 'PGOPTIONS=-c lock_timeout=2s -c statement_timeout=600s' \
  "$DB_CONTAINER" psql -X -v ON_ERROR_STOP=1 -U postgres -d claude_code_hub \
  -c 'CREATE INDEX CONCURRENTLY idx_usage_ledger_hedge_losers_gin ON usage_ledger USING gin (hedge_losers jsonb_path_ops)'

podman exec \
  -e 'PGOPTIONS=-c lock_timeout=2s -c statement_timeout=600s' \
  "$DB_CONTAINER" psql -X -v ON_ERROR_STOP=1 -U postgres -d claude_code_hub \
  -c 'CREATE INDEX CONCURRENTLY idx_usage_ledger_winner_hedge_losers ON usage_ledger (final_provider_id, created_at) WHERE blocked_by IS NULL AND hedge_losers IS NOT NULL'

podman exec "$DB_CONTAINER" psql -X -v ON_ERROR_STOP=1 -U postgres -d claude_code_hub \
  -c 'ANALYZE usage_ledger (hedge_losers, final_provider_id, blocked_by, endpoint, cost_usd)'
```

Verify both indexes are live, ready, valid, non-unique, and exactly match their access method,
columns, opclass, and predicate. Run the compiled provider-total `EXPLAIN (ANALYZE, BUFFERS)` for a
busy provider; reject a sequential ledger scan, JIT, or temporary spill.

### 4. Start and prove green while it is unrouted

Start `GREEN_IMAGE_ID` with the production environment, `AUTO_MIGRATE=true`, a unique container
name, no `app` alias, and no published public port. Attach it to:

- `claude-code-hub-backend` for DB/Redis;
- `claude-code-hub-frontend` only as `app-green-<release-sha>`;
- `shared-net` only as `cch-green-<release-sha>`.

Green startup must advance only 0111-0112, yielding 113 migrations. Verify both index OIDs,
relfilenodes, sizes, and definitions are unchanged across startup, proving the migrations took the
catalog-validation path. Require green readiness, zero restart-count growth, clean startup logs,
unchanged cost fingerprints, and successful direct-origin HTTP, streaming SSE, WebSocket, billing,
hedge-loser, and rolling-v2 canaries.

### 5. Hot-switch only new connections

Change the remotely managed tunnel origin from `http://app:3000` to
`http://app-green-<release-sha>:3000`. Do not rename network aliases and do not restart cloudflared.
The connector's `TUNNEL_TOKEN` cannot edit configuration. From a controlled operator environment,
use a separate token with `Cloudflare Tunnel Write`, freeze concurrent dashboard edits, and preserve
the full ingress document (including topup, catch-all, and warp-routing):

```bash
umask 077
CF_CFG="https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/cfd_tunnel/${CF_TUNNEL_ID}/configurations"
curl -fsS -H "Authorization: Bearer ${CF_API_TOKEN}" "$CF_CFG" > before.json
jq -e '.success == true and (.result.config.ingress | type) == "array"' before.json

jq --arg origin "http://app-green-<release-sha>:3000" '
  .result.config
  | .ingress |= map(
      if .hostname == "cc2.caaa.tech" or .hostname == "cc3.caaa.tech"
      then .service = $origin else . end
    )
  | {config: .}
' before.json > green.json

curl -fsS -X PUT \
  -H "Authorization: Bearer ${CF_API_TOKEN}" \
  -H 'Content-Type: application/json' \
  --data @green.json "$CF_CFG" > cutover-result.json
curl -fsS -H "Authorization: Bearer ${CF_API_TOKEN}" "$CF_CFG" > after.json
```

Compare the captured version immediately before `PUT`, require the readback version to increment,
and require only the two intended hostname services to change. The API has no release-proven CAS,
so the operator mutex is mandatory. Rollback re-PUTs `{config: .result.config}` derived from the
exact `before.json`; never reconstruct it from memory.

Wait for cloudflared to log a newer configuration version, then prove:

- new external HTTP requests report the green version;
- a pre-existing blue SSE stream continues to receive every expected frame;
- a pre-existing blue WebSocket remains usable;
- new SSE and WebSocket connections land on green and settle exactly once;
- blue, DB, Redis, and cloudflared IDs/restart counts remain unchanged.

Leave blue running and addressable. Do not send it `SIGTERM` during this release. Observe health,
5xx, stream disconnects, DB locks/latency, Redis errors, billing mismatches, green restart count, and
provider-query latency for the agreed window before enabling GPT-5.6/Priority traffic.

### 6. Rollback boundary

Before GPT-5.6/Priority is enabled, rollback is a tunnel-origin hot-switch back to
`http://app:3000`; green remains running and drains. Schema and indexes are additive and are not
rolled back. Delete only stale v1 rolling ZSETs plus v1 rolling/provider leases and provider-total
snapshots before relying on blue limits again; never delete fixed-window counters.

After any request has used the new GPT-5.6/Priority billing semantics, blue is not a billing-safe
rollback target. Disable admission of the new model/tier first and prove there are no such in-flight
requests, or roll forward on green. A blind origin switch to 0.8.2 after feature enablement is
prohibited.

## Acceptance and release gates

- The supplied cold fixture `9016 / read 0 / reported write 0` settles to 9016 cache-write tokens.
- The supplied hot fixture `9016 / read 7936 / reported write 0` settles to 1080 cache-write tokens.
- Responses/Chat, streaming/non-streaming, public OpenAI-compatible/private Codex, client-abort
  drain, and hedge winner/loser paths share one settled allocation.
- Sol, Terra, and Luna match the exact official Standard-short, Standard-long, and Priority-short
  rates in table-driven tests.
- 272,000 and 272,001 boundary tests assert every bucket independently.
- Message request, ledger, Redis/session accounting, rate-limit cost, Langfuse, and exports agree.
- A production-database copy migrates successfully without changing any historical `cost_usd` sum.
- Production-copy provider totals use the covering/partial/GIN indexes after `ANALYZE`; no
  production-sized sequential ledger scan is accepted.
- New pure modules meet at least 80% unit coverage.
- Focused Vitest, integration/ledger consistency, OpenAPI checks, migration validation, full Vitest,
  Biome, typecheck, production build, and `git diff --check` all pass after the final edit.
