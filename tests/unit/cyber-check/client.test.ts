import { describe, expect, it, vi } from "vitest";
import { zstdDecompressSync } from "node:zlib";
import {
  CyberCheckClientError,
  getReviewJob,
  reinstatePrincipal,
  reportProviderEvent,
  reportRequestOutcome,
  submitReview,
} from "@/lib/cyber-check/client";
import { resolveCyberCheckConfig } from "@/lib/cyber-check/config";
import type {
  ProviderEventEnvelope,
  RequestOutcomeEnvelope,
  ReviewRequestEnvelope,
} from "@/lib/cyber-check/types";

const config = {
  mode: "shadow" as const,
  baseUrl: new URL("http://127.0.0.1:8090"),
  gatewayToken: "gateway-test-token",
  zstdMinBytes: 256 * 1024,
  maxEncodingBytes: 256 * 1024 * 1024,
};

const packet: ReviewRequestEnvelope = {
  schema_version: "cyber-check.request-review.v1",
  identity: {
    request_id: "42:digest",
    principal_id: "7",
    client_instance_id: "installation-1",
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

const providerEvent: ProviderEventEnvelope = {
  schema_version: "cyber-check.provider-event.v1",
  identity: packet.identity,
  enforcement_mode: "shadow",
  upstream_provider_id: "17",
  event: {
    type: "policy_rejection",
    code: "cyber_policy",
  },
};

const requestOutcome: RequestOutcomeEnvelope = {
  schema_version: "cyber-check.request-outcome.v1",
  identity: packet.identity,
  outcome: "clean",
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
    const serialized = JSON.stringify(packet);
    const headers = new Headers(init?.headers);
    expect(String(url)).toBe("http://127.0.0.1:8090/v1/request-reviews");
    expect(headers.get("authorization")).toBe("Bearer gateway-test-token");
    expect(headers.get("content-encoding")).toBeNull();
    expect(headers.get("content-length")).toBe(String(Buffer.byteLength(serialized)));
    expect(headers.get("x-cyber-check-decoded-length")).toBe(String(Buffer.byteLength(serialized)));
    expect(JSON.parse(String(init?.body))).toEqual(packet);
  });

  it("uses asynchronous zstd level 1 transport for large compressible packets", async () => {
    const largePacket: ReviewRequestEnvelope = {
      ...packet,
      items: [
        {
          source_type: "message",
          origin: "user",
          content: [{ type: "text", text: "reviewable context ".repeat(32_768), format: "plain" }],
        },
      ],
    };
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

    await submitReview({ ...config, zstdMinBytes: 1 }, largePacket, {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const init = fetchMock.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(headers.get("content-encoding")).toBe("zstd");
    const compressed = init?.body;
    expect(compressed).toBeInstanceOf(Uint8Array);
    const decoded = zstdDecompressSync(compressed as Uint8Array).toString("utf8");
    expect(JSON.parse(decoded)).toEqual(largePacket);
    expect((compressed as Uint8Array).byteLength).toBeLessThan(Buffer.byteLength(decoded));
    expect(headers.get("content-length")).toBe(String((compressed as Uint8Array).byteLength));
    expect(headers.get("x-cyber-check-decoded-length")).toBe(String(Buffer.byteLength(decoded)));
  });

  it("bounds the cross-machine submission with a 25 second deadline", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
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

    await submitReview(config, packet, { fetchImpl: fetchMock as unknown as typeof fetch });

    expect(timeout).toHaveBeenCalledWith(25_000);
    timeout.mockRestore();
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

  it("reports an authoritative provider event to its dedicated resource", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        {
          principal_strikes: 1,
          session_restricted: true,
          client_instance_restricted: true,
          principal_restricted: false,
        },
        200
      )
    );

    const containment = await reportProviderEvent(config, providerEvent, {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(containment).toEqual({
      principal_strikes: 1,
      session_restricted: true,
      client_instance_restricted: true,
      principal_restricted: false,
    });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe("http://127.0.0.1:8090/v1/provider-events");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer gateway-test-token");
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(String(init?.body))).toEqual(providerEvent);
  });

  it("reinstates a principal through the explicit administration resource", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));

    await reinstatePrincipal(config, "principal/7", {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe("http://127.0.0.1:8090/v1/principals/principal%2F7/reinstatement");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer gateway-test-token");
  });

  it("reports a clean terminal outcome to its dedicated resource", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));

    await reportRequestOutcome(config, requestOutcome, {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe("http://127.0.0.1:8090/v1/request-outcomes");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer gateway-test-token");
    expect(JSON.parse(String(init?.body))).toEqual(requestOutcome);
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
        CYBER_CHECK_ZSTD_MIN_BYTES: 256 * 1024,
        CYBER_CHECK_MAX_ENCODING_BYTES: 256 * 1024 * 1024,
      })
    ).toBeNull();

    expect(() =>
      resolveCyberCheckConfig({
        CYBER_CHECK_MODE: "enforce",
        CYBER_CHECK_URL: undefined,
        CYBER_CHECK_GATEWAY_TOKEN: undefined,
        CYBER_CHECK_ZSTD_MIN_BYTES: 256 * 1024,
        CYBER_CHECK_MAX_ENCODING_BYTES: 256 * 1024 * 1024,
      })
    ).toThrow("CYBER_CHECK_URL");
  });

  it("allows loopback HTTP but requires HTTPS for non-loopback services", () => {
    expect(
      resolveCyberCheckConfig({
        CYBER_CHECK_MODE: "shadow",
        CYBER_CHECK_URL: "http://127.0.0.1:8090",
        CYBER_CHECK_GATEWAY_TOKEN: "token",
        CYBER_CHECK_ZSTD_MIN_BYTES: 256 * 1024,
        CYBER_CHECK_MAX_ENCODING_BYTES: 256 * 1024 * 1024,
      })
    ).toMatchObject({ mode: "shadow" });

    expect(() =>
      resolveCyberCheckConfig({
        CYBER_CHECK_MODE: "shadow",
        CYBER_CHECK_URL: "http://review.internal.example",
        CYBER_CHECK_GATEWAY_TOKEN: "token",
        CYBER_CHECK_ZSTD_MIN_BYTES: 256 * 1024,
        CYBER_CHECK_MAX_ENCODING_BYTES: 256 * 1024 * 1024,
      })
    ).toThrow("must use HTTPS");
  });

  it("requires a token and an HTTPS origin without embedded URL state", () => {
    expect(() =>
      resolveCyberCheckConfig({
        CYBER_CHECK_MODE: "shadow",
        CYBER_CHECK_URL: "https://review.internal.example",
        CYBER_CHECK_GATEWAY_TOKEN: undefined,
        CYBER_CHECK_ZSTD_MIN_BYTES: 256 * 1024,
        CYBER_CHECK_MAX_ENCODING_BYTES: 256 * 1024 * 1024,
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
          CYBER_CHECK_ZSTD_MIN_BYTES: 256 * 1024,
          CYBER_CHECK_MAX_ENCODING_BYTES: 256 * 1024 * 1024,
        })
      ).toThrow();
    }
  });
});
