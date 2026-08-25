import type { ProxySession } from "@/app/v1/_lib/proxy/session";
import { getEnvConfig } from "@/lib/config/env.schema";
import { logger } from "@/lib/logger";
import type { PolicyRejectionCode } from "@/lib/security/security-signals";
import { type CyberCheckClientError, reportProviderEvent } from "./client";
import { resolveCyberCheckConfig } from "./config";

type CorrelatedSession = Pick<ProxySession, "getCyberCheckAdmissionCorrelation">;

/**
 * Reports only an authoritative upstream cyber rejection that can be joined to a successful
 * admission. Local CCH containment remains independent and authoritative if this best-effort
 * cross-service report fails.
 */
export async function reportProviderPolicyEventBestEffort(
  session: CorrelatedSession,
  policy: PolicyRejectionCode
): Promise<void> {
  if (policy !== "cyber_policy") return;

  const correlation = session.getCyberCheckAdmissionCorrelation();
  if (!correlation) return;

  try {
    const config = resolveCyberCheckConfig(getEnvConfig());
    if (!config) return;

    await reportProviderEvent(config, {
      schema_version: "cyber-check.provider-event.v1",
      identity: correlation.identity,
      upstream_provider_id: correlation.upstreamProviderId,
      event: {
        type: "policy_rejection",
        code: "cyber_policy",
      },
    });

    logger.info("CyberCheck: authoritative provider cyber event reported", {
      requestId: correlation.identity.request_id,
      sessionId: correlation.identity.session_id,
      upstreamProviderId: correlation.upstreamProviderId,
    });
  } catch (error) {
    logger.warn("CyberCheck: authoritative provider cyber event could not be reported", {
      ...clientErrorContext(error),
      requestId: correlation.identity.request_id,
      sessionId: correlation.identity.session_id,
      upstreamProviderId: correlation.upstreamProviderId,
    });
  }
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
