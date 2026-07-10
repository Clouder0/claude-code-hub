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

The loser-provider prefilter uses JSON containment but this migration does not add a GIN index. A
potentially locking index build does not belong in the 0.8.2-to-0.8.10 upgrade path without data.
Run `EXPLAIN (ANALYZE, BUFFERS)` for representative provider windows on a production database copy;
if the result is unacceptable, generate and deploy a separate index migration.

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

## Redis rollout transition

Existing rolling-window ZSET members use the legacy request-ID identity. They are not rewritten by
the application upgrade and can collapse equal-cost winner/loser events until their TTL expires
(up to about 25 hours for rolling daily windows). Before enabling upgraded traffic, use reviewed
`SCAN` plus targeted deletion to invalidate only these rebuildable ZSET families:

```text
key:*:cost_5h_rolling
provider:*:cost_5h_rolling
user:*:cost_5h_rolling
key:*:cost_daily_rolling
provider:*:cost_daily_rolling
user:*:cost_daily_rolling
```

Also invalidate corresponding `lease:*:*:5h:rolling` and `lease:*:*:daily:rolling` entries. Invalidate
all `lease:provider:*` and `total_cost:provider:*` entries because they may contain results from the
old attribution query; keep every provider fixed-window cost counter itself. The first read then
rebuilds from the corrected ledger event stream. Leaderboard caches may be deleted or allowed to
expire under their short TTL.

Do not use the broad single-key/provider/user cost cleanup helpers for this transition: they also
match fixed 5-hour and fixed daily/weekly/monthly counters. Fixed 5-hour counters cannot be
reconstructed with their original window start after deletion and clearing them would reset active
limits. Capture key counts before and after invalidation and verify one cold DB rebuild for each
rolling entity type before opening traffic.

## Replay boundary

- The forwarder starts loser finalization once per hedge attempt in the current in-process
  lifecycle. Stable billing-event IDs additionally make rolling 5-hour/daily ZSET writes
  idempotent.
- Fixed-window counters and lease decrements are not yet independently idempotent across a future
  durable/cross-process replay. Do not add replay of completed hedge finalizers until each
  `(billingEventId, entity, window)` side effect has its own atomic deduplication contract.

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
- New pure modules meet at least 80% unit coverage.
- Focused Vitest, integration/ledger consistency, OpenAPI checks, migration validation, full Vitest,
  Biome, typecheck, production build, and `git diff --check` all pass after the final edit.
