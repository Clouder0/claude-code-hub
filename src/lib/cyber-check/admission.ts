import { setTimeout as delay } from "node:timers/promises";
import { normalizeEndpointPath, V1_ENDPOINT_PATHS } from "@/app/v1/_lib/proxy/endpoint-paths";
import { RequestReviewError } from "@/app/v1/_lib/proxy/errors";
import type { ProxySession } from "@/app/v1/_lib/proxy/session";
import { isWebsocketClientRequest } from "@/app/v1/_lib/responses-ws/eligibility";
import { getEnvConfig } from "@/lib/config/env.schema";
import { logger } from "@/lib/logger";
import { ERROR_CODES, getErrorMessageServer } from "@/lib/utils/error-messages";
import type { Provider } from "@/types/provider";
import { type CyberCheckClientError, getReviewJob, submitReview } from "./client";
import { type CyberCheckConfig, resolveCyberCheckConfig } from "./config";
import { projectFinalResponsesRequest } from "./projection";
import type { ReviewSubmission } from "./types";

const JOB_POLL_INTERVAL_MS = 1_000;
const JOB_POLL_LIFETIME_MS = 30_000;

export interface FinalResponsesAdmissionInput {
  session: ProxySession;
  provider: Pick<Provider, "id" | "providerType">;
  requestPath: string;
  message: Record<string, unknown>;
  bodyString: string;
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

  let config: CyberCheckConfig;
  try {
    const resolved = resolveCyberCheckConfig(env);
    if (!resolved) return;
    config = resolved;
  } catch (error) {
    logAdmissionFailure("configuration", error, session, provider.id);
    if (env.CYBER_CHECK_MODE === "enforce") {
      throw await localizedRequestReviewError("unavailable");
    }
    return;
  }

  let submission: ReviewSubmission;
  try {
    const context = session.messageContext;
    const stableIdentity = session.getStableRequestIdentity?.();
    const requestId = stableIdentity?.requestId ?? context?.id;
    const principalId = stableIdentity?.principalId ?? context?.user.id;
    const credentialId = stableIdentity?.credentialId ?? context?.key.id;
    const packet = projectFinalResponsesRequest({
      identity: {
        gateway: config.gatewayId,
        requestId: requestId == null ? "" : String(requestId),
        principalId: principalId == null ? "" : String(principalId),
        credentialId: credentialId == null ? "" : String(credentialId),
        sessionId: session.sessionId ?? "",
        sequence: session.requestSequence,
      },
      message,
      bodyString,
    });
    submission = await submitReview(config, packet, { signal: session.clientAbortSignal });
  } catch (error) {
    if (session.clientAbortSignal?.aborted) throw error;
    logAdmissionFailure("submission", error, session, provider.id);
    if (config.mode === "enforce") throw await localizedRequestReviewError("unavailable");
    return;
  }

  if (submission.status === "pending") {
    const jobId = submission.job_id;
    const clientSignal = session.clientAbortSignal;
    const observationContext = {
      requestId: session.messageContext?.id ?? null,
      sessionId: session.sessionId,
    };
    logger.info("CyberCheck: request provisionally admitted with an asynchronous review job", {
      jobId,
      ...observationContext,
      providerId: provider.id,
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
        const context = clientErrorContext(error);
        if (clientSignal?.aborted) {
          logger.debug("CyberCheck: stopped observing review job after client disconnect", {
            jobId,
            ...context,
          });
        } else {
          logger.warn("CyberCheck: review job observation ended without a terminal result", {
            jobId,
            ...context,
          });
        }
      });
    return;
  }

  const log =
    submission.decision === "deny" || submission.predicted_decision === "deny"
      ? logger.warn.bind(logger)
      : logger.info.bind(logger);
  log("CyberCheck: synchronous request review completed", {
    decision: submission.decision,
    predictedDecision: submission.predicted_decision,
    enforcementMode: submission.enforcement_mode,
    reason: submission.reason,
    coverage: submission.coverage,
    policyVersion: submission.policy_version,
    requestId: session.messageContext?.id ?? null,
    sessionId: session.sessionId,
    providerId: provider.id,
    mode: config.mode,
  });

  if (submission.decision === "deny" && config.mode === "enforce") {
    throw await localizedRequestReviewError("denied");
  }
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
  session: ProxySession,
  providerId: number
): void {
  logger.warn("CyberCheck: request review could not be completed", {
    phase,
    ...clientErrorContext(error),
    requestId: session.messageContext?.id ?? null,
    sessionId: session.sessionId,
    providerId,
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
  kind: "denied" | "unavailable"
): Promise<RequestReviewError> {
  try {
    const { getLocale } = await import("next-intl/server");
    const code =
      kind === "denied" ? ERROR_CODES.CYBER_CHECK_DENIED : ERROR_CODES.CYBER_CHECK_UNAVAILABLE;
    const message = await getErrorMessageServer(await getLocale(), code);
    return kind === "denied"
      ? RequestReviewError.denied(message)
      : RequestReviewError.unavailable(message);
  } catch {
    return kind === "denied" ? RequestReviewError.denied() : RequestReviewError.unavailable();
  }
}
