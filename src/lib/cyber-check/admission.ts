import { setTimeout as delay } from "node:timers/promises";
import { normalizeEndpointPath, V1_ENDPOINT_PATHS } from "@/app/v1/_lib/proxy/endpoint-paths";
import { RequestReviewError } from "@/app/v1/_lib/proxy/errors";
import type {
  CyberCheckAdmissionCorrelation,
  CyberCheckObservationResult,
  ProxySession,
} from "@/app/v1/_lib/proxy/session";
import { isWebsocketClientRequest } from "@/app/v1/_lib/responses-ws/eligibility";
import { getEnvConfig } from "@/lib/config/env.schema";
import { logger } from "@/lib/logger";
import { ERROR_CODES, getErrorMessageServer } from "@/lib/utils/error-messages";
import type { Provider } from "@/types/provider";
import { cyberCheckEncodingCapacity, type EncodingCapacityLease } from "./capacity";
import { CyberCheckClientError, getReviewJob, submitReview } from "./client";
import { type CyberCheckConfig, resolveCyberCheckConfig } from "./config";
import { projectFinalResponsesRequest, type ReviewProjectionIdentity } from "./projection";
import type { ActiveRestriction, ReviewSubmission } from "./types";

const JOB_POLL_INTERVAL_MS = 1_000;
const JOB_POLL_LIFETIME_MS = 30_000;

export interface FinalResponsesAdmissionInput {
  session: ProxySession;
  provider: Pick<Provider, "id" | "providerType">;
  requestPath: string;
  message: Record<string, unknown>;
  bodyString: string;
}

export interface PreparedShadowObservation {
  start(): void;
}

interface SubmittedReview {
  submission: ReviewSubmission;
  correlation: CyberCheckAdmissionCorrelation;
}

interface FinalResponsesReviewInput {
  message: Record<string, unknown>;
  bodyString: string;
  identity: ReviewProjectionIdentity;
  context: ReviewAttemptContext;
}

interface ReviewAttemptContext {
  requestId: string | null;
  sessionId: string | null;
  providerId: number;
  clientAbortSignal: AbortSignal | null;
}

/**
 * Reviews exactly the final logical body that is about to leave CCH. The function is deliberately
 * policy-free: CCH sends every supported request and honors only the service's effective decision.
 */
export async function admitFinalResponsesRequest({
  session,
  provider,
  requestPath,
  message,
  bodyString,
}: FinalResponsesAdmissionInput): Promise<void> {
  const env = getEnvConfig();
  if (env.CYBER_CHECK_MODE === "off") return;
  if (!isSupportedRequest(session, provider, requestPath)) return;

  if (env.CYBER_CHECK_MODE === "shadow") {
    const prepared = prepareFinalResponsesShadowObservationWithEnv(
      { session, provider, requestPath, message, bodyString },
      env
    );
    prepared?.start();
    return;
  }
  const reviewInput = captureFinalResponsesReviewInput({
    session,
    provider,
    requestPath,
    message,
    bodyString,
  });

  let config: CyberCheckConfig;
  try {
    const resolved = resolveCyberCheckConfig(env);
    if (!resolved) return;
    config = resolved;
  } catch (error) {
    logAdmissionFailure("configuration", error, reviewInput.context);
    if (env.CYBER_CHECK_MODE === "enforce") {
      throw await localizedRequestReviewError("unavailable");
    }
    return;
  }

  let submitted: SubmittedReview;
  try {
    submitted = await submitFinalResponsesReview(reviewInput, config);
    session.setCyberCheckObservation({
      completion: Promise.resolve({
        status: "recorded",
        correlation: submitted.correlation,
      }),
    });
  } catch (error) {
    if (reviewInput.context.clientAbortSignal?.aborted) throw error;
    logAdmissionFailure("submission", error, reviewInput.context);
    if (isCapacityFailure(error)) throw await localizedRequestReviewError("capacity");
    throw await localizedRequestReviewError("unavailable");
  }

  logSubmission(submitted.submission, config, reviewInput.context);

  if (submitted.submission.status === "completed" && submitted.submission.decision === "deny") {
    throw await localizedRequestReviewError("restricted", submitted.submission.restriction);
  }
}

/**
 * Installs one unsettled request-scoped handle without projecting or uploading the body. The caller
 * starts upstream transport first, then calls start so Cyber Check cannot become a shadow TTFB gate.
 */
export function prepareFinalResponsesShadowObservation(
  input: FinalResponsesAdmissionInput
): PreparedShadowObservation | null {
  return prepareFinalResponsesShadowObservationWithEnv(input, getEnvConfig());
}

function prepareFinalResponsesShadowObservationWithEnv(
  input: FinalResponsesAdmissionInput,
  env: ReturnType<typeof getEnvConfig>
): PreparedShadowObservation | null {
  if (env.CYBER_CHECK_MODE !== "shadow") return null;
  if (!isSupportedRequest(input.session, input.provider, input.requestPath)) return null;
  const reviewInput = captureFinalResponsesReviewInput(input);

  let settle!: (result: CyberCheckObservationResult) => void;
  const completion = new Promise<CyberCheckObservationResult>((resolve) => {
    settle = resolve;
  });
  input.session.setCyberCheckObservation({ completion });

  let started = false;
  return {
    start: () => {
      if (started) return;
      started = true;
      // Defer projection/hash/serialization until the caller has returned to the upstream await.
      // This removes Cyber Check's synchronous CPU prefix from the shadow response chain while
      // still overlapping observation work with upstream network time.
      setImmediate(() => {
        void runShadowObservation(reviewInput, env).then(settle, (error: unknown) => {
          logAdmissionFailure("submission", error, reviewInput.context);
          settle({ status: "capture_gap" });
        });
      });
    },
  };
}

async function runShadowObservation(
  input: FinalResponsesReviewInput,
  env: ReturnType<typeof getEnvConfig>
): Promise<CyberCheckObservationResult> {
  let config: CyberCheckConfig;
  try {
    const resolved = resolveCyberCheckConfig(env);
    if (!resolved) return { status: "capture_gap" };
    config = resolved;
  } catch (error) {
    logAdmissionFailure("configuration", error, input.context);
    return { status: "capture_gap" };
  }

  try {
    const submitted = await submitFinalResponsesReview(input, config);
    logSubmission(submitted.submission, config, input.context);
    return { status: "recorded", correlation: submitted.correlation };
  } catch (error) {
    if (input.context.clientAbortSignal?.aborted) {
      logger.debug("CyberCheck: shadow observation stopped after client disconnect", {
        requestId: input.context.requestId,
        sessionId: input.context.sessionId,
        providerId: input.context.providerId,
      });
    } else {
      logAdmissionFailure("submission", error, input.context);
    }
    return { status: "capture_gap" };
  }
}

async function submitFinalResponsesReview(
  { message, bodyString, identity, context }: FinalResponsesReviewInput,
  config: CyberCheckConfig
): Promise<SubmittedReview> {
  let encodingLease: EncodingCapacityLease | null = null;
  try {
    encodingLease = cyberCheckEncodingCapacity.tryAcquire(
      Buffer.byteLength(bodyString),
      config.maxEncodingBytes
    );
    if (!encodingLease) {
      throw new CyberCheckClientError(
        "Cyber Check encoding working-set capacity is exhausted",
        503,
        "cyber_check_capacity"
      );
    }
    const packet = projectFinalResponsesRequest({
      identity,
      message,
      bodyString,
    });
    const unsupportedFields = packet.coverage.notices
      .filter((notice) => notice.code === "unsupported_top_level_field" && notice.field)
      .map((notice) => notice.field);
    if (unsupportedFields.length > 0) {
      logger.info("CyberCheck: projection gap - unsupported top-level fields", {
        fields: unsupportedFields,
        requestId: context.requestId,
        sessionId: context.sessionId,
        providerId: context.providerId,
      });
    }
    const submission = await submitReview(config, packet, {
      signal: context.clientAbortSignal,
    });
    return {
      submission,
      correlation: {
        identity: packet.identity,
        upstreamProviderId: String(context.providerId),
      },
    };
  } finally {
    encodingLease?.release();
  }
}

function captureFinalResponsesReviewInput({
  session,
  provider,
  message,
  bodyString,
}: FinalResponsesAdmissionInput): FinalResponsesReviewInput {
  const context = session.messageContext;
  const stableIdentity = session.getStableRequestIdentity?.();
  const requestId = stableIdentity?.requestId ?? context?.id;
  const principalId = stableIdentity?.principalId ?? context?.user.id;
  const identity = {
    requestId: requestId == null ? "" : String(requestId),
    principalId: principalId == null ? "" : String(principalId),
    sessionId: session.sessionId ?? "",
    sequence: session.requestSequence,
  };
  return {
    message,
    bodyString,
    identity,
    context: {
      requestId: identity.requestId || null,
      sessionId: session.sessionId,
      providerId: provider.id,
      clientAbortSignal: session.clientAbortSignal,
    },
  };
}

function logSubmission(
  submission: ReviewSubmission,
  config: CyberCheckConfig,
  context: ReviewAttemptContext
): void {
  if (submission.status === "pending") {
    const jobId = submission.job_id;
    const clientSignal = context.clientAbortSignal;
    const observationContext = {
      requestId: context.requestId,
      sessionId: context.sessionId,
    };
    logger.info("CyberCheck: request provisionally admitted with an asynchronous review job", {
      jobId,
      ...observationContext,
      providerId: context.providerId,
      mode: config.mode,
    });
    // Capture only scalar correlation fields and the request signal. Holding ProxySession here
    // would retain the full multi-megabyte request tree for the lifetime of an async review job.
    void observeReviewJob(config, jobId, clientSignal)
      .then((decision) => {
        if (!decision) return;
        const log =
          decision.decision === "deny" ? logger.warn.bind(logger) : logger.info.bind(logger);
        log("CyberCheck: asynchronous review job completed", {
          jobId,
          decision: decision.decision,
          predictedDecision: decision.predicted_decision,
          enforcementMode: decision.enforcement_mode,
          policyVersion: decision.policy_version,
          ...observationContext,
        });
      })
      .catch((error) => {
        const errorContext = clientErrorContext(error);
        if (clientSignal?.aborted) {
          logger.debug("CyberCheck: stopped observing review job after client disconnect", {
            jobId,
            ...errorContext,
          });
        } else {
          logger.warn("CyberCheck: review job observation ended without a terminal result", {
            jobId,
            ...errorContext,
          });
        }
      });
    return;
  }

  const log =
    submission.decision === "deny" || submission.predicted_decision === "deny"
      ? logger.warn.bind(logger)
      : logger.info.bind(logger);
  log(
    config.mode === "shadow"
      ? "CyberCheck: shadow request observation completed"
      : "CyberCheck: synchronous request review completed",
    {
      decision: submission.decision,
      predictedDecision: submission.predicted_decision,
      enforcementMode: submission.enforcement_mode,
      reason: submission.reason,
      coverage: submission.coverage,
      policyVersion: submission.policy_version,
      requestId: context.requestId,
      sessionId: context.sessionId,
      providerId: context.providerId,
      mode: config.mode,
    }
  );
}

function isSupportedRequest(
  session: ProxySession,
  provider: Pick<Provider, "providerType">,
  requestPath: string
): boolean {
  return (
    provider.providerType === "codex" &&
    normalizeEndpointPath(requestPath) === V1_ENDPOINT_PATHS.RESPONSES &&
    !isWebsocketClientRequest(session.headers)
  );
}

async function observeReviewJob(
  config: CyberCheckConfig,
  jobId: string,
  clientSignal: AbortSignal | null
): Promise<Extract<Awaited<ReturnType<typeof getReviewJob>>, { status: "completed" }> | null> {
  const lifetime = AbortSignal.timeout(JOB_POLL_LIFETIME_MS);
  const signal = clientSignal ? AbortSignal.any([clientSignal, lifetime]) : lifetime;

  while (true) {
    await delay(JOB_POLL_INTERVAL_MS, undefined, { signal });
    const job = await getReviewJob(config, jobId, { signal });
    if (job.status === "pending") continue;
    if (job.status === "failed") {
      logger.warn("CyberCheck: asynchronous review job failed", {
        jobId,
        errorCode: job.error_code,
      });
      return null;
    }
    return job;
  }
}

function logAdmissionFailure(
  phase: "configuration" | "submission",
  error: unknown,
  context: ReviewAttemptContext
): void {
  logger.warn("CyberCheck: request review could not be completed", {
    phase,
    ...clientErrorContext(error),
    requestId: context.requestId,
    sessionId: context.sessionId,
    providerId: context.providerId,
  });
}

function clientErrorContext(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { errorType: "UnknownError" };
  const clientError = error as Partial<CyberCheckClientError>;
  return {
    errorType: error.name,
    ...(typeof clientError.status === "number" ? { status: clientError.status } : {}),
    ...(typeof clientError.serviceCode === "string"
      ? { serviceCode: clientError.serviceCode }
      : {}),
  };
}

async function localizedRequestReviewError(
  kind: "restricted" | "unavailable" | "capacity",
  restriction?: ActiveRestriction
): Promise<RequestReviewError> {
  try {
    const { getLocale } = await import("next-intl/server");
    const code = errorMessageCode(kind, restriction);
    let message = await getErrorMessageServer(await getLocale(), code);
    if (restriction?.scope === "session" && restriction.expires_at_ms !== undefined) {
      message = `${message} Retry after ${new Date(restriction.expires_at_ms).toISOString()}.`;
    }
    if (kind === "restricted") return RequestReviewError.restricted(message);
    if (kind === "capacity") return RequestReviewError.capacity(message);
    return RequestReviewError.unavailable(message);
  } catch {
    if (kind === "restricted") return RequestReviewError.restricted();
    if (kind === "capacity") return RequestReviewError.capacity();
    return RequestReviewError.unavailable();
  }
}

function errorMessageCode(
  kind: "restricted" | "unavailable" | "capacity",
  restriction?: ActiveRestriction
) {
  if (kind === "unavailable") return ERROR_CODES.CYBER_CHECK_UNAVAILABLE;
  if (kind === "capacity") return ERROR_CODES.CYBER_CHECK_CAPACITY;
  switch (restriction?.scope) {
    case "session":
      return ERROR_CODES.GATEWAY_CYBER_SESSION_RESTRICTED;
    case "client_instance":
      return ERROR_CODES.GATEWAY_CYBER_CLIENT_RESTRICTED;
    case "principal":
      return ERROR_CODES.GATEWAY_CYBER_PRINCIPAL_RESTRICTED;
    default:
      return ERROR_CODES.GATEWAY_CYBER_REQUEST_RESTRICTED;
  }
}

function isCapacityFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const serviceCode = (error as Partial<CyberCheckClientError>).serviceCode;
  return (
    serviceCode === "cyber_check_capacity" ||
    serviceCode === "reviewer_capacity" ||
    serviceCode === "review_queue_full"
  );
}
