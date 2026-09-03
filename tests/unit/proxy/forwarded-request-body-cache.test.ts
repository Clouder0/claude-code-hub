import { describe, expect, test } from "vitest";
import { ProxySession } from "@/app/v1/_lib/proxy/session";

function createSession(requestMessage: Record<string, unknown> = {}): ProxySession {
  return new (
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
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe("ProxySession forwarded request body currency (bytes-as-currency)", () => {
  test("setForwardedRequestBody stores external bytes and demotes the tree to projection", () => {
    const session = createSession();
    const forwarded = { model: "gpt-5.6-codex", stream: true, service_tier: "priority" };
    const bodyString = JSON.stringify(forwarded);

    session.setForwardedRequestBody(bodyString, forwarded);

    expect(session.forwardedRequestBody).toBeInstanceOf(Uint8Array);
    expect(decoder.decode(session.forwardedRequestBody ?? new Uint8Array())).toBe(bodyString);
    // 树即刻退位为投影：深度字段不可达。
    expect(session.isRequestMessageProjection()).toBe(true);
    expect((session.request.message as Record<string, unknown>).input).toBeUndefined();
    // 计费读取投影标量。
    expect(session.getBillingModel()).toBe("gpt-5.6-codex");
    expect(session.getBillingRequestMessage()).toMatchObject({
      model: "gpt-5.6-codex",
      stream: true,
      service_tier: "priority",
    });
  });

  test("getForwardedRequestMessage caches projection only — full tree is never retained", () => {
    const session = createSession();
    const forwarded = {
      model: "a",
      stream: true,
      input: [{ role: "user", content: "x".repeat(64) }],
    };
    session.setForwardedRequestBody(JSON.stringify(forwarded), forwarded);

    const message = session.getForwardedRequestMessage();
    expect(message).toMatchObject({ model: "a", stream: true });
    // 投影键集之外的深度字段不进入缓存。
    expect(message?.input).toBeUndefined();
    expect(message?.thinking).toBeUndefined();
  });

  test("rematerializeRequestMessageForRetry restores the full working tree from bytes", () => {
    const session = createSession();
    const forwarded = {
      model: "a",
      stream: true,
      input: [{ role: "user", content: "payload" }],
    };
    session.setForwardedRequestBody(JSON.stringify(forwarded), forwarded);
    expect(session.isRequestMessageProjection()).toBe(true);

    expect(session.rematerializeRequestMessageForRetry()).toBe(true);
    expect(session.isRequestMessageProjection()).toBe(false);
    expect(session.request.message).toEqual(forwarded);
    // 重物化后通货仍在（下一次序列化会再次退位）。
    expect(session.forwardedRequestBody).toBeInstanceOf(Uint8Array);
  });

  test("rematerialize is a no-op before first send and after release", () => {
    const fresh = createSession({ model: "a", input: [1] });
    expect(fresh.rematerializeRequestMessageForRetry()).toBe(false);

    const session = createSession();
    session.setForwardedRequestBody(JSON.stringify({ model: "a" }), { model: "a" });
    session.noteRequestBodyReleaseEligible();
    session.releaseRequestBodyAfterCommit();
    expect(session.rematerializeRequestMessageForRetry()).toBe(false);
  });

  test("direct byte assignment still lazily projects (fallback path)", () => {
    const session = createSession();
    session.forwardedRequestBody = encoder.encode('{"model":"claude-sonnet-4-6","stream":false}');

    expect(session.getBillingRequestMessage()).toEqual({
      model: "claude-sonnet-4-6",
      stream: false,
    });
    expect(session.getBillingModel()).toBe("claude-sonnet-4-6");
  });

  test("clearForwardedRequestBody drops currency and cached projection", () => {
    const session = createSession({ model: "fallback" });
    const forwarded = { model: "a" };
    session.setForwardedRequestBody(JSON.stringify(forwarded), forwarded);

    session.clearForwardedRequestBody();

    expect(session.forwardedRequestBody).toBeNull();
    // 无 forwarded body 时回退到 session.request.message（本例中已是投影）。
    expect(session.getBillingRequestMessage()).toBe(session.request.message);
    expect(session.getBillingRequestMessage()).toMatchObject({ model: "a" });
  });

  test("copyForwardedRequestBodyFrom carries the currency (hedge winner sync)", () => {
    const source = createSession();
    const forwarded = { model: "a", service_tier: "priority" };
    source.setForwardedRequestBody(JSON.stringify(forwarded), forwarded);

    const target = createSession();
    target.copyForwardedRequestBodyFrom(source);

    expect(target.forwardedRequestBody).toBe(source.forwardedRequestBody);
    expect(target.getBillingRequestMessage()).toMatchObject({
      model: "a",
      service_tier: "priority",
    });
  });

  test("setForwardedRequestBodySummary stores bytes without demoting the tree", () => {
    const session = createSession({ model: "raw", input: [1, 2] });
    session.setForwardedRequestBodySummary("(raw passthrough summary)");

    expect(session.forwardedRequestBody).toBeInstanceOf(Uint8Array);
    expect(session.isRequestMessageProjection()).toBe(false);
    // 摘要非 JSON：投影解析失败回退到完整 request.message。
    expect(session.getBillingRequestMessage()).toBe(session.request.message);
  });

  test("shadow session copy does not leak currency after clear", () => {
    const tracking = createSession();
    const forwarded = { model: "a" };
    tracking.setForwardedRequestBody(JSON.stringify(forwarded), forwarded);

    // createStreamingShadowSession 用 Object.assign 浅拷贝后必须成对清理。
    const shadow = Object.assign(
      Object.create(Object.getPrototypeOf(tracking)),
      tracking
    ) as ProxySession;
    shadow.clearForwardedRequestBody();

    expect(shadow.forwardedRequestBody).toBeNull();
    expect(shadow.getBillingRequestMessage()).toBe(shadow.request.message);
    // 原 session 不受影响。
    expect(tracking.getBillingRequestMessage()).toMatchObject({ model: "a" });
  });
});
