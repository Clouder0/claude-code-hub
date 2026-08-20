import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveEndpointPolicy } from "@/app/v1/_lib/proxy/endpoint-policy";
import { ProxyForwarder } from "@/app/v1/_lib/proxy/forwarder";
import { ProxySession } from "@/app/v1/_lib/proxy/session";
import type { Provider } from "@/types/provider";

const mocks = vi.hoisted(() => ({
  applyFinal: vi.fn(async () => {}),
  hasFinalBodyFilters: vi.fn(async () => false),
}));

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
  requestFilterEngine: {
    applyFinal: mocks.applyFinal,
    hasFinalBodyFilters: mocks.hasFinalBodyFilters,
  },
}));

function createProvider(providerType: "openai-compatible" | "codex"): Provider {
  return {
    id: 1,
    name: `${providerType}-upstream`,
    providerType,
    url:
      providerType === "codex"
        ? "https://codex.example.com/v1"
        : "https://openai.example.com/openai",
    key: "upstream-key",
    preserveClientIp: false,
    priority: 0,
    costMultiplier: 1,
    maxRetryAttempts: 1,
    mcpPassthroughType: "minimax",
    mcpPassthroughUrl: "https://mcp.example.com",
  } as unknown as Provider;
}

function createSession(
  pathname: string,
  providerType: "openai-compatible" | "codex"
): ProxySession {
  const headers = new Headers({
    "content-type": "application/json",
    authorization: "Bearer proxy-user-key",
  });
  const session = Object.create(ProxySession.prototype);

  Object.assign(session, {
    startTime: Date.now(),
    method: "GET",
    requestUrl: new URL(`https://proxy.example.com${pathname}`),
    headers,
    originalHeaders: new Headers(headers),
    headerLog: JSON.stringify(Object.fromEntries(headers.entries())),
    request: {
      model: null,
      log: JSON.stringify({}),
      message: {},
    },
    userAgent: "OpenAITest/1.0",
    context: null,
    clientAbortSignal: null,
    userName: "test-user",
    authState: { success: true, user: null, key: null, apiKey: null },
    provider: null,
    messageContext: null,
    sessionId: null,
    requestSequence: 1,
    originalFormat: providerType === "codex" ? "response" : "openai",
    providerType: null,
    originalModelName: null,
    originalUrlPathname: null,
    providerChain: [],
    cacheTtlResolved: null,
    context1mApplied: false,
    cachedPriceData: undefined,
    cachedBillingModelSource: undefined,
    forwardedRequestBody: null,
    endpointPolicy: resolveEndpointPolicy(pathname),
    setCacheTtlResolved: vi.fn(),
    getCacheTtlResolved: vi.fn(() => null),
    getCurrentModel: vi.fn(() => null),
    clientRequestsContext1m: vi.fn(() => false),
    setContext1mApplied: vi.fn(),
    getContext1mApplied: vi.fn(() => false),
    getGroupCostMultiplier: vi.fn(() => 1),
    getEndpointPolicy: vi.fn(() => resolveEndpointPolicy(pathname)),
    isHeaderModified: vi.fn(() => false),
  });

  return session as ProxySession;
}

describe("ProxyForwarder - official OpenAI endpoints stay on provider URL", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.applyFinal.mockImplementation(async () => {});
    mocks.hasFinalBodyFilters.mockImplementation(async () => false);
  });

  it("records the final filtered JSON body used by upstream billing", async () => {
    const provider = createProvider("openai-compatible");
    const session = createSession("/v1/responses", "openai-compatible");
    (session as unknown as { method: string }).method = "POST";
    session.request.model = "gpt-5.6-sol";
    session.request.message = {
      model: "gpt-5.6-sol",
      stream: true,
      service_tier: "default",
    };
    // applyFinal 会改写 body，对应真实引擎 hasFinalBodyFilters 返回 true
    mocks.hasFinalBodyFilters.mockImplementation(async () => true);
    mocks.applyFinal.mockImplementation(async (_session, body) => {
      body.service_tier = "priority";
      body.prompt_cache_options = { mode: "explicit" };
    });
    let capturedBody: BodyInit | null | undefined;
    const fetchWithoutAutoDecode = vi.spyOn(ProxyForwarder as never, "fetchWithoutAutoDecode");
    fetchWithoutAutoDecode.mockImplementationOnce(async (_url: string, init: RequestInit) => {
      capturedBody = init.body;
      return new Response("ok", { status: 200, headers: { "content-type": "application/json" } });
    });
    const { doForward } = ProxyForwarder as unknown as {
      doForward: (session: ProxySession, provider: Provider, baseUrl: string) => Promise<Response>;
    };

    await doForward(session, provider, provider.url);

    expect(typeof capturedBody).toBe("string");
    expect(session.forwardedRequestBody).toBe(capturedBody);
    expect(session.getBillingRequestMessage()).toMatchObject({
      model: "gpt-5.6-sol",
      service_tier: "priority",
      prompt_cache_options: { mode: "explicit" },
    });
  });

  it("does not route /v1/files through MCP passthrough URL", async () => {
    const provider = createProvider("openai-compatible");
    const session = createSession("/v1/files/file_123/content", "openai-compatible");
    let capturedUrl: string | null = null;

    const fetchWithoutAutoDecode = vi.spyOn(ProxyForwarder as never, "fetchWithoutAutoDecode");
    fetchWithoutAutoDecode.mockImplementationOnce(async (url: string) => {
      capturedUrl = url;
      return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
    });

    const { doForward } = ProxyForwarder as unknown as {
      doForward: (session: ProxySession, provider: Provider, baseUrl: string) => Promise<Response>;
    };

    await doForward(session, provider, provider.url);

    expect(capturedUrl).toBe("https://openai.example.com/openai/v1/files/file_123/content");
    expect(capturedUrl?.startsWith("https://mcp.example.com")).toBe(false);
  });

  it("does not route /v1/responses/{id} through MCP passthrough URL", async () => {
    const provider = createProvider("codex");
    const session = createSession("/v1/responses/resp_123", "codex");
    let capturedUrl: string | null = null;

    const fetchWithoutAutoDecode = vi.spyOn(ProxyForwarder as never, "fetchWithoutAutoDecode");
    fetchWithoutAutoDecode.mockImplementationOnce(async (url: string) => {
      capturedUrl = url;
      return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
    });

    const { doForward } = ProxyForwarder as unknown as {
      doForward: (session: ProxySession, provider: Provider, baseUrl: string) => Promise<Response>;
    };

    await doForward(session, provider, provider.url);

    expect(capturedUrl).toBe("https://codex.example.com/v1/responses/resp_123");
    expect(capturedUrl?.startsWith("https://mcp.example.com")).toBe(false);
  });
});
