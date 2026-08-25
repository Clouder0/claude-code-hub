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
import type { ProxySession } from "@/app/v1/_lib/proxy/session";
import { admitFinalResponsesRequest } from "@/lib/cyber-check/admission";

const message = {
  model: "gpt-test",
  input: [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Add a bounded parser test." }],
    },
  ],
  stream: true,
};

function session(): ProxySession {
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
  } as unknown as ProxySession;
}

function env(mode: "off" | "shadow" | "enforce") {
  return {
    CYBER_CHECK_MODE: mode,
    CYBER_CHECK_URL: "http://127.0.0.1:8090",
    CYBER_CHECK_GATEWAY_TOKEN: "gateway-token",
    CYBER_CHECK_GATEWAY_ID: "cch-test",
    CYBER_CHECK_ZSTD_MIN_BYTES: 256 * 1024,
  };
}

function finalResponse(decision: "allow" | "deny"): Response {
  return new Response(
    JSON.stringify({
      status: "completed",
      decision,
      predicted_decision: decision,
      enforcement_mode: "enforce",
      reason: "reviewer_assessment",
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

  it("sends the final body in shadow mode but does not enforce a denial", async () => {
    const fetchMock = vi.fn(async () => finalResponse("deny"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      admitFinalResponsesRequest({
        session: session(),
        provider: { id: 1, providerType: "codex" },
        requestPath: "/v1/responses",
        message,
        bodyString: JSON.stringify(message),
      })
    ).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledOnce();
    const packet = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(packet.identity).toMatchObject({
      gateway: "cch-test",
      principal_id: "7",
      credential_id: "9",
      session_id: "session-admission-test",
      sequence: 3,
    });
  });

  it("enforces a synchronous denial as a distinct local gateway outcome", async () => {
    mocks.getEnvConfig.mockReturnValue(env("enforce"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => finalResponse("deny"))
    );

    const error = await admitFinalResponsesRequest({
      session: session(),
      provider: { id: 1, providerType: "codex" },
      requestPath: "/v1/responses",
      message,
      bodyString: JSON.stringify(message),
    }).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(RequestReviewError);
    expect(error).toMatchObject({ code: "cyber_check_denied", statusCode: 403 });
  });

  it("fails open in shadow and closed in enforce when the review service is unavailable", async () => {
    const fetchMock = vi.fn(async () => new Response("unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      admitFinalResponsesRequest({
        session: session(),
        provider: { id: 1, providerType: "codex" },
        requestPath: "/v1/responses",
        message,
        bodyString: JSON.stringify(message),
      })
    ).resolves.toBeUndefined();

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

    await expect(
      admitFinalResponsesRequest({
        session: session(),
        provider: { id: 1, providerType: "codex" },
        requestPath: "/v1/responses",
        message,
        bodyString: JSON.stringify(message),
      })
    ).resolves.toBeUndefined();

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

    await expect(
      admitFinalResponsesRequest({
        session: session(),
        provider: { id: 1, providerType: "codex" },
        requestPath: "/v1/responses",
        message,
        bodyString: JSON.stringify(message),
      })
    ).resolves.toBeUndefined();
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

  it("does not reinterpret client cancellation as a review service failure", async () => {
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
    expect(mocks.logger.warn).not.toHaveBeenCalledWith(
      "CyberCheck: request review could not be completed",
      expect.anything()
    );
  });
});
