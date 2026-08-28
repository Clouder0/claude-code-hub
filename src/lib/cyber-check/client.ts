import { promisify } from "node:util";
import { constants as zlibConstants, zstdCompress } from "node:zlib";
import type { CyberCheckConfig } from "./config";
import type {
  ProviderContainment,
  ProviderEventEnvelope,
  RequestOutcomeEnvelope,
  ReviewFinalDecision,
  ReviewJob,
  ReviewRequestEnvelope,
  ReviewSubmission,
} from "./types";

const SUBMISSION_TIMEOUT_MS = 25_000;
const JOB_READ_TIMEOUT_MS = 5_000;
const EVENT_REPORT_TIMEOUT_MS = 5_000;
// Admission optimizes transfer cost, not archival ratio; keep compression off the high-CPU levels.
const ZSTD_COMPRESSION_LEVEL = 1;
const compressZstd = promisify(zstdCompress);

type FetchImplementation = typeof globalThis.fetch;

export class CyberCheckClientError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly serviceCode?: string
  ) {
    super(message);
    this.name = "CyberCheckClientError";
  }
}

interface RequestOptions {
  signal?: AbortSignal | null;
  fetchImpl?: FetchImplementation;
}

export async function submitReview(
  config: CyberCheckConfig,
  packet: ReviewRequestEnvelope,
  options: RequestOptions = {}
): Promise<ReviewSubmission> {
  const packetJson = JSON.stringify(packet);
  const packetBytes = Buffer.byteLength(packetJson);
  const headers: Record<string, string> = {
    authorization: `Bearer ${config.gatewayToken}`,
    "content-type": "application/json",
    "x-cyber-check-decoded-length": String(packetBytes),
  };
  let body: string | Uint8Array<ArrayBuffer> = packetJson;
  if (packetBytes >= config.zstdMinBytes) {
    const compressed = await compressZstd(packetJson, {
      params: { [zlibConstants.ZSTD_c_compressionLevel]: ZSTD_COMPRESSION_LEVEL },
    });
    if (compressed.byteLength < packetBytes) {
      body = new Uint8Array(
        compressed.buffer as ArrayBuffer,
        compressed.byteOffset,
        compressed.byteLength
      );
      headers["content-encoding"] = "zstd";
    }
  }
  headers["content-length"] = String(
    typeof body === "string" ? Buffer.byteLength(body) : body.byteLength
  );

  const response = await (options.fetchImpl ?? globalThis.fetch)(
    new URL("/v1/request-reviews", config.baseUrl),
    {
      method: "POST",
      headers,
      body,
      signal: boundedSignal(options.signal, SUBMISSION_TIMEOUT_MS),
    }
  );

  if (response.status !== 200 && response.status !== 202) {
    throw await responseError(response);
  }

  const payload: unknown = await response.json();
  return response.status === 200
    ? parseCompletedSubmission(payload)
    : parsePendingSubmission(payload);
}

export async function getReviewJob(
  config: CyberCheckConfig,
  jobId: string,
  options: RequestOptions = {}
): Promise<ReviewJob> {
  const response = await (options.fetchImpl ?? globalThis.fetch)(
    new URL(`/v1/review-jobs/${encodeURIComponent(jobId)}`, config.baseUrl),
    {
      headers: { authorization: `Bearer ${config.gatewayToken}` },
      signal: boundedSignal(options.signal, JOB_READ_TIMEOUT_MS),
    }
  );
  if (response.status !== 200) throw await responseError(response);
  return parseJob(await response.json());
}

export async function reportProviderEvent(
  config: CyberCheckConfig,
  event: ProviderEventEnvelope,
  options: RequestOptions = {}
): Promise<ProviderContainment> {
  const response = await (options.fetchImpl ?? globalThis.fetch)(
    new URL("/v1/provider-events", config.baseUrl),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.gatewayToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(event),
      signal: boundedSignal(options.signal, EVENT_REPORT_TIMEOUT_MS),
    }
  );
  if (response.status !== 200) throw await responseError(response);
  return parseProviderContainment(await response.json());
}

export async function reinstatePrincipal(
  config: CyberCheckConfig,
  principalId: string,
  options: RequestOptions = {}
): Promise<void> {
  const response = await (options.fetchImpl ?? globalThis.fetch)(
    new URL(`/v1/principals/${encodeURIComponent(principalId)}/reinstatement`, config.baseUrl),
    {
      method: "POST",
      headers: { authorization: `Bearer ${config.gatewayToken}` },
      signal: boundedSignal(options.signal, EVENT_REPORT_TIMEOUT_MS),
    }
  );
  if (response.status !== 204) throw await responseError(response);
}

export async function reportRequestOutcome(
  config: CyberCheckConfig,
  outcome: RequestOutcomeEnvelope,
  options: RequestOptions = {}
): Promise<void> {
  const response = await (options.fetchImpl ?? globalThis.fetch)(
    new URL("/v1/request-outcomes", config.baseUrl),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.gatewayToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(outcome),
      signal: boundedSignal(options.signal, EVENT_REPORT_TIMEOUT_MS),
    }
  );
  if (response.status !== 204) throw await responseError(response);
}

function parseCompletedSubmission(payload: unknown): ReviewSubmission {
  const object = requireRecord(payload, "completed review response");
  if (object.status !== "completed") {
    throw new CyberCheckClientError("review service returned an invalid completed response");
  }
  return { status: "completed", ...parseFinalDecision(object) };
}

function parsePendingSubmission(payload: unknown): ReviewSubmission {
  const object = requireRecord(payload, "pending review response");
  if (
    object.status !== "pending" ||
    object.interim_decision !== "allow" ||
    typeof object.job_id !== "string" ||
    object.job_id.length === 0 ||
    typeof object.status_url !== "string"
  ) {
    throw new CyberCheckClientError("review service returned an invalid pending response");
  }
  return {
    status: "pending",
    interim_decision: "allow",
    job_id: object.job_id,
    status_url: object.status_url,
  };
}

function parseJob(payload: unknown): ReviewJob {
  const object = requireRecord(payload, "review job response");
  if (typeof object.job_id !== "string" || object.job_id.length === 0) {
    throw new CyberCheckClientError("review service returned a job without an id");
  }
  if (object.status === "pending") return { status: "pending", job_id: object.job_id };
  if (object.status === "completed") {
    return { status: "completed", job_id: object.job_id, ...parseFinalDecision(object) };
  }
  if (object.status === "failed" && typeof object.error_code === "string") {
    return { status: "failed", job_id: object.job_id, error_code: object.error_code };
  }
  throw new CyberCheckClientError("review service returned an invalid job state");
}

function parseFinalDecision(object: Record<string, unknown>): ReviewFinalDecision {
  if (
    !isOneOf(object.decision, ["allow", "deny"]) ||
    !isOneOf(object.predicted_decision, ["allow", "deny"]) ||
    !isOneOf(object.enforcement_mode, ["shadow", "enforce"]) ||
    !isOneOf(object.reason, [
      "fast_path",
      "known_bypass_profile",
      "active_restriction",
      "reviewer_assessment",
      "reviewer_unavailable",
    ]) ||
    !isOneOf(object.coverage, ["complete", "partial"]) ||
    typeof object.policy_version !== "string" ||
    typeof object.reviewer_version !== "string"
  ) {
    throw new CyberCheckClientError("review service returned an invalid final decision");
  }
  const reviewDisposition =
    object.review_disposition === undefined
      ? undefined
      : requireOneOf(object.review_disposition, ["allowed", "restricted", "uncertain"]);
  const restriction =
    object.restriction === undefined ? undefined : parseRestriction(object.restriction);
  return {
    decision: object.decision,
    predicted_decision: object.predicted_decision,
    enforcement_mode: object.enforcement_mode,
    reason: object.reason,
    ...(reviewDisposition ? { review_disposition: reviewDisposition } : {}),
    ...(restriction ? { restriction } : {}),
    coverage: object.coverage,
    policy_version: object.policy_version,
    reviewer_version: object.reviewer_version,
  };
}

function parseRestriction(value: unknown): NonNullable<ReviewFinalDecision["restriction"]> {
  const object = requireRecord(value, "active restriction");
  const scope = requireOneOf(object.scope, ["session", "client_instance", "principal"]);
  if (typeof object.subject_id !== "string" || typeof object.reason !== "string") {
    throw new CyberCheckClientError("review service returned an invalid active restriction");
  }
  if (
    object.expires_at_ms !== undefined &&
    (!Number.isSafeInteger(object.expires_at_ms) || Number(object.expires_at_ms) < 0)
  ) {
    throw new CyberCheckClientError("review service returned an invalid restriction expiry");
  }
  return {
    scope,
    subject_id: object.subject_id,
    reason: object.reason,
    ...(object.expires_at_ms === undefined ? {} : { expires_at_ms: Number(object.expires_at_ms) }),
  };
}

function parseProviderContainment(payload: unknown): ProviderContainment {
  const object = requireRecord(payload, "provider containment response");
  if (
    !Number.isSafeInteger(object.principal_strikes) ||
    Number(object.principal_strikes) < 0 ||
    typeof object.session_restricted !== "boolean" ||
    typeof object.client_instance_restricted !== "boolean" ||
    typeof object.principal_restricted !== "boolean"
  ) {
    throw new CyberCheckClientError("review service returned invalid provider containment");
  }
  return {
    principal_strikes: Number(object.principal_strikes),
    session_restricted: object.session_restricted,
    client_instance_restricted: object.client_instance_restricted,
    principal_restricted: object.principal_restricted,
  };
}

async function responseError(response: Response): Promise<CyberCheckClientError> {
  let serviceCode: string | undefined;
  try {
    const payload = requireRecord(await response.json(), "review service error");
    const detail = asRecord(payload.error);
    if (detail && typeof detail.code === "string") serviceCode = detail.code;
  } catch {
    serviceCode = undefined;
  }
  return new CyberCheckClientError(
    `review service returned HTTP ${response.status}`,
    response.status,
    serviceCode
  );
}

function boundedSignal(signal: AbortSignal | null | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  const record = asRecord(value);
  if (!record) throw new CyberCheckClientError(`${name} is not a JSON object`);
  return record;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isOneOf<const T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function requireOneOf<const T extends string>(value: unknown, values: readonly T[]): T {
  if (!isOneOf(value, values)) {
    throw new CyberCheckClientError("review service returned an invalid enum value");
  }
  return value;
}
