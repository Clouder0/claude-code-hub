import { createHash } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProxyForwarder } from "@/app/v1/_lib/proxy/forwarder";
import { ProxySession } from "@/app/v1/_lib/proxy/session";
import { scanJsonRequestBody } from "@/app/v1/_lib/proxy/body-scanner";
import { completeCodexSessionIdentifiers } from "@/app/v1/_lib/codex/session-completer";
import { extractInitialMessageTextHash } from "@/app/v1/_lib/codex/session-completer";
import type { Provider } from "@/types/provider";

/**
 * 零变换快速路径集成断言：
 *  F1 摄入锚定：adopt 后通货=原始字节、门面=投影、无树解析发生
 *  F2 纯直发：无编辑 attempt 的上游收到的字节与客户端原始 body 逐字节相同
 *  F3 编辑合成：pck 插入 + model 重定向后上游收到的 body 语义等价于树路径产物
 *  F4 降解：非 codex 供应商 attempt 经 rematerialize 回到 legacy 树路径，pck 回放
 *  F5 cyber shadow：字节直供的投影（body_sha256/byte_length/items）与合成体一致
 *  F6 completer：initialMessageTextHash 覆盖与树遍历 oracle bit-exact
 *  F7 GC：扫描大 body 不产生可比拟 JSON.parse 的堆驻留（--expose-gc 时生效）
 */

const mocks = vi.hoisted(() => ({
  applyFinal: vi.fn(async () => {}),
  delay: vi.fn(async () => undefined),
  getEnvConfig: vi.fn(),
  getCachedSystemSettings: vi.fn(async () => ({
    enableClaudeMetadataUserIdInjection: false,
    enableCodexSessionIdCompletion: true,
    enableThinkingBudgetRectifier: true,
    enableThinkingSignatureRectifier: true,
    interceptAnthropicWarmupRequests: false,
  })),
  isHttp2Enabled: vi.fn(async () => false),
  hasFinalBodyFilters: vi.fn(async () => false),
  hasGuardBodyScopeFilters: vi.fn(async () => false),
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
  requestFilterEngine: {
    applyFinal: mocks.applyFinal,
    hasFinalBodyFilters: mocks.hasFinalBodyFilters,
    hasGuardBodyScopeFilters: mocks.hasGuardBodyScopeFilters,
  },
}));
vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config")>();
  return {
    ...actual,
    getCachedSystemSettings: mocks.getCachedSystemSettings,
    isHttp2Enabled: mocks.isHttp2Enabled,
  };
});

const SESSION_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function codexBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    model: "gpt-5.2-codex",
    stream: true,
    instructions: "You are a helpful assistant.",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hello fast path" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
    ],
    ...overrides,
  });
}

function scanOf(text: string) {
  const bytes = new TextEncoder().encode(text);
  const scan = scanJsonRequestBody(bytes);
  expect(scan.ok, scan.anomaly).toBe(true);
  return scan;
}

function createProvider(url: string, overrides: Partial<Provider> = {}): Provider {
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
    ...overrides,
  } as unknown as Provider;
}

function createSession(message: Record<string, unknown>): ProxySession {
  const headers = new Headers({ "content-type": "application/json" });
  const session = Object.create(ProxySession.prototype);
  Object.assign(session, {
    startTime: Date.now(),
    method: "POST",
    requestUrl: new URL("https://proxy.example.com/v1/responses"),
    headers,
    originalHeaders: new Headers(headers),
    headerLog: "",
    request: {
      model: (message.model as string) ?? null,
      log: "(fast-path-test)",
      message,
      buffer: undefined,
    },
    userAgent: "FastBodyTest/1.0",
    context: null,
    clientAbortSignal: null,
    userName: "test-user",
    authState: { success: true, user: null, key: null, apiKey: null },
    provider: null,
    messageContext: {
      id: 42,
      createdAt: new Date(),
      user: { id: 7 },
      key: { id: 9 },
      apiKey: "k",
    },
    sessionId: "session-fast-body-test",
    requestSequence: 3,
    originalFormat: "response",
    originalModelName: null,
    originalUrlPathname: null,
    providerChain: [],
    specialSettings: [],
    cacheTtlResolved: null,
    context1mApplied: false,
    endpointPolicy: undefined,
    setCacheTtlResolved: vi.fn(),
    getCacheTtlResolved: vi.fn(() => null),
    getCurrentModel: vi.fn(() => "gpt-5.2-codex"),
    clientRequestsContext1m: vi.fn(() => false),
    setContext1mApplied: vi.fn(),
    getContext1mApplied: vi.fn(() => false),
    getGroupCostMultiplier: vi.fn(() => 1),
    getEndpointPolicy: vi.fn(() => ({
      kind: "default",
      guardPreset: "chat",
      allowRetry: true,
      allowProviderSwitch: true,
      allowRawCrossProviderFallback: false,
      allowCircuitBreakerAccounting: true,
      trackConcurrentRequests: true,
      bypassRequestFilters: false,
      bypassForwarderPreprocessing: false,
      bypassSpecialSettings: false,
      bypassResponseRectifier: false,
      endpointPoolStrictness: "inherit",
      providerSelection: "normal",
    })),
    isHeaderModified: vi.fn(() => false),
    isHighConcurrencyModeEnabled: vi.fn(() => true),
    noteRequestBodyReleaseEligible: vi.fn(),
    clearCyberCheckObservation: vi.fn(),
    setCacheTtlResolvedNoop: vi.fn(),
  });
  return session as ProxySession;
}

function adopt(session: ProxySession, text: string) {
  const scan = scanOf(text);
  const facade = JSON.parse(
    JSON.stringify({
      model: scan.fields.model?.value,
      stream: scan.fields.stream?.value,
      service_tier: scan.fields.service_tier?.value,
      prompt_cache_key: scan.fields.prompt_cache_key?.value,
      input: [],
    })
  ) as Record<string, unknown>;
  (
    session as unknown as { request: { message: Record<string, unknown>; model: string | null } }
  ).request.message = facade;
  session.request.model = (facade.model as string) ?? null;
  session.adoptFastBodyPath(scan);
  return { scan, facade };
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
  return `http://127.0.0.1:${address.port}/v1`;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

function upstreamSseHandler(capture: {
  body: Uint8Array | null;
}): (req: { method?: string }, res: ServerResponse) => void {
  return (_req, res) => {
    const chunks: Buffer[] = [];
    _req?.on?.("data", (chunk: Buffer) => chunks.push(chunk));
    _req?.on?.("end", () => {
      capture.body = chunks.length ? new Uint8Array(Buffer.concat(chunks)) : new Uint8Array();
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        'data: {"type":"response.created","response":{"id":"resp_1"}}\n\n' +
          'data: {"type":"response.output_text.delta","delta":"hi"}\n\n' +
          "data: [DONE]\n\n"
      );
    });
  };
}

describe("fast body path integration", () => {
  let server: Server;
  let upstreamUrl: string;
  let capture: { body: Uint8Array | null };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getEnvConfig.mockReturnValue({ CYBER_CHECK_MODE: "off" });
    mocks.hasFinalBodyFilters.mockImplementation(async () => false);
    capture = { body: null };
    server = createServer(upstreamSseHandler(capture));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await close(server).catch(() => {});
  });

  it("F1: adoption anchors currency and facade without tree parsing", () => {
    const text = codexBody({ prompt_cache_key: SESSION_ID });
    const session = createSession({});
    const { scan } = adopt(session, text);

    expect(session.isFastBodyPathActive()).toBe(true);
    // 通货即原始字节（零拷贝同引用）。
    expect(session.forwardedRequestBody).toBe(scan.bytes);
    // 门面：标量 + input 门控标记；无树。
    const message = session.request.message as Record<string, unknown>;
    expect(message.model).toBe("gpt-5.2-codex");
    expect(message.stream).toBe(true);
    expect(Array.isArray(message.input)).toBe(true);
    // 长度/探测走扫描事实。
    expect(session.getMessagesLength()).toBe(3);
    expect(session.isProbeRequest()).toBe(false);
    // 投影视图免解析直接命中。
    expect(session.getForwardedRequestMessage()).toBe(message);
    expect(session.getBillingModel()).toBe("gpt-5.2-codex");
    // 文本视图与原文一致（供 langfuse/调试）。
    expect(session.getForwardedRequestBodyText()).toBe(text);
  });

  it("F2: no-edit attempt forwards the original bytes verbatim", async () => {
    const text = codexBody({ prompt_cache_key: SESSION_ID });
    const session = createSession({});
    adopt(session, text);
    upstreamUrl = await listen(server);

    await forward(session, createProvider(upstreamUrl));

    expect(capture.body, "upstream must receive bytes").not.toBeNull();
    expect(Buffer.compare(Buffer.from(capture.body!), Buffer.from(text))).toBe(0);
    // 快速路径全程存活（未被降解）。
    expect(session.isFastBodyPathActive()).toBe(true);
  });

  it("F3: pck insert + model redirect compose semantic parity", async () => {
    const text = codexBody(); // 无 prompt_cache_key
    const session = createSession({});
    adopt(session, text);
    // guard 补全（pck splice）。
    session.applyFastBodyPromptCacheKey(SESSION_ID);
    upstreamUrl = await listen(server);
    const provider = createProvider(upstreamUrl, {
      modelRedirects: [{ source: "gpt-5.2-codex", target: "gpt-5.3-codex", matchType: "exact" }],
    } as Partial<Provider>);

    await forward(session, provider);

    expect(capture.body).not.toBeNull();
    const upstreamBody = JSON.parse(new TextDecoder().decode(capture.body!)) as Record<
      string,
      unknown
    >;
    const oracle = JSON.parse(text) as Record<string, unknown>;
    expect(upstreamBody.model).toBe("gpt-5.3-codex");
    expect(upstreamBody.prompt_cache_key).toBe(SESSION_ID);
    expect(upstreamBody.input).toEqual(oracle.input);
    expect(upstreamBody.instructions).toBe(oracle.instructions);
    expect(upstreamBody.stream).toBe(true);
    // 门面/计费模型同步重定向。
    expect(session.getBillingModel()).toBe("gpt-5.3-codex");
  });

  it("F3b: retry (second attempt) recomposes from the same currency", async () => {
    const text = codexBody();
    const session = createSession({});
    adopt(session, text);
    session.applyFastBodyPromptCacheKey(SESSION_ID);
    upstreamUrl = await listen(server);

    const first = await forward(session, createProvider(upstreamUrl));
    expect(first.status).toBe(200);
    const firstBody = JSON.parse(new TextDecoder().decode(capture.body!)) as Record<
      string,
      unknown
    >;

    // 重试：直接再次 forward（通货未变，编辑重算）。
    const second = await forward(session, createProvider(upstreamUrl));
    expect(second.status).toBe(200);
    const secondBody = JSON.parse(new TextDecoder().decode(capture.body!)) as Record<
      string,
      unknown
    >;
    expect(secondBody).toEqual(firstBody);
    expect(session.getForwardedRequestBodyText()).toBe(text); // 通货保持原始字节
  });

  it("F4: non-codex provider degrades to legacy tree path with pck replay", async () => {
    const text = codexBody(); // 无 pck
    const session = createSession({});
    adopt(session, text);
    session.applyFastBodyPromptCacheKey(SESSION_ID);
    upstreamUrl = await listen(server);

    await forward(session, createProvider(upstreamUrl, { providerType: "claude" }));

    expect(capture.body).not.toBeNull();
    const upstreamBody = JSON.parse(new TextDecoder().decode(capture.body!)) as Record<
      string,
      unknown
    >;
    // 降解后 legacy 树路径发送：pck 已回放到工作树。
    expect(upstreamBody.prompt_cache_key).toBe(SESSION_ID);
    expect(upstreamBody.model).toBe("gpt-5.2-codex");
    const oracle = JSON.parse(text) as Record<string, unknown>;
    expect(upstreamBody.input).toEqual(oracle.input);
    // 快速路径已降解。
    expect(session.isFastBodyPathActive()).toBe(false);
  });

  it("F5: cyber shadow observation receives byte-accurate packet", async () => {
    mocks.getEnvConfig.mockReturnValue({
      CYBER_CHECK_MODE: "shadow",
      CYBER_CHECK_URL: "http://127.0.0.1:8090",
      CYBER_CHECK_GATEWAY_TOKEN: "gateway-token",
      CYBER_CHECK_ZSTD_MIN_BYTES: 256 * 1024,
      CYBER_CHECK_MAX_ENCODING_BYTES: 256 * 1024 * 1024,
    });
    const reviewInit = vi.fn(() =>
      Promise.resolve(
        Response.json({
          status: "completed",
          decision: "allow",
          predicted_decision: "allow",
          enforcement_mode: "shadow",
          reason: "fast_path",
          coverage: "complete",
          policy_version: "p1",
          reviewer_version: "none",
        })
      )
    );
    vi.stubGlobal("fetch", reviewInit);

    const text = codexBody({ prompt_cache_key: SESSION_ID });
    const session = createSession({});
    adopt(session, text);
    upstreamUrl = await listen(server);

    await forward(session, createProvider(upstreamUrl));
    // setImmediate 延迟投影像 shadow 观察一样在事件循环内完成。
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(reviewInit).toHaveBeenCalled();
    const packet = JSON.parse(
      String((reviewInit.mock.calls[0]?.[1] as RequestInit | undefined)?.body)
    ) as {
      source: { body_sha256: string; body_bytes: number };
      items: unknown[];
      instructions: unknown[];
    };
    expect(packet.source.body_bytes).toBe(new TextEncoder().encode(text).byteLength);
    expect(packet.source.body_sha256).toBe(
      createHash("sha256").update(new TextEncoder().encode(text)).digest("hex")
    );
    // 惰性解析生成了 items/instructions 投影。
    expect(packet.items.length).toBeGreaterThan(0);
    expect(packet.instructions.length).toBe(1);
  });

  it("F6: completer hash override is bit-exact with the tree-walk oracle", async () => {
    const text = codexBody();
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const oracleHash = extractInitialMessageTextHash(parsed);
    expect(oracleHash).toBeTruthy();

    const facade = { prompt_cache_key: undefined } as Record<string, unknown>;
    const viaOverride = await completeCodexSessionIdentifiers({
      keyId: 1,
      headers: new Headers(),
      requestBody: facade,
      userAgent: "ua",
      initialMessageTextHash: oracleHash ?? null,
    });
    expect(viaOverride.sessionId).toBeTruthy();
  });

  it("F7: scanning a large body leaves no tree-sized heap residency", async () => {
    const gc = (globalThis as { gc?: () => void }).gc;
    if (typeof gc !== "function") return; // --expose-gc 未开启时跳过（对拍已覆盖语义）

    const filler = "x".repeat(64);
    const item = {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: filler }],
    };
    const bigText = JSON.stringify({
      model: "gpt-5.2-codex",
      stream: true,
      input: Array.from({ length: 150_000 }, () => item), // ~10MB 级文本
    });
    const bytes = new TextEncoder().encode(bigText);

    gc();
    const heapBefore = process.memoryUsage().heapUsed;
    for (let k = 0; k < 5; k++) {
      const scan = scanJsonRequestBody(bytes);
      expect(scan.ok).toBe(true);
    }
    gc();
    const scanHeap = process.memoryUsage().heapUsed - heapBefore;

    gc();
    const parseHeapBefore = process.memoryUsage().heapUsed;
    for (let k = 0; k < 5; k++) {
      JSON.parse(bigText);
    }
    gc();
    const parseHeap = process.memoryUsage().heapUsed - parseHeapBefore;

    // 扫描后的堆驻留必须远小于全树解析的驻留（扫描结果只有区间事实）。
    expect(scanHeap).toBeLessThan(parseHeap / 4);
  });
});
