import { createHash } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetch as undiciFetch } from "undici";
import { resolveEndpointPolicy } from "@/app/v1/_lib/proxy/endpoint-policy";
import { RequestReviewError } from "@/app/v1/_lib/proxy/errors";
import { ProxyForwarder } from "@/app/v1/_lib/proxy/forwarder";
import { ProxySession } from "@/app/v1/_lib/proxy/session";
import type { ReviewRequestEnvelope } from "@/lib/cyber-check/types";
import type { Provider } from "@/types/provider";

const mocks = vi.hoisted(() => ({
  applyFinal: vi.fn(async () => {}),
  delay: vi.fn(async () => undefined),
  getEnvConfig: vi.fn(),
}));

vi.mock("node:timers/promises", () => ({
  default: { setTimeout: mocks.delay },
  setTimeout: mocks.delay,
}));
vi.mock("@/lib/config/env.schema", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config/env.schema")>();
  return {
    ...actual,
    getEnvConfig: () => ({ ...actual.getEnvConfig(), ...mocks.getEnvConfig() }),
  };
});
vi.mock("@/lib/logger", () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
    fatal: vi.fn(),
  },
}));
vi.mock("@/lib/request-filter-engine", () => ({
  requestFilterEngine: { applyFinal: mocks.applyFinal },
}));

function createProvider(url = "https://codex.example.com/v1"): Provider {
  return {
    id: 41,
    name: "codex-upstream",
    providerType: "codex",
    url,
    key: "upstream-key",
    preserveClientIp: false,
    priority: 0,
    costMultiplier: 1,
    maxRetryAttempts: 1,
    mcpPassthroughType: "minimax",
    mcpPassthroughUrl: "https://mcp.example.com",
  } as unknown as Provider;
}

function createSession(message: Record<string, unknown>): ProxySession {
  const headers = new Headers({
    "content-type": "application/json",
    authorization: "Bearer proxy-user-key",
  });
  const session = Object.create(ProxySession.prototype);

  Object.assign(session, {
    startTime: Date.now(),
    method: "POST",
    requestUrl: new URL("https://proxy.example.com/v1/responses"),
    headers,
    originalHeaders: new Headers(headers),
    headerLog: JSON.stringify(Object.fromEntries(headers.entries())),
    request: {
      model: "gpt-5.6-sol",
      log: JSON.stringify(message),
      message,
    },
    userAgent: "CyberCheckForwarderTest/1.0",
    context: null,
    clientAbortSignal: null,
    userName: "test-user",
    authState: { success: true, user: null, key: null, apiKey: null },
    provider: null,
    messageContext: {
      id: 42,
      user: { id: 7 },
      key: { id: 9 },
    },
    sessionId: "session-forwarder-test",
    requestSequence: 3,
    originalFormat: "response",
    providerType: null,
    originalModelName: null,
    originalUrlPathname: null,
    providerChain: [],
    cacheTtlResolved: null,
    context1mApplied: false,
    cachedPriceData: undefined,
    cachedBillingModelSource: undefined,
    forwardedRequestBody: null,
    endpointPolicy: resolveEndpointPolicy("/v1/responses"),
    setCacheTtlResolved: vi.fn(),
    getCacheTtlResolved: vi.fn(() => null),
    getCurrentModel: vi.fn(() => "gpt-5.6-sol"),
    clientRequestsContext1m: vi.fn(() => false),
    setContext1mApplied: vi.fn(),
    getContext1mApplied: vi.fn(() => false),
    getGroupCostMultiplier: vi.fn(() => 1),
    getEndpointPolicy: vi.fn(() => resolveEndpointPolicy("/v1/responses")),
    isHeaderModified: vi.fn(() => false),
  });

  return session as ProxySession;
}

function reviewResponse(decision: "allow" | "deny"): Response {
  return Response.json({
    status: "completed",
    decision,
    predicted_decision: decision,
    enforcement_mode: "enforce",
    reason: decision === "allow" ? "fast_path" : "reviewer_assessment",
    coverage: "complete",
    policy_version: "cyber-policy-v1",
    reviewer_version: decision === "allow" ? "none" : "reviewer-v1",
  });
}

function pendingResponse(): Response {
  return Response.json(
    {
      status: "pending",
      interim_decision: "allow",
      job_id: "019d0000-0000-7000-8000-000000000001",
      status_url: "/v1/review-jobs/019d0000-0000-7000-8000-000000000001",
    },
    { status: 202 }
  );
}

function completedJobResponse(): Response {
  return Response.json({
    status: "completed",
    job_id: "019d0000-0000-7000-8000-000000000001",
    decision: "allow",
    predicted_decision: "allow",
    enforcement_mode: "enforce",
    reason: "reviewer_assessment",
    coverage: "complete",
    policy_version: "cyber-policy-v1",
    reviewer_version: "reviewer-v1",
  });
}

function reviewPacketFrom(call: unknown[] | undefined): ReviewRequestEnvelope {
  const init = call?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body)) as ReviewRequestEnvelope;
}

async function forward(session: ProxySession, provider: Provider): Promise<Response> {
  const { doForward } = ProxyForwarder as unknown as {
    doForward: (session: ProxySession, provider: Provider, baseUrl: string) => Promise<Response>;
  };
  return doForward(session, provider, provider.url);
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe("ProxyForwarder cyber-check admission boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getEnvConfig.mockReturnValue({
      CYBER_CHECK_MODE: "enforce",
      CYBER_CHECK_URL: "http://127.0.0.1:8090",
      CYBER_CHECK_GATEWAY_TOKEN: "gateway-token",
      CYBER_CHECK_ZSTD_MIN_BYTES: 256 * 1024,
      CYBER_CHECK_MAX_ENCODING_BYTES: 256 * 1024 * 1024,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("initiates upstream before shadow observation and does not await Cyber Check", async () => {
    mocks.getEnvConfig.mockReturnValue({
      CYBER_CHECK_MODE: "shadow",
      CYBER_CHECK_URL: "http://127.0.0.1:8090",
      CYBER_CHECK_GATEWAY_TOKEN: "gateway-token",
      CYBER_CHECK_ZSTD_MIN_BYTES: 256 * 1024,
      CYBER_CHECK_MAX_ENCODING_BYTES: 256 * 1024 * 1024,
    });
    const events: string[] = [];
    const message = {
      model: "gpt-5.6-sol",
      input: "Observe this request without gating it.",
      stream: true,
    };
    const session = createSession(message);
    const provider = createProvider();
    let releaseReview!: (response: Response) => void;
    const reviewResponsePromise = new Promise<Response>((resolve) => {
      releaseReview = resolve;
    });
    const reviewFetch = vi.fn(() => {
      events.push("review");
      return reviewResponsePromise;
    });
    vi.stubGlobal("fetch", reviewFetch);
    const upstreamFetch = vi
      .spyOn(ProxyForwarder as never, "fetchWithoutAutoDecode")
      .mockImplementationOnce(async () => {
        events.push("upstream");
        return new Response("ok", { status: 200 });
      });

    await expect(forward(session, provider)).resolves.toBeInstanceOf(Response);
    const forwardedBody = session.forwardedRequestBody;
    expect(forwardedBody).not.toBeNull();

    // The final SSE return boundary may release the tracking Session while a shadow
    // submission is still pending. The observation captured its own immutable inputs.
    session.releaseRequestBodyAfterCommit();
    expect(session.isRequestBodyReleased()).toBe(true);
    expect(session.forwardedRequestBody).toBeNull();

    expect(upstreamFetch).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(reviewFetch).toHaveBeenCalledOnce());
    expect(events).toEqual(["upstream", "review"]);

    const observation = session.getCyberCheckObservation();
    expect(observation).not.toBeNull();
    let observationSettled = false;
    void observation!.completion.then(() => {
      observationSettled = true;
    });
    await Promise.resolve();
    expect(observationSettled).toBe(false);

    releaseReview(reviewResponse("allow"));
    await expect(observation!.completion).resolves.toMatchObject({ status: "recorded" });

    const packet = reviewPacketFrom(reviewFetch.mock.calls[0]);
    expect(packet.source.body_sha256).toBe(
      createHash("sha256").update(String(forwardedBody)).digest("hex")
    );
  });

  it("completes a real loopback upstream response while the Cyber HTTP response is held", async () => {
    vi.stubGlobal("fetch", undiciFetch);
    let reviewArrived!: () => void;
    const reviewStarted = new Promise<void>((resolve) => {
      reviewArrived = resolve;
    });
    let reviewResponseWriter: ServerResponse | null = null;
    const cyberServer = createServer((request, response) => {
      request.resume();
      request.once("end", () => {
        reviewResponseWriter = response;
        reviewArrived();
      });
    });
    const upstreamServer = createServer((request, response) => {
      request.resume();
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("upstream-ok");
    });

    try {
      const [cyberOrigin, upstreamOrigin] = await Promise.all([
        listen(cyberServer),
        listen(upstreamServer),
      ]);
      mocks.getEnvConfig.mockReturnValue({
        CYBER_CHECK_MODE: "shadow",
        CYBER_CHECK_URL: cyberOrigin,
        CYBER_CHECK_GATEWAY_TOKEN: "gateway-token",
        CYBER_CHECK_ZSTD_MIN_BYTES: 256 * 1024,
        CYBER_CHECK_MAX_ENCODING_BYTES: 256 * 1024 * 1024,
      });
      const message = {
        model: "gpt-5.6-sol",
        input: "Exercise actual loopback transports.",
        stream: false,
      };
      const session = createSession(message);
      const provider = createProvider(`${upstreamOrigin}/v1`);

      const upstreamResponse = await forward(session, provider);
      await expect(upstreamResponse.text()).resolves.toBe("upstream-ok");
      await reviewStarted;

      const observation = session.getCyberCheckObservation();
      expect(observation).not.toBeNull();
      let observationSettled = false;
      void observation!.completion.then(() => {
        observationSettled = true;
      });
      await Promise.resolve();
      expect(observationSettled).toBe(false);

      const reviewBody = await reviewResponse("allow").text();
      reviewResponseWriter!.writeHead(200, { "content-type": "application/json" });
      reviewResponseWriter!.end(reviewBody);
      await expect(observation!.completion).resolves.toMatchObject({ status: "recorded" });
    } finally {
      await Promise.all([close(cyberServer), close(upstreamServer)]);
    }
  });

  it("reviews the final filtered body before sending those exact bytes upstream", async () => {
    const events: string[] = [];
    const message = {
      model: "gpt-5.6-sol",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Read the repository instructions." }],
        },
      ],
      stream: true,
    };
    const session = createSession(message);
    const provider = createProvider();

    mocks.applyFinal.mockImplementation(async (_session, body) => {
      events.push("final_filter");
      (body.input as unknown[]).push({
        type: "function_call_output",
        call_id: "call_from_final_filter",
        output: "final-filter-visible-tool-result",
      });
    });

    const reviewFetch = vi.fn(async () => {
      events.push("review");
      return reviewResponse("allow");
    });
    vi.stubGlobal("fetch", reviewFetch);

    let upstreamBody: BodyInit | null | undefined;
    vi.spyOn(ProxyForwarder as never, "fetchWithoutAutoDecode").mockImplementationOnce(
      async (_url: string, init: RequestInit) => {
        events.push("upstream");
        upstreamBody = init.body;
        return new Response("ok", { status: 200 });
      }
    );

    await forward(session, provider);

    expect(events).toEqual(["final_filter", "review", "upstream"]);
    expect(typeof upstreamBody).toBe("string");
    expect(session.forwardedRequestBody).toBe(upstreamBody);

    const packet = reviewPacketFrom(reviewFetch.mock.calls[0]);
    expect(packet.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source_type: "function_call_output",
          linkage: { call_id: "call_from_final_filter" },
          content: [
            expect.objectContaining({
              type: "text",
              text: "final-filter-visible-tool-result",
            }),
          ],
        }),
      ])
    );
    expect(packet.source.body_bytes).toBe(Buffer.byteLength(String(upstreamBody)));
    expect(packet.source.body_sha256).toBe(
      createHash("sha256").update(String(upstreamBody)).digest("hex")
    );
  });

  it("performs no upstream I/O after a synchronous enforced denial", async () => {
    const session = createSession({
      model: "gpt-5.6-sol",
      input: "Inspect this request synchronously.",
      stream: true,
    });
    const provider = createProvider();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reviewResponse("deny"))
    );
    const upstreamFetch = vi.spyOn(ProxyForwarder as never, "fetchWithoutAutoDecode");

    const error = await forward(session, provider).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(RequestReviewError);
    expect(error).toMatchObject({ code: "gateway_cyber_restricted", statusCode: 403 });
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("forwards after a durable asynchronous admission and observes its Job", async () => {
    const session = createSession({
      model: "gpt-5.6-sol",
      input: "Run the ordinary sampled request.",
      stream: true,
    });
    const provider = createProvider();
    const reviewFetch = vi
      .fn()
      .mockResolvedValueOnce(pendingResponse())
      .mockResolvedValueOnce(completedJobResponse());
    vi.stubGlobal("fetch", reviewFetch);
    const upstreamFetch = vi
      .spyOn(ProxyForwarder as never, "fetchWithoutAutoDecode")
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    await expect(forward(session, provider)).resolves.toBeInstanceOf(Response);

    expect(upstreamFetch).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(reviewFetch).toHaveBeenCalledTimes(2));
    expect(mocks.delay).toHaveBeenCalledOnce();
    expect(String(reviewFetch.mock.calls[1]?.[0])).toBe(
      "http://127.0.0.1:8090/v1/review-jobs/019d0000-0000-7000-8000-000000000001"
    );
  });
});
