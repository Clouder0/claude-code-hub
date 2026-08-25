import { describe, expect, it, vi } from "vitest";
import { CyberCheckClientError, getReviewJob, submitReview } from "@/lib/cyber-check/client";
import { resolveCyberCheckConfig } from "@/lib/cyber-check/config";
import type { ReviewRequestEnvelope } from "@/lib/cyber-check/types";

const config = {
  mode: "shadow" as const,
  baseUrl: new URL("http://127.0.0.1:8090"),
  gatewayToken: "gateway-test-token",
  gatewayId: "cch-test",
};

const packet: ReviewRequestEnvelope = {
  schema_version: "cyber-check.request-review.v1",
  identity: {
    gateway: "cch-test",
    request_id: "42:digest",
    principal_id: "7",
    credential_id: "9",
    session_id: "session-client-test",
    sequence: 1,
  },
  source: {
    protocol: "openai.responses",
    profile: "codex-http-sse",
    model: "gpt-test",
    context_state: { type: "self_contained" },
    body_sha256: "a".repeat(64),
    body_bytes: 10,
  },
  instructions: [],
  items: [],
  capabilities: [],
  coverage: { notices: [] },
};

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("cyber-check client", () => {
  it("parses a synchronous final result and authenticates the request", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        {
          status: "completed",
          decision: "allow",
          predicted_decision: "allow",
          enforcement_mode: "shadow",
          reason: "fast_path",
          coverage: "complete",
          policy_version: "policy-v1",
          reviewer_version: "reviewer-v1",
        },
        200
      )
    );

    const result = await submitReview(config, packet, {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result).toMatchObject({ status: "completed", decision: "allow" });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe("http://127.0.0.1:8090/v1/request-reviews");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer gateway-test-token");
    expect(JSON.parse(String(init?.body))).toEqual(packet);
  });

  it("uses the normal POST-created job and GET status resource", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            status: "pending",
            interim_decision: "allow",
            job_id: "019d0000-0000-7000-8000-000000000001",
            status_url: "/v1/review-jobs/019d0000-0000-7000-8000-000000000001",
          },
          202
        )
      )
      .mockResolvedValueOnce(
        jsonResponse(
          {
            status: "completed",
            job_id: "019d0000-0000-7000-8000-000000000001",
            decision: "deny",
            predicted_decision: "deny",
            enforcement_mode: "enforce",
            reason: "reviewer_assessment",
            coverage: "complete",
            policy_version: "policy-v1",
            reviewer_version: "reviewer-v1",
          },
          200
        )
      );

    const submitted = await submitReview(config, packet, {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(submitted).toMatchObject({
      status: "pending",
      interim_decision: "allow",
      job_id: "019d0000-0000-7000-8000-000000000001",
    });

    const job = await getReviewJob(config, "019d0000-0000-7000-8000-000000000001", {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(job).toMatchObject({ status: "completed", decision: "deny" });
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      "http://127.0.0.1:8090/v1/review-jobs/019d0000-0000-7000-8000-000000000001"
    );
  });

  it("rejects malformed success responses instead of treating them as allow", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ status: "completed" }, 200));

    await expect(
      submitReview(config, packet, { fetchImpl: fetchMock as unknown as typeof fetch })
    ).rejects.toThrow("invalid final decision");
  });

  it("retains a structured service error code without logging its response body", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ error: { code: "invalid_review_request", message: "details" } }, 400)
    );

    const error = await submitReview(config, packet, {
      fetchImpl: fetchMock as unknown as typeof fetch,
    }).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(CyberCheckClientError);
    expect(error).toMatchObject({ status: 400, serviceCode: "invalid_review_request" });
    expect(String(error)).not.toContain("details");
  });
});

describe("cyber-check gateway configuration", () => {
  it("defaults to off and requires an explicit service when enabled", () => {
    expect(
      resolveCyberCheckConfig({
        CYBER_CHECK_MODE: "off",
        CYBER_CHECK_URL: undefined,
        CYBER_CHECK_GATEWAY_TOKEN: undefined,
        CYBER_CHECK_GATEWAY_ID: "cch",
      })
    ).toBeNull();

    expect(() =>
      resolveCyberCheckConfig({
        CYBER_CHECK_MODE: "enforce",
        CYBER_CHECK_URL: undefined,
        CYBER_CHECK_GATEWAY_TOKEN: undefined,
        CYBER_CHECK_GATEWAY_ID: "cch",
      })
    ).toThrow("CYBER_CHECK_URL");
  });

  it("allows loopback HTTP but requires HTTPS for non-loopback services", () => {
    expect(
      resolveCyberCheckConfig({
        CYBER_CHECK_MODE: "shadow",
        CYBER_CHECK_URL: "http://127.0.0.1:8090",
        CYBER_CHECK_GATEWAY_TOKEN: "token",
        CYBER_CHECK_GATEWAY_ID: "cch",
      })
    ).toMatchObject({ mode: "shadow", gatewayId: "cch" });

    expect(() =>
      resolveCyberCheckConfig({
        CYBER_CHECK_MODE: "shadow",
        CYBER_CHECK_URL: "http://review.internal.example",
        CYBER_CHECK_GATEWAY_TOKEN: "token",
        CYBER_CHECK_GATEWAY_ID: "cch",
      })
    ).toThrow("must use HTTPS");
  });

  it("requires a token and an HTTPS origin without embedded URL state", () => {
    expect(() =>
      resolveCyberCheckConfig({
        CYBER_CHECK_MODE: "shadow",
        CYBER_CHECK_URL: "https://review.internal.example",
        CYBER_CHECK_GATEWAY_TOKEN: undefined,
        CYBER_CHECK_GATEWAY_ID: "cch",
      })
    ).toThrow("CYBER_CHECK_GATEWAY_TOKEN");

    for (const url of [
      "ftp://review.internal.example",
      "https://user:password@review.internal.example",
      "https://review.internal.example/reviews",
    ]) {
      expect(() =>
        resolveCyberCheckConfig({
          CYBER_CHECK_MODE: "shadow",
          CYBER_CHECK_URL: url,
          CYBER_CHECK_GATEWAY_TOKEN: "token",
          CYBER_CHECK_GATEWAY_ID: "cch",
        })
      ).toThrow();
    }
  });
});
