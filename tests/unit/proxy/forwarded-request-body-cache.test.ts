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

describe("ProxySession forwarded request body cache", () => {
  test("setForwardedRequestBody seeds the cache so billing never re-parses the string", () => {
    const session = createSession();
    const forwarded = { model: "gpt-5.6-codex", stream: true, service_tier: "priority" };
    const bodyString = JSON.stringify(forwarded);

    session.setForwardedRequestBody(bodyString, forwarded);

    expect(session.forwardedRequestBody).toBe(bodyString);
    // 同一引用即证明没有发生 lazy JSON.parse。
    expect(session.getBillingRequestMessage()).toBe(forwarded);
    expect(session.getBillingModel()).toBe("gpt-5.6-codex");
  });

  test("legacy direct string assignment still lazily parses (fallback path)", () => {
    const session = createSession();
    session.forwardedRequestBody = '{"model":"claude-sonnet-4-6","stream":false}';

    expect(session.getBillingRequestMessage()).toEqual({
      model: "claude-sonnet-4-6",
      stream: false,
    });
    expect(session.getBillingModel()).toBe("claude-sonnet-4-6");
  });

  test("direct re-assignment of the string invalidates the seeded cache", () => {
    const session = createSession();
    const forwarded = { model: "a", service_tier: "default" };
    session.setForwardedRequestBody(JSON.stringify(forwarded), forwarded);

    session.forwardedRequestBody = '{"model":"b"}';

    expect(session.getBillingRequestMessage()).toEqual({ model: "b" });
  });

  test("clearForwardedRequestBody drops string and cached pair", () => {
    const session = createSession({ model: "fallback" });
    const forwarded = { model: "a" };
    session.setForwardedRequestBody(JSON.stringify(forwarded), forwarded);

    session.clearForwardedRequestBody();

    expect(session.forwardedRequestBody).toBeNull();
    // 无 forwarded body 时回退到 session.request.message。
    expect(session.getBillingRequestMessage()).toBe(session.request.message);
  });

  test("copyForwardedRequestBodyFrom carries string and cached pair (hedge winner sync)", () => {
    const source = createSession();
    const forwarded = { model: "a", service_tier: "priority" };
    const bodyString = JSON.stringify(forwarded);
    source.setForwardedRequestBody(bodyString, forwarded);

    const target = createSession();
    target.copyForwardedRequestBodyFrom(source);

    expect(target.forwardedRequestBody).toBe(bodyString);
    expect(target.getBillingRequestMessage()).toBe(forwarded);
  });

  test("shadow session copy does not leak cached pair after clear", () => {
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
    expect(tracking.getBillingRequestMessage()).toBe(forwarded);
  });
});
