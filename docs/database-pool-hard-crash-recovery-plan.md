# Database Pool Hard-Crash Recovery Plan

Status: Ready for Human Acceptance

## Goal

### Target

CCH must own exactly one ordinary postgres.js connection pool per Node process, and
`DB_POOL_MAX` must be a real process-level upper bound for that pool. PgBouncer saturation and
`query_wait_timeout` remain request-level operational failures: they may fail the affected request,
but must not create an unhandled postgres.js rejection or terminate CCH. User-limit aggregation must
not multiply one cache miss into four or five concurrent database queries.

### Success conditions

- Loading database-using code through distinct Next.js server, SSR, Server Action, API, proxy, and
  instrumentation bundles in one Node process creates one ordinary postgres.js client.
- `DB_POOL_MAX=N` bounds that process's ordinary application connections at `N`; explicitly scoped
  migration/maintenance clients remain separately bounded and short-lived.
- A PgBouncer-style `FATAL: query_wait_timeout` during first connection setup rejects the business
  operation without producing `unhandledRejection` or invoking the process exit path.
- Unknown genuine unhandled rejections still use the existing fail-fast diagnostics and
  `process.exit(1)` behavior.
- `getUserAllLimitUsage()` preserves rolling/fixed reset and `costResetAt` semantics while using one
  aggregate database query, plus Redis only when fixed 5-hour accounting requires it.
- Graceful shutdown stops database producers before closing the shared postgres.js client exactly
  once, without extending shutdown beyond its existing bounded deadline.
- A final production build and isolated runtime exercise prove the process-level pool invariant
  across representative bundle families; source-only unit tests are not sufficient evidence.
- Repository-required focused tests, coverage, full tests, lint, typecheck, and production build
  pass.

### Blocked stop conditions

- Next.js executes relevant server bundles in separate OS processes or isolated JavaScript realms
  where a process-global owner cannot be shared; that would require an explicit cross-process pool
  budget rather than the proposed invariant.
- Disabling postgres.js dynamic type fetching breaks a supported native PostgreSQL array use that
  cannot be replaced with an explicit type configuration.
- A final-artifact harness cannot distinguish ordinary application pools from migration clients;
  implementation may continue, but readiness cannot be claimed until runtime ownership is proven.

## Operating Model

### Supported scope

- The production standalone Next.js/Node server, including instrumentation/background schedulers,
  App Router API routes, proxy routes, Server Actions, and SSR server code in one OS process.
- Development/HMR and Vitest module resets, which may re-evaluate the source module but must not
  silently create another live client in the same process.
- PostgreSQL reached directly or through PgBouncer session pooling.

### External guarantees

- postgres.js `max` limits one client object, not a Node process.
- PgBouncer may return `query_wait_timeout` while a connection is initializing; CCH must contain
  that expected operational failure regardless of pool sizing.
- Process replicas have separate address spaces and therefore intentionally own separate pools.

### Internal invariants

- One process-global database owner contains both the raw postgres.js client and the Drizzle facade.
- Every bundled copy of `src/drizzle/db.ts` resolves that owner through the same `globalThis` key.
- The first owner fixes DSN and pool configuration for the process lifetime. A later conflicting
  configuration is an invariant violation, not permission to create another pool. Secrets are never
  logged while diagnosing a mismatch.
- Closing the owner is idempotent. Once shutdown begins, code cannot transparently construct a
  replacement pool.
- Purpose-built migration clients remain local, `max: 1`, and explicitly closed; they are not folded
  into the long-lived application pool.

### Failure semantics

- Database queue/connect/query failures are returned through the awaiting request/task boundary and
  logged with operational context.
- The postgres.js internal type-discovery path must not create an independently rejected Promise.
- The process-level crash handler remains strict for unexplained rejections; no broad exception for
  `PostgresError`, SQLSTATE `57014`, or `query_wait_timeout` is added.
- Pool configuration conflicts fail visibly before opening a second client.
- Diagnostic report write failure is reported separately and must not obscure the original fatal
  reason.

### Quality envelope

- No database schema or migration change.
- No user-facing or i18n surface change.
- Normal query semantics and prepared-query behavior remain compatible with the current
  postgres.js/Drizzle stack.
- The ordinary pool count is observable without logging DSNs, credentials, SQL parameters, or raw
  user data.
- New behavior receives at least the repository-required 80% unit coverage, plus protocol and
  final-artifact evidence for claims unit tests cannot establish.

### Explicit non-goals and unsupported conditions

- Switching PgBouncer to transaction pooling.
- Treating pool sizing as a substitute for containing postgres.js rejection leakage.
- Ignoring database errors in `unhandledRejection`.
- Building a cross-process connection semaphore inside CCH.
- Rewriting unrelated repository queries or connection-using maintenance tools.
- Applying production configuration, deploying containers, or changing PgBouncer in this code task.

### Material assumptions

- The 39 emitted database-code copies currently collapse to seven runtime module identities, and
  production EOF counts prove at least two clients have been active in one container. The exact
  identity of those two clients remains provisional until creation telemetry is added.
- The current Drizzle schema has no known native PostgreSQL array columns. `fetch_types: false` is
  therefore the preferred containment mechanism, subject to a real-PostgreSQL integration check.
- A single global object is shared by the ordinary server and SSR Turbopack runtimes because both run
  in the same Node realm. The final-artifact gate must verify this rather than relying on source
  reasoning alone.

## Decisions and Authority

### Human-decided / locked

- Fix the hard crash in CCH rather than accepting container restart as recovery.
- Make the database pool limit correspond to the real production ownership boundary.
- Investigate and prove the result before production rollout.

### Agent-delegated

- Exact state type, global key, helper boundaries, safe non-secret diagnostics, test fixture layout,
  and shutdown ordering after auditing all database producers.
- Mechanical migration of `getUserAllLimitUsage()` to the existing aggregate repository helper.

### Provisional

- Use one `globalThis`-owned database state record rather than relying on local-module caching or
  introducing a new external package solely to exploit Node's `require` cache.
- Set postgres.js `fetch_types: false`; prefer this small supported option over vendoring or patching
  postgres.js 3.4.8 unless integration evidence disproves compatibility.
- Emit one structured pool-created event with PID, non-secret configuration, and an opaque instance
  ID, plus a configuration-conflict diagnostic.

### Deferred

- Upgrading postgres.js for an upstream fix. The local containment must not depend on an unverified
  future version, but the protocol regression can later evaluate and remove the workaround safely.
- PgBouncer transaction mode and prepared-statement compatibility.
- A global multi-replica connection-budget controller; deployment sizing remains explicit.

## Proposed Approach

### Current system model

`src/drizzle/db.ts` stores its lazy singleton in a module-local variable. The production build emits
39 physical copies representing seven runtime module identities, so one Node process can create
multiple postgres.js clients, each independently allowed `DB_POOL_MAX` connections. Connection bursts
then exceed the PgBouncer session budget. During a new connection, postgres.js 3.4.8 defaults to
`fetch_types: true`; a PgBouncer fatal error rejects both the held business query and the internal
array-type query. Drizzle/request code consumes the former, while the latter reaches the process
`unhandledRejection` handler and exits CCH. `getUserAllLimitUsage()` further amplifies bursts with four
or five concurrent database operations despite an existing one-query aggregate helper.

### Recommended design

1. Replace the module-local database singleton with one process-global owner. Construct the raw
   client and Drizzle facade together, validate configuration consistency on every bundled entry,
   expose an idempotent close operation, and prevent resurrection during shutdown.
2. Configure that client with `fetch_types: false` after proving current schema/query compatibility.
   Preserve the process fail-fast handler unchanged for genuine unknown rejections.
3. Integrate database close into the existing bounded lifecycle after all database-producing
   schedulers/queues/write buffers stop. Record exactly one close attempt and make repeated shutdown
   signals harmless.
4. Replace the five-way user-limit query fan-out with `sumUserQuotaCosts()`. Rolling 5-hour usage
   comes from the aggregate result; fixed 5-hour usage continues to come from Redis while the other
   four values come from the single aggregate query.
5. Add non-secret pool ownership diagnostics and make report-directory writability a deployment
   preflight concern. Do not weaken fatal handling because reports are unavailable.

### Causal scope

- Required code surfaces: database owner/configuration, lifecycle shutdown, user-limit action and
  its tests, postgres.js protocol regression, and final-build runtime harness.
- Required deployment handoff: per-replica pool sizing with headroom and report-volume ownership.
- Intentionally excluded: PgBouncer mode changes, production deployment, and unrelated query tuning.

### Meaningful alternatives

- **Externalize a local database-owner package:** Node's package cache could provide one identity,
  but it couples correctness to bundler externalization and standalone tracing. `globalThis` states
  the actual process-level invariant directly and matches existing CCH scheduler/lifecycle practice.
- **Only lower `DB_POOL_MAX`:** cannot work while the number of clients is variable and therefore
  does not establish a process-level bound.
- **Suppress `query_wait_timeout` globally:** prevents fail-fast for errors whose origin and Promise
  ownership are unknown, masking the broken boundary rather than repairing it.
- **Patch/vendor postgres.js:** gives control over the internal rejection, but adds dependency
  maintenance cost. It remains a fallback if disabling dynamic type fetching is incompatible.

### High-level roadmap

#### Phase 1: Lock the failure and ownership regressions

- Convert the disposable fake PostgreSQL protocol probe into a deterministic subprocess test that
  demonstrates the current extra `unhandledRejection` with dynamic type fetching and zero such
  rejection with the chosen configuration.
- Extend database tests to evaluate independently loaded module copies against one shared global
  realm, prove one client construction, prove conflict detection, and prove idempotent close.
- Add a build-artifact identity check as diagnostic evidence, not as the singleton guarantee.

Checkpoint: tests fail against the current implementation for the two real defects—multiple client
construction and leaked internal rejection.

#### Phase 2: Establish the process-global owner and lifecycle

- Implement the global owner and `fetch_types` configuration.
- Audit scheduler, queue, buffered-write, and shutdown ordering; close the client only after all
  database producers are stopped.
- Add structured creation/close telemetry and configuration mismatch diagnostics without secrets.

Checkpoint: focused ownership, protocol, crash-handler, and lifecycle tests pass; genuine generic
unhandled rejection still exits.

#### Phase 3: Remove query fan-out

- Migrate `getUserAllLimitUsage()` to `sumUserQuotaCosts()` without changing reset-window semantics.
- Cover rolling/fixed 5-hour mode, rolling/fixed daily mode, reset clipping, all-time totals, Redis
  failure, and aggregate database failure.

Checkpoint: one action invocation performs one database aggregate in every supported mode and at most
one additional Redis operation.

#### Phase 4: Prove the production artifact

- Build the standalone image/artifact.
- In an isolated Podman environment, run the real production server against an isolated PostgreSQL
  and PgBouncer fixture, with no reuse of the Human's HOME or production credentials.
- Exercise instrumentation startup, readiness/API, proxy-related database access, SSR/dashboard, and
  Server Action families. Drive enough concurrency to make the pool expand.
- Prove exactly one ordinary pool-created event per Node PID and no more than `DB_POOL_MAX` ordinary
  PgBouncer client sessions from that container. Distinguish and exclude bounded migration sessions.
- Inject queue saturation/`query_wait_timeout`; prove affected operations fail while PID/container
  identity remains stable and no process-level unhandled rejection is emitted.

Checkpoint: final-artifact evidence, rather than source layout, proves both the pool bound and crash
containment.

#### Phase 5: Repository review and deployment handoff

- Run the required build, lint, lint-fix, typecheck, full Vitest suite, focused integration tests,
  coverage, and `git diff --check`; rerun final checks after any formatter mutation.
- Review the change against the Goal and preserve the production configuration envelope: total
  per-process pools across active/overlap replicas must fit below PgBouncer capacity with explicit
  headroom.
- Provide a rollout/revert checklist including pool-created log expectations, PgBouncer client/wait
  metrics, container restart count, and report-directory writeability. Deployment remains separately
  authorized.

### Verification strategy

- **Unit:** configuration defaults/overrides, one global construction across module resets, conflict
  detection, shutdown idempotency/no resurrection, aggregate action semantics, and retained strict
  crash-handler behavior.
- **Protocol subprocess:** PgBouncer-shaped FATAL during postgres.js first-connect initialization;
  assert business rejection is observed and no independent `unhandledRejection` exists.
- **Real PostgreSQL integration:** exercise representative JSONB, scalar, date/numeric, prepared, and
  any array-valued expressions with `fetch_types: false`.
- **Final artifact:** one Node PID, multiple Next/Turbopack runtime families, concurrent load, one pool
  creation, bounded connections, stable PID under injected queue timeout.
- **Operational:** report volume is writable; PgBouncer capacity math includes every live replica,
  blue/green overlap, migration clients, and non-CCH consumers.
- **Regression:** full repository checks required by project guidance, with at least 80% coverage for
  new behavior.

## Progress and Material Discoveries

- Confirmed the planning baseline at `codex/gpt56-priority-billing@a8496a97` in the clean worktree.
- Confirmed 39 physical build copies collapse to seven runtime database-module identities, not one.
- Production observations supplied by the Human show 20 and 12 live connections at process exit with
  `DB_POOL_MAX=10`, proving at least two client pools were active in each affected process window.
- Isolated protocol reproduction proves postgres.js 3.4.8 dynamic type discovery creates the extra
  unhandled rejection; disabling it removes that rejection in the reproduction.
- Confirmed an existing canonical one-query helper, `sumUserQuotaCosts()`, already serves the related
  self-quota path.
- Human approved the decision envelope.
- Added executable ownership regressions: independent module reloads in one global realm reuse one
  postgres.js client, conflicting pool configuration is rejected, and close is idempotent with no
  post-close resurrection.
- Added a subprocess protocol regression that reproduces one extra private rejection with postgres.js
  dynamic type discovery and zero extra rejection with the selected configuration.
- Implemented a process-global database owner with non-secret creation/close diagnostics,
  `fetch_types: false`, configuration conflict detection, and explicit close lifecycle.
- Expanded bounded shutdown to stop database-producing probes/queues/intervals, flush buffered writes,
  close the shared database, cancel Redis subscriptions, and then close Redis.
- Migrated `getUserAllLimitUsage()` to one `sumUserQuotaCosts()` database aggregate plus the existing
  fixed-5h Redis read when required. Focused reset-window and all-time tests pass.
- Focused ownership, protocol, lifecycle, crash-handler, and quota tests pass; typecheck passes.
- Real PostgreSQL 18 compatibility passed for JSONB, numeric, timestamptz, scalar, and prepared-query
  behavior. With dynamic type discovery disabled, native `integer[]` results remain PostgreSQL text
  (`"{1,2,3}"`) rather than parsed JavaScript arrays. No current CCH schema/query returns a native
  array, so this does not change the selected design; adding such a return contract is a mandatory
  revisit trigger.
- The first final-artifact shutdown exposed a timer-boundary false warning: postgres.js end and the
  lifecycle step were both configured for three seconds, so the outer timer logged a timeout in the
  same millisecond the pool closed. The driver drain budget is now two seconds, shorter than the
  outer three-second containment budget.
- Rebuilt the production standalone artifact and ran it in a disposable Podman pod against
  PostgreSQL 18, Redis, and PgBouncer in session mode with `default_pool_size=1`,
  `max_db_connections=1`, and `query_wait_timeout=1`; the application used `DB_POOL_MAX=3`.
- Final-artifact startup and representative `/api/health`, `/api/health/ready`, `/en/status`, and
  authenticated `/api/v1/users` routes completed successfully. Startup instrumentation encountered
  real `query_wait_timeout` failures while the same PID remained alive and reached `Application
  ready`.
- A 12-request saturation probe observed exactly three ordinary `postgres.js` PgBouncer clients
  plus one separately identified `psql` admin client. Requests returned a mix of 200 and expected
  503 responses under the deliberately undersized session pool; the container remained running with
  restart count zero.
- Final logs contain exactly one process-wide pool-created event, two `query_wait_timeout`
  occurrences, zero `unhandledRejection` events, exactly one pool-closed event, and no
  `closeDatabase timed out` warning. SIGTERM completed cleanup in 3010 ms and the container exited 0
  without restart.
- Current focus: repository-wide quality gates, coverage, final diff review, and Goal-state review.

## Review and Handoff

### Review verdict

Ready for Human Acceptance. The final Goal-state review found no material defects or unresolved
evidence gaps in the accepted scope. The process-global owner, query-wait failure containment,
single-query quota aggregation, ordered shutdown, and strict fail-fast preservation are supported by
source tracing, focused regressions, protocol reproduction, real PostgreSQL/PgBouncer behavior, and
the rebuilt standalone artifact.

### Evidence and Goal delta

The approved implementation is complete locally and the production artifact has passed the isolated
runtime gate. Final repository gates passed: Biome lint and lint-fix, TypeScript, production build,
`git diff --check`, 764 Vitest files with 7000 passing tests and 13 expected skips, and focused
coverage of 89.65% statements, 92.30% functions, and 91.85% lines. Focused branch coverage is 67.27%;
the uncovered branches are defensive/error partitions outside the changed success paths, while the
material failure partitions are covered by the subprocess protocol test and real PgBouncer run.

The first full test invocation had one harness-only failure because `bun` was absent from the shell
`PATH`; the exact drift test and the entire suite passed after using the repository's Bun installation
in an explicit isolated `PATH`. Biome reports two pre-existing non-blocking warnings and a CLI/schema
version info notice, but exits successfully. No production deployment or PgBouncer production change
has been made.

### Human attention

Final acceptance and any deployment remain with the Human. A separately authorized rollout should:

1. Set each replica's `DB_POOL_MAX` so the sum across active and blue/green overlap replicas, plus
   migrations and other consumers, leaves explicit headroom below PgBouncer capacity.
2. Preflight the production report volume as writable by the runtime UID/GID.
3. Expect exactly one `process-wide pool created` event per CCH PID and no configuration-conflict
   event; alert on a second creation for one PID, `unhandledRejection`, or container restart growth.
4. Watch PgBouncer client/wait counts, CCH 5xx rates, request latency, and restart count through a
   saturation window; a request-level `query_wait_timeout` may occur without process exit.
5. Roll back the application artifact if the pool invariant, array-valued query compatibility, or
   request containment fails. The change has no schema migration, so rollback is application-only.

Dynamic type fetching is intentionally disabled. Adding a supported query that returns a native
PostgreSQL array is the mandatory revisit trigger; current CCH array usage is input-side or returns
scalar rows and passed real-PostgreSQL compatibility checks.
