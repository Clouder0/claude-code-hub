import type {
  CyberCheckAdmissionCorrelation,
  CyberCheckObservationHandle,
  ProxySession,
} from "@/app/v1/_lib/proxy/session";
import { getEnvConfig } from "@/lib/config/env.schema";
import { logger } from "@/lib/logger";
import { disableUserForCyberCheckContainment } from "@/lib/security/policy-containment";
import type { PolicyRejectionCode } from "@/lib/security/security-signals";
import { type CyberCheckClientError, reportProviderEvent } from "./client";
import { type CyberCheckConfig, resolveCyberCheckConfig } from "./config";
import type { ProviderContainment } from "./types";

type CorrelatedSession = Pick<ProxySession, "getCyberCheckObservation">;

/**
 * Reports only an authoritative upstream cyber rejection that can be joined to a successful
 * admission. Cyber Check owns cyber strikes and restrictions; this deliberately remains one
 * measured best-effort attempt, so a failed report can mean missed containment.
 */
export async function reportProviderPolicyEventBestEffort(
  session: CorrelatedSession,
  policy: PolicyRejectionCode
): Promise<ProviderContainment | null> {
  if (policy !== "cyber_policy") return null;

  const observation = session.getCyberCheckObservation();
  if (!observation) return null;

  let config: CyberCheckConfig;
  try {
    const resolved = resolveCyberCheckConfig(getEnvConfig());
    if (!resolved) return null;
    config = resolved;
  } catch (error) {
    logger.warn("CyberCheck: authoritative provider cyber event could not be reported", {
      ...clientErrorContext(error),
    });
    return null;
  }

  const report = reportProviderEventAfterObservation(observation, config);
  if (config.mode === "shadow") {
    void report;
    return null;
  }
  return report;
}

async function reportProviderEventAfterObservation(
  observation: CyberCheckObservationHandle,
  config: CyberCheckConfig
): Promise<ProviderContainment | null> {
  let correlation: CyberCheckAdmissionCorrelation | undefined;
  try {
    const result = await observation.completion;
    if (result.status === "capture_gap") {
      logger.warn(
        "CyberCheck: authoritative provider cyber event skipped after observation capture gap"
      );
      return null;
    }
    correlation = result.correlation;

    const containment = await reportProviderEvent(config, {
      schema_version: "cyber-check.provider-event.v1",
      identity: correlation.identity,
      enforcement_mode: config.mode,
      upstream_provider_id: correlation.upstreamProviderId,
      event: {
        type: "policy_rejection",
        code: "cyber_policy",
      },
    });

    if (config.mode === "enforce" && containment.principal_restricted) {
      const userId = Number(correlation.identity.principal_id);
      if (Number.isSafeInteger(userId) && userId > 0) {
        await disableUserForCyberCheckContainment(userId);
      } else {
        logger.error("CyberCheck: principal restriction could not be mapped to a CCH user", {
          principalId: correlation.identity.principal_id,
        });
      }
    }

    logger.info("CyberCheck: authoritative provider cyber event reported", {
      requestId: correlation.identity.request_id,
      sessionId: correlation.identity.session_id,
      upstreamProviderId: correlation.upstreamProviderId,
      principalStrikes: containment.principal_strikes,
      clientInstanceRestricted: containment.client_instance_restricted,
      principalRestricted: containment.principal_restricted,
      mode: config.mode,
    });
    return containment;
  } catch (error) {
    logger.warn("CyberCheck: authoritative provider cyber event could not be reported", {
      ...clientErrorContext(error),
      ...(correlation
        ? {
            requestId: correlation.identity.request_id,
            sessionId: correlation.identity.session_id,
            upstreamProviderId: correlation.upstreamProviderId,
          }
        : {}),
    });
    return null;
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
