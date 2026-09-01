import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  delay: vi.fn(async () => undefined),
  getEnvConfig: vi.fn(),
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("node:timers/promises", () => ({
  default: { setTimeout: mocks.delay },
  setTimeout: mocks.delay,
}));
vi.mock("@/lib/config/env.schema", () => ({ getEnvConfig: mocks.getEnvConfig }));
vi.mock("@/lib/logger", () => ({ logger: mocks.logger }));

import { RequestReviewError } from "@/app/v1/_lib/proxy/errors";
import type {
  CyberCheckObservationHandle,
  CyberCheckObservationResult,
  ProxySession,
} from "@/app/v1/_lib/proxy/session";
import { admitFinalResponsesRequest } from "@/lib/cyber-check/admission";
import { cyberCheckEncodingCapacity } from "@/lib/cyber-check/capacity";

const message = {
  model: "gpt-test",
  input: [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Add a bounded parser test." }],
    },
  ],
  client_metadata: { "x-codex-installation-id": "installation-admission-test" },
  stream: true,
};

function session(): ProxySession {
  let observation: CyberCheckObservationHandle | null = null;
  return {
    headers: new Headers(),
    clientAbortSignal: null,
    messageContext: {
      id: 42,
      user: { id: 7 },
      key: { id: 9 },
    },
    sessionId: "session-admission-test",
    requestSequence: 3,
    clearCyberCheckObservation: () => {
      observation = null;
    },
    setCyberCheckObservation: (value) => {
      observation = value;
    },
    getCyberCheckObservation: () => observation,
  } as unknown as ProxySession;
}

async function awaitObservation(reviewSession: ProxySession): Promise<CyberCheckObservationResult> {
  const observation = reviewSession.getCyberCheckObservation();
  expect(observation).not.toBeNull();
  return observation!.completion;
}

function env(mode: "off" | "shadow" | "enforce") {
  return {
    CYBER_CHECK_MODE: mode,
    CYBER_CHECK_URL: "http://127.0.0.1:8090",
    CYBER_CHECK_GATEWAY_TOKEN: "gateway-token",
    CYBER_CHECK_ZSTD_MIN_BYTES: 256 * 1024,
    CYBER_CHECK_MAX_ENCODING_BYTES: 256 * 1024 * 1024,
  };
}

function finalResponse(
  decision: "allow" | "deny",
  options: {
    predictedDecision?: "allow" | "deny";
    enforcementMode?: "shadow" | "enforce";
    reason?: "fast_path" | "known_bypass_profile" | "active_restriction" | "reviewer_assessment";
    restriction?: {
      scope: "session" | "client_instance" | "principal";
      subject_id: string;
      reason: string;
      expires_at_ms?: number;
    };
    reviewDisposition?: "allowed" | "restricted" | "uncertain";
  } = {}
): Response {
  return new Response(
    JSON.stringify({
      status: "completed",
      decision,
      predicted_decision: options.predictedDecision ?? decision,
      enforcement_mode: options.enforcementMode ?? "enforce",
      reason: options.reason ?? "reviewer_assessment",
      ...(options.restriction ? { restriction: options.restriction } : {}),
      ...(options.reviewDisposition ? { review_disposition: options.reviewDisposition } : {}),
      coverage: "complete",
      policy_version: "policy-v1",
      reviewer_version: "reviewer-v1",
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function pendingResponse(): Response {
  return new Response(
    JSON.stringify({
      status: "pending",
      interim_decision: "allow",
      job_id: "019d0000-0000-7000-8000-000000000001",
      status_url: "/v1/review-jobs/019d0000-0000-7000-8000-000000000001",
    }),
    { status: 202, headers: { "content-type": "application/json" } }
  );
}

function jobResponse(status: "pending" | "completed" | "failed"): Response {
  const body =
    status === "pending"
      ? { status, job_id: "019d0000-0000-7000-8000-000000000001" }
      : status === "failed"
        ? {
            status,
            job_id: "019d0000-0000-7000-8000-000000000001",
            error_code: "reviewer_unavailable",
          }
        : {
            status,
            job_id: "019d0000-0000-7000-8000-000000000001",
            decision: "deny",
            predicted_decision: "deny",
            enforcement_mode: "enforce",
            reason: "reviewer_assessment",
            coverage: "complete",
            policy_version: "policy-v1",
            reviewer_version: "reviewer-v1",
          };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("CCH cyber-check admission seam", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getEnvConfig.mockReturnValue(env("shadow"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("is off by default and does not touch unrelated requests", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    mocks.getEnvConfig.mockReturnValue(env("off"));

    await admitFinalResponsesRequest({
      session: session(),
      provider: { id: 1, providerType: "codex" },
      requestPath: "/v1/responses",
      message,
      bodyString: JSON.stringify(message),
    });

    mocks.getEnvConfig.mockReturnValue(env("shadow"));
    await admitFinalResponsesRequest({
      session: session(),
      provider: { id: 1, providerType: "claude" },
      requestPath: "/v1/responses",
      message,
      bodyString: JSON.stringify(message),
    });
    await admitFinalResponsesRequest({
      session: session(),
      provider: { id: 1, providerType: "codex" },
      requestPath: "/v1/responses/compact",
      message,
      bodyString: JSON.stringify(message),
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("starts a shadow observation without waiting for its response", async () => {
    let releaseReview!: (response: Response) => void;
    const reviewResponse = new Promise<Response>((resolve) => {
      releaseReview = resolve;
    });
    const fetchMock = vi.fn(() => reviewResponse);
    vi.stubGlobal("fetch", fetchMock);
    const reviewSession = session();

    await expect(
      admitFinalResponsesRequest({
        session: reviewSession,
        provider: { id: 1, providerType: "codex" },
        requestPath: "/v1/responses",
        message,
        bodyString: JSON.stringify(message),
      })
    ).resolves.toBeUndefined();

    const observation = reviewSession.getCyberCheckObservation();
    expect(observation).not.toBeNull();
    const completion = vi.fn();
    void observation!.completion.then(completion);
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(completion).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(cyberCheckEncodingCapacity.snapshot()).toBeGreaterThan(0);

    releaseReview(
      finalResponse("allow", {
        predictedDecision: "deny",
        enforcementMode: "shadow",
        reviewDisposition: "restricted",
      })
    );
    const result = await observation!.completion;
    expect(result.status).toBe("recorded");
    expect(cyberCheckEncodingCapacity.snapshot()).toBe(0);
    const packet = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(packet.identity).toMatchObject({
      principal_id: "7",
      client_instance_id: "installation-admission-test",
      session_id: "session-admission-test",
      sequence: 3,
    });
    expect(result).toEqual({
      status: "recorded",
      correlation: {
        identity: packet.identity,
        upstreamProviderId: "1",
      },
    });
  });

  it("uses the stable scalar identity retained by a hedge attempt", async () => {
    const fetchMock = vi.fn(async () => finalResponse("allow"));
    vi.stubGlobal("fetch", fetchMock);
    const attempt = session();
    attempt.messageContext = null;
    attempt.getStableRequestIdentity = () => ({
      requestId: 42,
      principalId: 7,
    });

    await admitFinalResponsesRequest({
      session: attempt,
      provider: { id: 1, providerType: "codex" },
      requestPath: "/v1/responses",
      message,
      bodyString: JSON.stringify(message),
    });
    await expect(awaitObservation(attempt)).resolves.toMatchObject({ status: "recorded" });

    const packet = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(packet.identity).toMatchObject({
      principal_id: "7",
      client_instance_id: "installation-admission-test",
      session_id: "session-admission-test",
      sequence: 3,
    });
    expect(packet.identity.request_id).toMatch(/^42:/);
  });

  it("captures attempt identity before deferred shadow projection", async () => {
    const fetchMock = vi.fn(async () => finalResponse("allow"));
    vi.stubGlobal("fetch", fetchMock);
    const reviewSession = session();

    await admitFinalResponsesRequest({
      session: reviewSession,
      provider: { id: 1, providerType: "codex" },
      requestPath: "/v1/responses",
      message,
      bodyString: JSON.stringify(message),
    });
    reviewSession.messageContext = {
      id: 99,
      user: { id: 88 },
      key: { id: 77 },
    };
    reviewSession.sessionId = "later-session";
    reviewSession.requestSequence = 4;

    await expect(awaitObservation(reviewSession)).resolves.toMatchObject({ status: "recorded" });
    const packet = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(packet.identity).toMatchObject({
      principal_id: "7",
      session_id: "session-admission-test",
      sequence: 3,
    });
    expect(packet.identity.request_id).toMatch(/^42:/);
  });

  it("enforces a synchronous denial as a distinct local gateway outcome", async () => {
    mocks.getEnvConfig.mockReturnValue(env("enforce"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => finalResponse("deny", { reason: "known_bypass_profile" }))
    );

    const error = await admitFinalResponsesRequest({
      session: session(),
      provider: { id: 1, providerType: "codex" },
      requestPath: "/v1/responses",
      message,
      bodyString: JSON.stringify(message),
    }).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(RequestReviewError);
    expect(error).toMatchObject({ code: "gateway_cyber_restricted", statusCode: 403 });
  });

  it("includes the retry timestamp for a temporary installation restriction", async () => {
    mocks.getEnvConfig.mockReturnValue(env("enforce"));
    const expiresAtMs = Date.parse("2030-01-02T03:04:05.000Z");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        finalResponse("deny", {
          reason: "active_restriction",
          restriction: {
            scope: "client_instance",
            subject_id: "installation-admission-test",
            reason: "provider_cyber_policy",
            expires_at_ms: expiresAtMs,
          },
        })
      )
    );

    const error = await admitFinalResponsesRequest({
      session: session(),
      provider: { id: 1, providerType: "codex" },
      requestPath: "/v1/responses",
      message,
      bodyString: JSON.stringify(message),
    }).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(RequestReviewError);
    expect((error as Error).message).toContain("Retry after 2030-01-02T03:04:05.000Z");
  });

  it("ignores every service denial while the gateway is in absolute shadow", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        finalResponse("deny", {
          enforcementMode: "shadow",
          reason: "active_restriction",
          restriction: {
            scope: "client_instance",
            subject_id: "installation-admission-test",
            reason: "provider_cyber_policy",
          },
        })
      )
    );

    const reviewSession = session();
    await expect(
      admitFinalResponsesRequest({
        session: reviewSession,
        provider: { id: 1, providerType: "codex" },
        requestPath: "/v1/responses",
        message,
        bodyString: JSON.stringify(message),
      })
    ).resolves.toBeUndefined();
    await expect(awaitObservation(reviewSession)).resolves.toMatchObject({ status: "recorded" });
  });

  it("fails open for all service capacity outcomes in shadow and closed in enforce", async () => {
    for (const serviceCode of ["cyber_check_capacity", "reviewer_capacity", "review_queue_full"]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          Response.json(
            { error: { code: serviceCode, message: "capacity exhausted" } },
            { status: 503 }
          )
        )
      );

      const shadowSession = session();
      await expect(
        admitFinalResponsesRequest({
          session: shadowSession,
          provider: { id: 1, providerType: "codex" },
          requestPath: "/v1/responses",
          message,
          bodyString: JSON.stringify(message),
        })
      ).resolves.toBeUndefined();
      await expect(awaitObservation(shadowSession)).resolves.toEqual({ status: "capture_gap" });

      mocks.getEnvConfig.mockReturnValue(env("enforce"));
      const error = await admitFinalResponsesRequest({
        session: session(),
        provider: { id: 1, providerType: "codex" },
        requestPath: "/v1/responses",
        message,
        bodyString: JSON.stringify(message),
      }).catch((value: unknown) => value);
      expect(error).toMatchObject({ code: "cyber_check_capacity", statusCode: 503 });
      mocks.getEnvConfig.mockReturnValue(env("shadow"));
    }
  });

  it("fails open on local encoding exhaustion in shadow and closed in enforce", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    mocks.getEnvConfig.mockReturnValue({
      ...env("shadow"),
      CYBER_CHECK_MAX_ENCODING_BYTES: 64 * 1024,
    });

    const shadowSession = session();
    await expect(
      admitFinalResponsesRequest({
        session: shadowSession,
        provider: { id: 1, providerType: "codex" },
        requestPath: "/v1/responses",
        message,
        bodyString: JSON.stringify(message),
      })
    ).resolves.toBeUndefined();
    await expect(awaitObservation(shadowSession)).resolves.toEqual({ status: "capture_gap" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(cyberCheckEncodingCapacity.snapshot()).toBe(0);

    mocks.getEnvConfig.mockReturnValue({
      ...env("enforce"),
      CYBER_CHECK_MAX_ENCODING_BYTES: 64 * 1024,
    });
    const error = await admitFinalResponsesRequest({
      session: session(),
      provider: { id: 1, providerType: "codex" },
      requestPath: "/v1/responses",
      message,
      bodyString: JSON.stringify(message),
    }).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "cyber_check_capacity", statusCode: 503 });
    expect(cyberCheckEncodingCapacity.snapshot()).toBe(0);
  });

  it("fails open in shadow and closed in enforce when the review service is unavailable", async () => {
    const fetchMock = vi.fn(async () => new Response("unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    const shadowSession = session();
    await expect(
      admitFinalResponsesRequest({
        session: shadowSession,
        provider: { id: 1, providerType: "codex" },
        requestPath: "/v1/responses",
        message,
        bodyString: JSON.stringify(message),
      })
    ).resolves.toBeUndefined();
    await expect(awaitObservation(shadowSession)).resolves.toEqual({ status: "capture_gap" });

    mocks.getEnvConfig.mockReturnValue(env("enforce"));
    const error = await admitFinalResponsesRequest({
      session: session(),
      provider: { id: 1, providerType: "codex" },
      requestPath: "/v1/responses",
      message,
      bodyString: JSON.stringify(message),
    }).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(RequestReviewError);
    expect(error).toMatchObject({ code: "cyber_check_unavailable", statusCode: 503 });
  });

  it("provisionally admits a 202 response and observes the queryable job to completion", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(pendingResponse())
      .mockResolvedValueOnce(jobResponse("pending"))
      .mockResolvedValueOnce(jobResponse("completed"));
    vi.stubGlobal("fetch", fetchMock);

    const reviewSession = session();
    await expect(
      admitFinalResponsesRequest({
        session: reviewSession,
        provider: { id: 1, providerType: "codex" },
        requestPath: "/v1/responses",
        message,
        bodyString: JSON.stringify(message),
      })
    ).resolves.toBeUndefined();
    await expect(awaitObservation(reviewSession)).resolves.toMatchObject({ status: "recorded" });

    await vi.waitFor(() =>
      expect(mocks.logger.warn).toHaveBeenCalledWith(
        "CyberCheck: asynchronous review job completed",
        expect.objectContaining({
          jobId: "019d0000-0000-7000-8000-000000000001",
          decision: "deny",
          sessionId: "session-admission-test",
        })
      )
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(mocks.delay).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      "http://127.0.0.1:8090/v1/review-jobs/019d0000-0000-7000-8000-000000000001"
    );
  });

  it("contains invalid service configuration according to gateway mode", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    mocks.getEnvConfig.mockReturnValue({
      ...env("shadow"),
      CYBER_CHECK_URL: "http://review.internal.example",
    });

    const shadowSession = session();
    await expect(
      admitFinalResponsesRequest({
        session: shadowSession,
        provider: { id: 1, providerType: "codex" },
        requestPath: "/v1/responses",
        message,
        bodyString: JSON.stringify(message),
      })
    ).resolves.toBeUndefined();
    await expect(awaitObservation(shadowSession)).resolves.toEqual({ status: "capture_gap" });
    expect(fetchMock).not.toHaveBeenCalled();

    mocks.getEnvConfig.mockReturnValue({
      ...env("enforce"),
      CYBER_CHECK_URL: "http://review.internal.example",
    });
    const error = await admitFinalResponsesRequest({
      session: session(),
      provider: { id: 1, providerType: "codex" },
      requestPath: "/v1/responses",
      message,
      bodyString: JSON.stringify(message),
    }).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(RequestReviewError);
    expect(error).toMatchObject({ code: "cyber_check_unavailable", statusCode: 503 });
  });

  it("contains shadow client cancellation as a capture gap", async () => {
    const controller = new AbortController();
    controller.abort(new Error("client disconnected"));
    const cancelledSession = session();
    cancelledSession.clientAbortSignal = controller.signal;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw controller.signal.reason;
      })
    );

    await expect(
      admitFinalResponsesRequest({
        session: cancelledSession,
        provider: { id: 1, providerType: "codex" },
        requestPath: "/v1/responses",
        message,
        bodyString: JSON.stringify(message),
      })
    ).resolves.toBeUndefined();
    await expect(awaitObservation(cancelledSession)).resolves.toEqual({ status: "capture_gap" });
    expect(cyberCheckEncodingCapacity.snapshot()).toBe(0);
    expect(mocks.logger.warn).not.toHaveBeenCalledWith(
      "CyberCheck: request review could not be completed",
      expect.anything()
    );
  });

  it("preserves client cancellation in enforce mode", async () => {
    mocks.getEnvConfig.mockReturnValue(env("enforce"));
    const controller = new AbortController();
    controller.abort(new Error("client disconnected"));
    const cancelledSession = session();
    cancelledSession.clientAbortSignal = controller.signal;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw controller.signal.reason;
      })
    );

    await expect(
      admitFinalResponsesRequest({
        session: cancelledSession,
        provider: { id: 1, providerType: "codex" },
        requestPath: "/v1/responses",
        message,
        bodyString: JSON.stringify(message),
      })
    ).rejects.toThrow("client disconnected");
    expect(cyberCheckEncodingCapacity.snapshot()).toBe(0);
  });
});
