import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProxySession } from "@/app/v1/_lib/proxy/session";
import { isThinkingEnabled } from "@/app/v1/_lib/proxy/anthropic-actual-response-model";

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function createSession(
  requestMessage: Record<string, unknown>,
  options: { highConcurrency?: boolean } = {}
): ProxySession {
  const session = new (
    ProxySession as unknown as {
      new (init: {
        startTime: number;
        method: string;
        requestUrl: URL;
        headers: Headers;
        headerLog: string;
        request: { message: Record<string, unknown>; log: string; model: string | null };
        userAgent: string | null;
        context: unknown;
        clientAbortSignal: AbortSignal | null;
      }): ProxySession;
    }
  )({
    startTime: Date.now(),
    method: "POST",
    requestUrl: new URL("http://localhost/v1/responses"),
    headers: new Headers(),
    headerLog: "",
    request: { message: requestMessage, log: "(test)", model: null },
    userAgent: null,
    context: {},
    clientAbortSignal: null,
  });
  if (options.highConcurrency) {
    session.setHighConcurrencyModeEnabled(true);
  }
  return session;
}

function buildCodexLikeBody(): { body: Record<string, unknown>; serialized: string } {
  const body = {
    model: "gpt-5.6-codex",
    stream: true,
    service_tier: "priority",
    prompt_cache_key: "sess-abc",
    temperature: 0.7,
    thinking: { type: "enabled", budget_tokens: 4096 },
    instructions: "You are a helpful assistant.".repeat(2000),
    input: Array.from({ length: 120 }, (_, i) => ({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: `${i} ${"a".repeat(4096)}` }],
    })),
    tools: [{ type: "function", name: "demo" }],
  };
  return { body, serialized: JSON.stringify(body) };
}

/**
 * 门控提交后释放请求体的契约（2026-08-20 内存优化）：
 * - 释放后 request.message 为冻结空对象、buffer/forwardedRequestBody 清空；
 * - getBillingRequestMessage 返回投影（标量 + thinking），计费字段不变；
 * - 释放幂等；释放后 setForwardedRequestBody 抛错（守卫：不应存在再转发路径）；
 * - isThinkingEnabled 经投影读出的结果与原树一致。
 */
describe("ProxySession.releaseRequestBodyAfterCommit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("releases tree/string/buffer and serves the billing projection", () => {
    const { body, serialized } = buildCodexLikeBody();
    const session = createSession(body);
    session.setForwardedRequestBody(serialized, body);

    session.releaseRequestBodyAfterCommit();

    expect(session.isRequestBodyReleased()).toBe(true);
    expect(session.forwardedRequestBody).toBeNull();
    expect(session.request.message).toEqual({});
    expect(Object.isFrozen(session.request.message)).toBe(true);
    expect(session.request.buffer).toBeUndefined();

    const projection = session.getBillingRequestMessage();
    expect(projection).not.toBeNull();
    expect(projection?.model).toBe("gpt-5.6-codex");
    expect(projection?.stream).toBe(true);
    expect(projection?.service_tier).toBe("priority");
    expect(projection?.prompt_cache_key).toBe("sess-abc");
    expect(projection?.temperature).toBe(0.7);
    expect(projection?.thinking).toEqual({ type: "enabled", budget_tokens: 4096 });
    // 大字段不得进入投影
    expect(projection?.input).toBeUndefined();
    expect(projection?.instructions).toBeUndefined();
    expect(projection?.tools).toBeUndefined();

    expect(session.getBillingModel()).toBe("gpt-5.6-codex");
  });

  it("request.model scalar stays readable after release", () => {
    const { body, serialized } = buildCodexLikeBody();
    const session = createSession(body);
    session.request.model = "gpt-5.6-codex";
    session.setForwardedRequestBody(serialized, body);

    session.releaseRequestBodyAfterCommit();

    expect(session.getCurrentModel()).toBe("gpt-5.6-codex");
  });

  it("is idempotent and keeps the first projection", () => {
    const { body, serialized } = buildCodexLikeBody();
    const session = createSession(body);
    session.setForwardedRequestBody(serialized, body);
    session.releaseRequestBodyAfterCommit();
    const first = session.getBillingRequestMessage();

    session.releaseRequestBodyAfterCommit();

    expect(session.getBillingRequestMessage()).toBe(first);
  });

  it("throws if a re-forward attempts to set the body after release", () => {
    const { body, serialized } = buildCodexLikeBody();
    const session = createSession(body);
    session.setForwardedRequestBody(serialized, body);
    session.releaseRequestBodyAfterCommit();

    expect(() => session.setForwardedRequestBody("{}", {})).toThrowError(/after release/);
  });

  it("billing fallback works when release happens without a forwarded pair (tree only)", () => {
    const body = {
      model: "claude-sonnet-4-6",
      stream: true,
      thinking: { type: "adaptive" },
      messages: [{ role: "user", content: "hi" }],
    };
    const session = createSession(body);

    session.releaseRequestBodyAfterCommit();

    const projection = session.getBillingRequestMessage();
    expect(projection?.model).toBe("claude-sonnet-4-6");
    expect(projection?.thinking).toEqual({ type: "adaptive" });
    expect(projection?.messages).toBeUndefined();
    expect(isThinkingEnabled(projection ?? {})).toBe(true);
    expect(session.getBillingModel()).toBe("claude-sonnet-4-6");
  });

  it("isThinkingEnabled parity: projection matches original tree verdicts", () => {
    const enabled = { thinking: { type: "enabled", budget_tokens: 1024 } };
    const adaptive = { thinking: { type: "adaptive" } };
    const disabled = { thinking: { type: "disabled" } };
    const absent = { model: "x" };

    for (const message of [enabled, adaptive, disabled, absent]) {
      const session = createSession(message);
      const before = isThinkingEnabled(message);
      session.releaseRequestBodyAfterCommit();
      const after = isThinkingEnabled(session.getBillingRequestMessage() ?? {});
      expect(after).toBe(before);
    }
  });

  it("hedge interplay: clearForwardedRequestBody after release keeps released state observable", () => {
    const { body, serialized } = buildCodexLikeBody();
    const session = createSession(body);
    session.request.model = "gpt-5.6-codex"; // 真实会话在创建时解析该标量
    session.setForwardedRequestBody(serialized, body);
    session.releaseRequestBodyAfterCommit();

    session.clearForwardedRequestBody();

    expect(session.isRequestBodyReleased()).toBe(true);
    // getBillingRequestMessage 回退到 request.message（冻结空对象）——计费
    // 字段读取为 undefined，getBillingModel 继续回落 request.model 标量。
    expect(session.getBillingRequestMessage()).toEqual({});
    expect(session.getBillingModel()).toBe("gpt-5.6-codex");
  });

  it("hedge interplay: copyForwardedRequestBodyFrom restores a live pair onto a released target only if forced", () => {
    // 正常时序中 winner sync 发生在提交前，不会命中该形态；这里验证
    // copy 会显式解除 released 状态，避免投影与真实 body 并存的歧义。
    const { body, serialized } = buildCodexLikeBody();
    const source = createSession(body);
    source.setForwardedRequestBody(serialized, body);

    const target = createSession({ model: "other" });
    target.releaseRequestBodyAfterCommit();
    expect(target.isRequestBodyReleased()).toBe(true);

    target.copyForwardedRequestBodyFrom(source);

    expect(target.isRequestBodyReleased()).toBe(false);
    expect(target.getBillingModel()).toBe("gpt-5.6-codex");
  });
});
