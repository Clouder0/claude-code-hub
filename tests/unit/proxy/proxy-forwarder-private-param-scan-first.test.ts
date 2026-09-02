import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveEndpointPolicy } from "@/app/v1/_lib/proxy/endpoint-policy";
import { hasPrivateParameters, ProxyForwarder } from "@/app/v1/_lib/proxy/forwarder";
import { mayInjectOpenAIChatStreamUsage } from "@/app/v1/_lib/proxy/openai-chat-usage-options";
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

function createCodexProvider(): Provider {
  return {
    id: 1,
    name: "codex-upstream",
    providerType: "codex",
    url: "https://codex.example.com/v1",
    key: "upstream-key",
    preserveClientIp: false,
    priority: 0,
    costMultiplier: 1,
    maxRetryAttempts: 1,
  } as unknown as Provider;
}

function createCodexSession(pathname = "/v1/responses"): ProxySession {
  const headers = new Headers({
    "content-type": "application/json",
    authorization: "Bearer proxy-user-key",
  });
  const session = Object.create(ProxySession.prototype);

  Object.assign(session, {
    startTime: Date.now(),
    method: "POST",
    requestUrl: new URL(`https://proxy.example.com${pathname}`),
    headers,
    originalHeaders: new Headers(headers),
    headerLog: JSON.stringify(Object.fromEntries(headers.entries())),
    request: {
      model: "gpt-5.6-sol",
      log: JSON.stringify({}),
      message: {},
    },
    userAgent: "CodexTest/1.0",
    context: null,
    clientAbortSignal: null,
    userName: "test-user",
    authState: { success: true, user: null, key: null, apiKey: null },
    provider: null,
    messageContext: null,
    sessionId: null,
    requestSequence: 1,
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

async function driveDoForward(session: ProxySession, provider: Provider): Promise<string | null> {
  let capturedBody: BodyInit | null | null = null;
  const fetchWithoutAutoDecode = vi.spyOn(ProxyForwarder as never, "fetchWithoutAutoDecode");
  fetchWithoutAutoDecode.mockImplementationOnce(async (_url: string, init: RequestInit) => {
    capturedBody = init.body;
    return new Response("ok", { status: 200, headers: { "content-type": "application/json" } });
  });
  const { doForward } = ProxyForwarder as unknown as {
    doForward: (session: ProxySession, provider: Provider, baseUrl: string) => Promise<Response>;
  };

  await doForward(session, provider, provider.url);
  return typeof capturedBody === "string" ? capturedBody : null;
}

describe("hasPrivateParameters", () => {
  it("干净树返回 false", () => {
    expect(hasPrivateParameters({})).toBe(false);
    expect(hasPrivateParameters({ model: "x", input: [{ type: "message", content: "hi" }] })).toBe(
      false
    );
    expect(hasPrivateParameters([1, "a", null])).toBe(false);
    expect(hasPrivateParameters("string")).toBe(false);
    expect(hasPrivateParameters(null)).toBe(false);
  });

  it("任意层级的下划线键返回 true", () => {
    expect(hasPrivateParameters({ _private: 1 })).toBe(true);
    expect(hasPrivateParameters({ top: { _nest: 1 } })).toBe(true);
    expect(hasPrivateParameters({ items: [{ deep: [{ _x: true }] }] })).toBe(true);
    expect(hasPrivateParameters({ normal: 1, _keep: "secret" })).toBe(true);
  });
});

describe("mayInjectOpenAIChatStreamUsage", () => {
  it("codex /v1/responses 永不注入", () => {
    expect(mayInjectOpenAIChatStreamUsage("codex", "/v1/responses", { stream: true })).toBe(false);
  });

  it("openai-compatible + chat/completions + stream 保守返回 true", () => {
    expect(
      mayInjectOpenAIChatStreamUsage("openai-compatible", "/v1/chat/completions", {
        stream: true,
      })
    ).toBe(true);
    expect(
      mayInjectOpenAIChatStreamUsage("openai-compatible", "/v1/chat/completions", {
        stream: false,
      })
    ).toBe(false);
  });
});

describe("ProxyForwarder - private parameter scan-first passthrough", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.applyFinal.mockImplementation(async () => {});
    mocks.hasFinalBodyFilters.mockImplementation(async () => false);
  });

  it("干净树以浅拷贝透传：字节一致、嵌套共享无深克隆、顶层改写不污染计费视图", async () => {
    const provider = createCodexProvider();
    const session = createCodexSession();
    const message = {
      model: "gpt-5.6-sol",
      stream: true,
      input: [
        { type: "message", role: "user", content: "hello" },
        { type: "message", role: "assistant", content: "hi" },
      ],
      prompt_cache_key: "sess_123456789012345678",
    };
    session.request.message = message;

    const captured = await driveDoForward(session, provider);

    expect(captured).toBe(JSON.stringify(message));
    expect(session.forwardedRequestBody).toBe(captured);

    const billingView = session.getBillingRequestMessage() as Record<string, unknown>;
    // 顶层是浅拷贝（隔离跨 attempt 的 ModelRedirector 顶层 model 改写）
    expect(billingView).not.toBe(message);
    // 嵌套结构按引用共享：没有整树深克隆
    expect(billingView.input).toBe(message.input);
    // 透传后对原树的顶层改写不影响已缓存的计费视图
    message.model = "mutated-after-forward";
    expect(billingView.model).toBe("gpt-5.6-sol");
  });

  it("含下划线键时仍走重建过滤：上游收不到私有键，原始树不被污染", async () => {
    const provider = createCodexProvider();
    const session = createCodexSession();
    const message = {
      model: "gpt-5.6-sol",
      stream: true,
      _internal_flag: "strip-me",
      input: [{ type: "message", role: "user", content: "hi", _trace: "abc" }],
    };
    session.request.message = message;

    const captured = await driveDoForward(session, provider);

    expect(captured).not.toContain("strip-me");
    expect(captured).not.toContain("_trace");
    expect(JSON.parse(captured as string)).toEqual({
      model: "gpt-5.6-sol",
      stream: true,
      input: [{ type: "message", role: "user", content: "hi" }],
    });
    // 原始树保持原样
    expect(message._internal_flag).toBe("strip-me");
    expect((message.input as Array<Record<string, unknown>>)[0]._trace).toBe("abc");
  });

  it("存在 final 过滤器时回退重建：applyFinal 改写不污染原始树", async () => {
    const provider = createCodexProvider();
    const session = createCodexSession();
    const message = {
      model: "gpt-5.6-sol",
      stream: true,
      service_tier: "default",
    };
    session.request.message = message;
    mocks.hasFinalBodyFilters.mockImplementation(async () => true);
    mocks.applyFinal.mockImplementation(async (_session, body) => {
      body.service_tier = "priority";
    });

    const captured = await driveDoForward(session, provider);

    expect(JSON.parse(captured as string).service_tier).toBe("priority");
    expect(message.service_tier).toBe("default");
  });
});
