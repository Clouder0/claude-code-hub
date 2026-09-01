import type { CyberCheckAdmissionCorrelation, ProxySession } from "@/app/v1/_lib/proxy/session";
import { getEnvConfig } from "@/lib/config/env.schema";
import { logger } from "@/lib/logger";
import { type CyberCheckClientError, reportRequestOutcome } from "./client";
import { resolveCyberCheckConfig } from "./config";

type CorrelatedSession = Pick<ProxySession, "getCyberCheckObservation">;

/**
 * Releases candidate evidence after the admitted upstream request has a clean terminal outcome.
 * This is deliberately best effort: a missed report only leaves the bounded TTL cleanup path.
 */
export async function reportCleanRequestOutcomeBestEffort(
  session: CorrelatedSession
): Promise<void> {
  const observation = session.getCyberCheckObservation();
  if (!observation) return;

  let correlation: CyberCheckAdmissionCorrelation | undefined;
  try {
    const result = await observation.completion;
    if (result.status === "capture_gap") {
      logger.debug("CyberCheck: clean request outcome skipped after observation capture gap");
      return;
    }
    correlation = result.correlation;

    const config = resolveCyberCheckConfig(getEnvConfig());
    if (!config) return;

    await reportRequestOutcome(config, {
      schema_version: "cyber-check.request-outcome.v1",
      identity: correlation.identity,
      outcome: "clean",
    });

    logger.debug("CyberCheck: clean request outcome reported", {
      requestId: correlation.identity.request_id,
      sessionId: correlation.identity.session_id,
    });
  } catch (error) {
    logger.warn("CyberCheck: clean request outcome could not be reported", {
      ...clientErrorContext(error),
      ...(correlation
        ? {
            requestId: correlation.identity.request_id,
            sessionId: correlation.identity.session_id,
          }
        : {}),
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
