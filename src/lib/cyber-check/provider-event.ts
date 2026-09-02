import type {
  CyberCheckAdmissionCorrelation,
  CyberCheckObservationHandle,
  ProxySession,
} from "@/app/v1/_lib/proxy/session";
import { getEnvConfig } from "@/lib/config/env.schema";
import { logger } from "@/lib/logger";
import {
  blockCyberInstallation,
  blockCyberPrincipal,
  disableUserForCyberCheckContainment,
} from "@/lib/security/policy-containment";
import type { PolicyRejectionCode } from "@/lib/security/security-signals";
import { type CyberCheckClientError, reportProviderEvent } from "./client";
import { type CyberCheckConfig, resolveCyberCheckConfig } from "./config";
import type { ProviderContainment } from "./types";

type CorrelatedSession = Pick<ProxySession, "getCyberCheckObservation" | "messageContext">;

/**
 * Reports only an authoritative upstream cyber rejection that can be joined to a successful
 * admission. Cyber Check owns cyber strikes and restrictions. Reviewer observe/shadow controls
 * predictive review only; this provider-confirmed event remains actionable.
 */
export async function reportProviderPolicyEventBestEffort(
  session: CorrelatedSession,
  policy: PolicyRejectionCode
): Promise<ProviderContainment | null> {
  const observation = session.getCyberCheckObservation();
  if (!observation) {
    await markBioCentralStatus(session, policy, "unconfirmed", "missing_observation");
    return null;
  }

  let config: CyberCheckConfig;
  try {
    const resolved = resolveCyberCheckConfig(getEnvConfig());
    if (!resolved) {
      await markBioCentralStatus(session, policy, "unconfirmed", "integration_off");
      return null;
    }
    config = resolved;
  } catch (error) {
    await markBioCentralStatus(session, policy, "unconfirmed", "configuration_error");
    logger.warn("CyberCheck: authoritative provider cyber event could not be reported", {
      ...clientErrorContext(error),
    });
    return null;
  }

  return reportProviderEventAfterObservation(observation, config, session, policy);
}

async function reportProviderEventAfterObservation(
  observation: CyberCheckObservationHandle,
  config: CyberCheckConfig,
  session: CorrelatedSession,
  policy: PolicyRejectionCode
): Promise<ProviderContainment | null> {
  let correlation: CyberCheckAdmissionCorrelation | undefined;
  try {
    const result = await observation.completion;
    if (result.status === "capture_gap") {
      await markBioCentralStatus(session, policy, "unconfirmed", "capture_gap");
      logger.warn(
        "CyberCheck: authoritative provider cyber event skipped after observation capture gap"
      );
      return null;
    }
    correlation = result.correlation;

    const containment = await reportProviderEvent(config, {
      schema_version: "cyber-check.provider-event.v2",
      identity: correlation.identity,
      // This is an upstream-confirmed policy outcome, not a reviewer prediction. Keep it
      // actionable even while the request-review path is running in observe/shadow mode.
      enforcement_mode: "enforce",
      upstream_provider_id: correlation.upstreamProviderId,
      event: {
        type: "policy_rejection",
        code: policy,
      },
    });

    if (containment.client_instance_restricted && correlation.identity.client_instance_id) {
      await blockCyberInstallation(
        correlation.identity.principal_id,
        correlation.identity.client_instance_id,
        // Permanence follows the installation's own tier from the central
        // response; bio policy is permanently blocking by definition. A first
        // cyber hit stays a short temporary block even if the principal is one
        // strike away from its own threshold.
        policy === "bio_policy" || containment.client_instance_restricted_indefinite
      );
    }
    await markBioCentralStatus(session, policy, "confirmed");
    if (containment.principal_restricted) {
      await blockCyberPrincipal(correlation.identity.principal_id);
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
    await markBioCentralStatus(
      session,
      policy,
      "unconfirmed",
      error instanceof Error ? error.name : "unknown_error"
    );
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

async function markBioCentralStatus(
  session: CorrelatedSession,
  policy: PolicyRejectionCode,
  status: "confirmed" | "unconfirmed",
  error?: string
): Promise<void> {
  const messageRequestId = session.messageContext?.id;
  if (policy !== "bio_policy" || messageRequestId == null) return;
  try {
    const { updateSecurityEventCentralStatus } = await import("@/repository/security-events");
    await updateSecurityEventCentralStatus(messageRequestId, policy, status, error);
  } catch (statusError) {
    logger.error("CyberCheck: bio central status could not be persisted", {
      messageRequestId,
      status,
      errorType: statusError instanceof Error ? statusError.name : "UnknownError",
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
