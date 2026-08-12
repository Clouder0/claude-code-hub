# Fake-200 Overload Recovery Plan

Status: Ready for Human Acceptance — local implementation and verification complete on 2026-08-12

> The Human's repeated `continue` direction after the approval checkpoint authorizes the recommended
> Responses-only structured-gate backport and local verification. Commit, push, PR, deployment,
> production access, and production configuration remain outside the granted authority.

> The earlier `Ready for Human Acceptance` verdict covered the implementation now present in
> `a8496a97` and `a9b421a6`. Production evidence and a current-source reproduction later showed that
> metadata-only Responses frames could release that gate before a terminal overload error. This
> resumed Plan now records the revised semantic gate, its verification, and the final Goal-state
> review. The work remains local and uncommitted.

## Goal

### Target

For a standard streaming `/v1/responses` request routed to a Codex provider, CCH must distinguish
protocol bookkeeping from actual model/tool content before committing any upstream byte to the
client. If an upstream HTTP 200 stream fails before real content, CCH must cancel that attempt and
reuse the existing provider recovery state machine. The client must observe only the successful
provider's byte-exact stream, or a real retryable HTTP 5xx when CCH recovery is exhausted.

The repair must preserve the irreversible boundary after real content: CCH does not transparently
replay a provider attempt once content has been committed. It must also make the commit reason
available to a later post-commit error without logging or persisting request or response content.

### Success conditions

- A complete SSE frame is classified by payload semantics as `content`, `error`, `malformed`,
  `terminal`, or `neutral`; an event-name allowlist is not the commit authority.
- `response.created`, `response.queued`, `response.in_progress`, `response.metadata`, empty
  `response.content_part.added`, metadata-only `response.output_item.added`, and unknown well-formed
  events remain neutral and cannot release the gate.
- Non-empty text, reasoning, refusal, audio, tool arguments/input/action, image payload, and current
  Responses compaction payloads commit promptly and replay the buffered prefix byte-for-byte.
- `response.failed`, `response.error`, and already-recognized fake-200 error envelopes fail the
  provider attempt before downstream commitment. Overload remains distinguishable so all-provider
  exhaustion can return a real HTTP 503 with `server_is_overloaded` or `slow_down` semantics.
- A terminal frame or EOF before content, malformed SSE/JSON, event-cap exhaustion, and byte-cap
  exhaustion fail the current provider attempt before commitment; none silently fail open.
- Large `response.created` / `response.in_progress` request-echo frames do not consume the ordinary
  content prebuffer budget, but the exemption and total retained memory remain independently bounded.
- HTTP upstream and Responses WebSocket upstream paths share the same precommit semantics. Normal and
  streaming-hedge paths cannot select a pre-content failed attempt as winner.
- First-byte, streaming-idle timeout, cancellation, reader ownership, agent release, and circuit
  accounting preserve their existing meanings on every exit path.
- A fixed-size commit marker records only verdict, event type, frame/chunk index, buffered bytes, and
  echo-excluded bytes. It is emitted on a later post-commit failure so an incident identifies the
  irreversible release point without storing bodies, prompts, headers, credentials, model output,
  user/session identifiers, or unbounded strings.
- Existing non-Responses routes and raw-passthrough behavior remain unchanged in this backport.
- Focused tests, the repository quality gates, a bounded memory/concurrency check, and an isolated
  Codex end-to-end harness support the revised correctness argument.

### Blocked stop conditions

- Correct classification requires an unsupported protocol decision that current Codex source,
  upstream CCH classifiers, and bounded provider evidence cannot resolve consistently.
- The mature gate cannot be separated from replay, affinity, database migrations, or a broad proxy
  lifecycle rewrite without materially expanding the approved short-term scope.
- Representative high-concurrency memory evidence cannot support a bounded configuration that also
  accepts legitimate request-echo frames.
- Current branch behavior or an upstream refresh materially contradicts the source snapshots on which
  this Plan is based.
- Completion would require commit, push, deployment, production access, or another action outside the
  approved local implementation and testing envelope.

## Operating Model

### Supported scope

- `session.requestUrl.pathname === "/v1/responses"` with a streaming response and a selected
  `providerType === "codex"`. The provider selector already establishes this format/type pairing.
- Direct upstream HTTP SSE and upstream Responses WebSocket frames wrapped as SSE by the existing
  adapter.
- Ordinary provider attempts and the existing streaming hedge path.
- Current Responses content forms consumed by Codex, including metadata-only output item starts,
  incremental text/reasoning/tool payloads, and compaction payloads carried before or in a terminal
  frame.
- Structured pre-content failures of any already-supported type; overload is the primary regression,
  not a special retry mechanism.

Non-streaming fake-200 detection and the generic first-payload inspection for other routes remain in
their current paths. `/v1/responses/compact` and raw passthrough do not gain new behavior unless
implementation evidence proves they already share the exact supported streaming contract.

### External guarantees

- Current CCH selection maps client format `response` only to Codex providers. The precommit parser
  therefore observes the OpenAI Responses wire format for the supported route.
- Upstream Responses producers may emit lifecycle, metadata, and item-construction frames before any
  text or executable tool payload. Unknown well-formed events are not proof of content.
- `response.created` and related lifecycle frames may echo large request fields, including
  instructions and input; size alone is not evidence of malformed output.
- Codex maps `response.failed` codes `server_is_overloaded` and `slow_down` to `ServerOverloaded` and
  does not retry that stream-level error. It retries real HTTP 5xx at the transport layer. The
  precommit/HTTP boundary must therefore be established in CCH.
- The implementation evidence is anchored to CCH `48b612129c09`, fetched `origin/main`
  `ccbad37f266e`, fetched `origin/dev` `f01f9f87f91c`, and Codex `279b9324`. The three semantic gate
  core files are unchanged between the prior `origin/dev` snapshot `3fe3225c` and the fetched tip.

### Internal invariants

- Before `content`, no byte from the current attempt is visible to the client.
- `neutral` means “insufficient evidence to commit,” not “ignore resource bounds.” Neutral frames are
  buffered only within the event, byte, parser, and idle-time limits.
- Only a semantic `content` verdict transfers the stream to normal downstream handling.
- A precommit failure cancels and releases the current reader before it re-enters the existing
  provider error categorization and alternative-selection loop.
- Once `content` commits, the attempt is not transparently replaced. Post-commit finalization may
  repair accounting, binding, and breaker state only.
- Error text may be inspected transiently inside the semantic boundary, but only a bounded protocol
  envelope containing `error.code` and `error.type` crosses into `ProxyError` and existing provider
  recovery. Raw frames and free-form upstream messages do not cross the logging or persistence
  boundary.
- A commit marker is fixed-shape, bounded, and associated with the attempt that actually committed.
  Hedge losers cannot overwrite the winner's marker.

### Failure semantics

- **Precommit structured error:** cancel the attempt; reuse existing provider failure/failover. Infer
  overload status through the existing detector rather than adding an independent prose matcher.
- **Precommit malformed, empty, terminal-before-content, or overflow:** fail the provider attempt as
  an upstream stream error, normally HTTP 502 if all alternatives fail.
- **Precommit idle timeout:** retain the existing `streaming_idle` / 524 classification and resource
  cleanup.
- **Client abort:** stop inspection and recovery; do not penalize or switch providers on the client's
  behalf.
- **Post-commit error or disconnect:** do not replay. Clear binding and update accounting/breakers as
  today, and attach the bounded commit marker to the error diagnostic.
- **All providers overloaded before content:** return a real HTTP 503 with an overload code so Codex
  transport retry can run. Seeing the same Codex capacity banner after those retries is a valid
  exhausted outcome, not a gate regression.

### Quality envelope

- Parser and classifier work is linear in observed bytes and bounded per attempt.
- The product default must enforce the repaired semantics. `off` and `shadow` are operational rollback
  and rollout tools, not alternate correctness modes.
- Event and byte caps are configurable without adding database columns, migrations, UI, or i18n in
  this short-term backport.
- The retained-memory upper bound includes ordinary prebuffer bytes, request-echo exemption, parser
  partial-frame storage, and concurrent hedge attempts. A configured cap is not accepted until that
  aggregate bound is explicit and exercised under representative concurrency.
- Normal content incurs only the time required to observe the first semantic content frame; buffered
  bytes flush immediately and byte-exactly when it arrives.
- New behavior receives at least the repository-required 80% unit coverage and semantic integration
  coverage; coverage percentage alone is not the acceptance argument.

### Explicit non-goals and unsupported conditions

- Retrying or provider-switching after semantic content has committed.
- Changing Codex retryability, user-facing Codex wording, provider retry counts, provider selection,
  or circuit-breaker policy.
- Adding a broader cross-protocol stream gate for Anthropic, Chat Completions, or Gemini in this
  backport.
- Importing upstream replay, affinity, cache-effectiveness, runtime system-settings UI, or their
  database migrations.
- Rebasing the 22 local commits onto upstream v0.9.2/current main as part of this repair.
- Commit, push, PR, deployment, production traffic, production credentials, or production database
  work.

### Material assumptions

- **Confirmed:** the superseded narrow gate passed metadata-only structural events and a large request
  echo before a later `response.failed`; direct current-source reproductions established both paths.
- **Confirmed:** upstream main/dev contains a mature five-state classifier and bounded content gate,
  but the original feature commits are coupled to much broader work and are not safe cherry-picks.
- **Confirmed:** the current branch and upstream main are substantially diverged; a full rebaseline is
  a separate migration project.
- **Confirmed:** the mature parser/classifier core was manually ported while retaining the current
  Forwarder, hedge, timeout, redaction, and error categorization contracts.
- **Confirmed:** the final defaults are 64 frames, 512 KiB ordinary prebuffer, and a separately bounded
  4 MiB request-echo allowance. Their 4.5 MiB sum is the raw retained-prefix hard cap per attempt;
  concurrent requests and simultaneous hedge/provider attempts multiply that bound.

## Decisions and Authority

### Human-decided / locked

- Hub owns transparent recovery only before client commitment; Codex is not asked to replay an HTTP
  200 terminal SSE error.
- Recovery reuses the existing provider state machine. No overload-specific retry loop or sleep is
  introduced.
- Privacy remains stricter than the upstream implementation where necessary: no raw SSE frame or
  error message is logged or persisted by the new diagnostics.
- Deployment and publication remain separate authority decisions.

### Agent-delegated / implemented

- Exact helper, module, and test organization; whether the old prefix helper is narrowed or replaced
  behind its existing call site.
- Mechanical adaptation of the upstream parser/classifier to the current branch's types and error
  objects.
- Exact fixed-shape diagnostic field names and rate limiting, within the privacy and correlation
  contract above.
- The smallest coherent Forwarder/hedge integration that preserves reader and timeout ownership.

### Implemented defaults

- Use the latest freshly verified upstream dev classifier as a semantic reference because the local
  dev snapshot includes compaction corrections absent from local main; port behavior, not commit
  history or unrelated modules.
- Limit enforcement to the canonical Responses route for the short-term backport.
- Add env-only `off | shadow | enforce` mode plus event/byte caps. Default to `enforce` in code; a
  deployment plan may stage `shadow` before cutover without changing the accepted semantics.

### Deferred

- Full upstream rebaseline of the custom v0.8.10 line, including migration reconciliation and
  reapplication or retirement of the 22 local commits.
- Cross-protocol adoption of the upstream gate and persisted/UI-managed runtime settings.
- Production rollout, soak, rollback, and exact-incident correlation against live infrastructure.

## Implemented Approach

### Causal system model

The superseded `streaming-response-gate.ts` held three Responses lifecycle event names and returned
`pass` for every other non-error event. `doForward()` then returned HTTP 200 to the normal or hedge
caller. A later `ResponseHandler` fake-200 classification could correct internal state but could not
re-enter provider selection. Codex maps the terminal overload frame to non-retryable
`ServerOverloaded`.

That ordinary pass path had no commit reason. The implementation now commits only on classified
semantic content and carries a bounded commit marker for later post-commit diagnostics.

### Implemented design

The implementation backports the mature semantic core, not the upstream feature bundle:

1. An incremental, bounded SSE parser handles arbitrary chunking, CRLF/LF, multi-line data,
   UTF-8 boundaries, comments, and an unterminated final frame.
2. Complete Responses frames are classified by non-empty payload paths and terminal/error semantics.
   Unknown well-formed frames remain neutral.
3. The content gate runs before the current Forwarder returns a successful streaming response. On
   content, reconstruct a byte-exact Response from the buffered chunks plus the owned reader. On
   failure, cancel and throw into the existing categorization/failover loop.
4. Existing generic one-payload fake-200/HTML/JSON detection and overload inference are preserved. The
   structured gate refines when it is safe to commit; it does not introduce another text detector.
5. Lifecycle request echoes are treated specially in byte accounting while both the exemption and
   total retained bytes remain bounded.
6. A fixed commit marker is carried into deferred finalization and hedge winner state. It is emitted
   only when it explains a later failure or when explicitly sampled in shadow diagnostics.
7. Mode and caps are exposed through environment schema only. The backport does not pull the upstream
   system settings, replay, affinity, or cache modules into the release line.

The classifier has five verdicts: `content`, `error`, `malformed`, `terminal`, and `neutral`. JSON
`data.type` overrides a conflicting SSE `event:` field. Lifecycle, metadata, metadata-only
`response.output_item.added`, empty content parts, and unknown valid events remain neutral. Non-empty
text, reasoning, refusal, audio, tool payloads, image payloads, and compaction payloads commit. Complete
`response.output_item.done` content detection includes `item.content.#.refusal` and `item.result`, the
latter covering Codex `ImageGenerationCall` output.

Error, malformed data, terminal-before-content, EOF, invalid UTF-8, and event/byte cap exhaustion all
fail closed before commitment. Event and aggregate byte caps are checked before a later content frame
can commit, including when several semantic frames share one transport chunk. If content precedes a
later error in frame order, content remains the irreversible boundary and the whole owned chunk is
replayed; switching providers after that point could duplicate visible output or tool effects.

`STREAM_GATE_MODE` supports `off | shadow | enforce` and defaults to `enforce`. The default caps are 64
frames, 512 KiB ordinary prefix, and 4 MiB request echo, for a 4.5 MiB raw retained-prefix bound per
attempt. The Responses WebSocket adapter applies the same semantic gate after translating messages to
SSE and independently caps both a single WebSocket payload and the queued payload bytes at 8 MiB.

The semantic error path constructs only a bounded `{error:{code,type}}` detector envelope. It does not
pass the raw failure frame or free-form `message`/`detail` through `ProxyError.upstreamError`, provider
decision records, database rows, Langfuse, or warnings. The detector identity on this path remains
`FAKE_200_JSON_ERROR_NON_EMPTY` so existing overload/status inference and provider recovery are reused.
Normal and hedge completion consume the commit marker from the actual returned/winning `Response`, so
a loser cannot overwrite the winner's marker.

This keeps the short-term causal scope at the stream commit boundary while using the protocol model
already exercised upstream. It also preserves an env rollback and avoids turning an incident repair
into a 293-commit upgrade.

### Causal scope

Actual implementation surfaces:

- `src/app/v1/_lib/proxy/stream-gate/{sse-frames,responses-frame-classifier,responses-content-gate,
  responses-shadow-observer}.ts` for the bounded semantic core;
- `streaming-response-gate.ts`, `forwarder.ts`, `stream-finalization.ts`, `response-handler.ts`, and
  `fake-200-observability.ts` for integration, ownership, recovery, and bounded diagnostics;
- `responses-ws/upstream-adapter.ts` for the independent WebSocket payload/queue bound;
- `env.schema.ts`, `.env.example`, focused test configuration and tests, and the reproducible memory
  benchmark script.

Existing error detection, response finalization, provider selection, and circuit breaking are reused
unless a focused integration test proves an incompatible assumption. Unrelated dashboard, billing,
replay, affinity, migration, and deployment work is outside causal scope.

### Meaningful alternatives

- **Extend `RESPONSES_PRE_OUTPUT_EVENT_TYPES`: rejected.** It fixes only currently observed names,
  retains unknown-event and request-echo bypasses, and cannot distinguish metadata-only from
  output-bearing instances of the same event type.
- **Make Codex retry `ServerOverloaded`: rejected.** Codex lacks downstream-commit knowledge and could
  duplicate visible output or tool effects; it also amplifies genuine overload.
- **Buffer the complete stream before responding: rejected.** It removes streaming latency and needs
  unbounded or response-sized retention.
- **Immediately rebaseline onto upstream main: deferred.** It is the better long-term maintenance
  direction, but the 22/293 divergence, local product semantics, and migration history make it a
  separate high-risk change.
- **Enable the full cross-protocol upstream gate now: deferred.** It broadens compatibility and
  performance risk beyond the Codex failure being repaired.

### Executed roadmap

1. **Evidence refreshed.** CCH and Codex source anchors were recorded, and the relevant upstream core
   was confirmed unchanged across the fetched dev snapshots.
2. **Semantic core ported.** The five-state classifier, incremental parser, bounded content gate, and
   shadow observer were adapted without replay/affinity or database dependencies.
3. **Ownership integrated.** Normal, hedge, and WebSocket-derived SSE paths now share the precommit
   semantics while preserving timeout, cancellation, reader, and agent cleanup.
4. **Recovery and observability integrated.** Precommit failures reuse existing provider recovery;
   bounded commit markers and rate-limited diagnostics describe the irreversible boundary without
   bodies or free-form messages.
5. **Semantic and resource verification completed.** Focused tests, coverage, memory benchmarks, and
   repository gates were executed.
6. **Real client boundary verified.** A disposable built CCH plus two isolated mock-provider origins
   proved in-request provider recovery and all-provider HTTP retry behavior with current Codex.
7. **Goal-state review completed.** No material contradiction remains in the accepted Operating Model;
   the task stops at Ready for Human Acceptance.

### Verification strategy

The completed correctness argument covers these partitions:

- **Classifier:** lifecycle and metadata neutral; metadata-only output item neutral; non-empty
  text/reasoning/tool/image/compaction content; error precedence over content-like fields; terminal;
  malformed; unknown neutral.
- **Parser:** arbitrary byte and UTF-8 fragmentation, CRLF/LF, comments, multi-line data, conflicting
  event/data type, unterminated final frame, partial-frame bound, cancellation.
- **Gate:**
  `created -> output_item.added(metadata) -> failed`,
  `created -> metadata -> failed`,
  `created -> content_part.added(empty) -> failed`,
  large request echo followed by failure, true content commit, terminal-before-content, EOF,
  event/byte overflow, idle timeout, and client abort.
- **Forwarder:** provider A pre-content failure/provider B success exposes only B bytes; all-overload
  returns real HTTP 503; mixed non-overload failures retain existing safe error semantics; provider A
  content-then-failure is not transparently replayed.
- **Hedge and WebSocket:** a neutral-prefix/error attempt cannot win; upstream WebSocket frames pass
  through the same gate and cancellation ownership.
- **Observability/privacy:** a post-commit failure includes the correct winner commit marker; high
  concurrency retains fixed metadata without body/message/identity leakage or Redis/DB/session-debug
  writes.
- **Resources:** derive the per-attempt and per-request maximum retained bytes, include simultaneous
  hedge attempts, and exercise representative long instructions/tool sets at expected concurrency.
- **Client E2E:** Codex succeeds in the same turn when an alternate CCH provider is healthy; when all
  providers overload, Codex performs transport retries and may still end with the capacity banner.
- **Regression/quality:** existing fake-200 tests, required 80% new-feature coverage, full Vitest,
  `bun run build`, `bun run lint`, `bun run lint:fix`, `bun run typecheck`, and `git diff --check`.

## Progress and Material Discoveries

- Diagnosis and implementation are complete. Current-source reproduction established three
  structural-event bypasses and a 40 KiB request-echo cap bypass in the superseded narrow gate. The
  semantic gate and its integration are now present as local uncommitted changes.
- The prior narrow gate's 15/15 tests demonstrated that the production failure was outside their
  fixture model. The revised focused suite now exercises lifecycle, metadata, request echo, malformed,
  overflow, normal, hedge, WebSocket, privacy, and post-commit partitions.
- Current Codex source at `279b93242cfef379e65da97e87e44b83c5934fd7` establishes the exact retry
  boundary: `sse/responses.rs` maps `response.failed` codes `server_is_overloaded` and `slow_down` to
  `ApiError::ServerOverloaded`; `api_bridge.rs` maps that to `CodexErr::ServerOverloaded`;
  `protocol/src/error.rs::is_retryable()` returns false; and `core/src/session/turn.rs` checks that
  predicate before entering `handle_retryable_response_stream_error()`. A stream-level overload
  therefore never reaches the `stream_max_retries` loop.
- Real HTTP calls follow `codex-api/src/endpoint/session.rs` through
  `run_with_request_telemetry()` to `codex-client/src/retry.rs::run_with_retry()`. The loop is
  `0..=max_attempts`, so `request_max_retries=2` means three HTTP attempts, and HTTP 5xx is retried
  before an SSE stream is constructed. The current official Codex Configuration Reference documents
  `request_max_retries` as HTTP request retries and `stream_max_retries` as SSE interruption retries;
  it does not document `ServerOverloaded` retryability, so source plus E2E are decisive here.
- Local upstream history contains the mature structured gate. Its initial implementation and later
  corrections are on a branch independent from the current custom v0.8.10 line.
- Local reflog shows `origin/dev` remained at v0.8.10 until the 2026-08-11 fetch. The existence of an
  earlier-authored upstream gate is not evidence that the prior hotfix author could see it locally on
  2026-07-30.
- The 2026-08-12 fetch advanced `origin/dev` from `3fe3225c` to `f01f9f87f91c` while leaving
  `origin/main` at `ccbad37f266e`. The fetched change is a replay OOM repair; the classifier, SSE
  parser, and content-gate files are byte-identical across that dev range, so it does not contradict
  this backport. Current divergence is 22 local commits versus 293 fetched dev commits.
- The prior Plan's locked rule that unknown/malformed/cap paths fail open is falsified. The revised
  invariant is semantic content commitment plus bounded fail-closed recovery before content.
- The final default cap is intentionally much smaller than the upstream 10 MiB starting point: 512 KiB
  ordinary plus 4 MiB request echo. The aggregate raw-prefix bound is
  `concurrent requests × simultaneous provider attempts per request × 4.5 MiB`; the attempt multiplier
  is dynamic and is not assumed to be exactly two.
- The existing `experimental.proxyClientMaxBodySize: "100mb"` and the 100 MB compressed-request
  decompression limits govern inbound request handling. They are unrelated to the response-prefix
  semantic gate and do not imply support for a 100 MiB retained response prefix.
- A privacy review found and corrected one material defect before completion: the first semantic-gate
  version passed a raw failure frame/free-form message into `ProxyError`. The final path forwards only
  bounded protocol `code/type`; the privacy regression is covered by focused tests and the disposable
  sentinel exercise.
- Current phase: Ready for Human Acceptance. No material Goal, evidence, quality, decision, or context
  delta remains inside the authorized local implementation envelope.

## Review and Handoff

### Review verdict

**Ready for Human Acceptance.** The Goal-state review found no material defect or contradiction in the
supported `/v1/responses` + Codex provider + SSE Operating Model. Further autonomous work would either
repeat existing evidence or enter publication/deployment scope that still requires separate authority.

### Evidence and Goal delta

The causal defect, reachable bypasses, Codex retry boundary, branch topology, bounded backport, resource
envelope, and real-client behavior are established:

- Semantic-core coverage: 7 files and 91 tests passed; statements 91.85%, branches 85.90%, functions
  95.50%, and lines 95.09%. This exceeds the repository's 80% requirement and is paired with semantic
  integration coverage rather than used as the sole acceptance argument.
- Focused regression suite: 13 files and 169 tests passed, covering parser, classifier, gate, shadow,
  resources/config, normal Forwarder, hedge, WebSocket adapter, observability, ResponseHandler, and
  environment schema.
- Repository gates: `bun run build`, `bun run lint`, `bun run lint:fix`, `bun run typecheck`, and
  `git diff --check` passed. Lint retained two unrelated existing warnings plus a Biome schema/CLI
  version notice; `lint:fix` made no changes.
- Full Vitest: 772 files passed, 2 skipped, and 1 unrelated file failed; 7092 tests passed, 13 skipped,
  and 2 failed. Both failures are the existing reload-queue timing expectations in
  `tests/unit/lib/error-rule-detector-reload-queue.test.ts` (expected call count 2, observed 1 and 3).
  No task-related test failed.
- The final production standalone build was exercised with Codex CLI 0.147.0, an isolated
  `HOME`/`CODEX_HOME`, a generated temporary API key, disposable PostgreSQL/Redis/CCH, and two mock
  providers on distinct loopback origins. No production credential or endpoint was used.
- Provider A emitted `response.created -> response.output_item.added(metadata only) ->
  response.failed(server_is_overloaded)` and Provider B emitted semantic success. With Codex
  `request_max_retries=0` and `stream_max_retries=0`, the client observed only
  `CCH_FAKE200_FINAL_B_SUCCESS`; provider counters were `{"a":1,"b":1}`. This proves recovery occurred
  within one CCH request.
- With both providers overloaded, a direct CCH probe returned non-SSE HTTP 503 with
  `error.code=server_is_overloaded`, no lifecycle prefix, and no private-message sentinel. Codex with
  `request_max_retries=2` and `stream_max_retries=0` moved provider counters from `{"a":2,"b":2}` to
  `{"a":5,"b":5}`: three Codex HTTP attempts times two CCH provider attempts. The familiar capacity
  banner remained only after those retries were exhausted.
- A unique free-form sentinel injected into every mock overload message appeared zero times in CCH
  process logs, disposable `message_request`, disposable `usage_ledger`, and the terminal HTTP body.
  All disposable processes, containers, test homes/keys/files, and loopback listeners were removed and
  verified absent.
- The representative `4 concurrent requests × 3 simultaneous attempts` benchmark held 12 gates and
  approximately 56.576 MB of raw prefix. Fresh RSS deltas were approximately 85.5 MB for complete
  frames and 124.2 MB for fragmented request echo; array-buffer use returned near baseline after
  release. Wider measurements retained the following envelope:

| Gates | Raw prefix | Complete RSS delta | Partial-echo RSS delta |
| ---: | ---: | ---: | ---: |
| 1 | 4.71 MB | ~22.6 MB | ~19.4 MB |
| 3 | 14.14 MB | ~34.5 MB | ~38.5 MB |
| 12 | 56.58 MB | median ~90.4 MB | ~123.6 MB |
| 24 | 113.15 MB | ~150.0 MB | ~246.7 MB |
| 48 | 226.30 MB | ~263.0 MB | not measured |

### Material deviations

- Unknown well-formed events change from immediate pass to bounded neutral buffering.
- Malformed, terminal-before-content, EOF-before-content, and cap exhaustion change from fail-open to
  precommit provider failure.
- The 32 KiB shared cap changes to configurable event/byte/parser bounds with a separately capped
  request-echo exemption.
- Ordinary successful commits gain a fixed marker retained only to explain later post-commit failure.
- The upstream 10 MiB ordinary starting point was reduced to 512 KiB, with a separate 4 MiB
  request-echo allowance, after explicit resource measurement.
- Privacy is stricter than the initial port: only protocol `code/type` crosses the recovery boundary;
  free-form upstream messages never do.

These changes are required by the corrected commit invariant; they are not incidental refactoring.

### Context worth carrying forward

- The same Codex capacity banner will remain possible after a correct fix when real HTTP-503 recovery
  is exhausted. Operational acceptance must distinguish that valid path from a single HTTP-200
  terminal SSE.
- A full upstream rebaseline should follow as a separate project; repeated feature backports onto the
  v0.8.10 custom line will continue to accumulate integration risk.
- Upstream gate behavior is evidence and reusable implementation material, not automatic authority
  over this branch's privacy, rollout, and resource envelope.

### Human attention

The local implementation and verification need no further technical decision. Human acceptance is now
the only task-level checkpoint. Commit, push, PR, deployment, production access, rollout mode/config,
and production validation remain separate, unauthorized decisions; none has been performed.
