import { describe, expect, it, vi } from "vitest";
import { ProxySession } from "@/app/v1/_lib/proxy/session";

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function createSession(requestMessage: Record<string, unknown>): ProxySession {
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
  session.setHighConcurrencyModeEnabled(true);
  return session;
}

function eligibleSession(): ProxySession {
  const session = createSession({
    model: "gpt-5.6-sol",
    stream: true,
    service_tier: "priority",
    instructions: "ctx",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
  });
  session.noteRequestBodyReleaseCandidate();
  session.noteRequestBodyReleaseEligible(); // doForward 的 codex attempt 标记
  return session;
}

describe("request-body release eligibility (abort / final-failure call sites)", () => {
  it("releases body copies for eligible sessions via releaseRequestBodyIfEligible", () => {
    const session = eligibleSession();
    session.request.buffer = new ArrayBuffer(4096);
    expect(session.isRequestBodyReleaseCandidate()).toBe(true);
    expect(session.isRequestBodyReleaseEligible()).toBe(true);

    session.releaseRequestBodyIfEligible();
    expect(session.isRequestBodyReleased()).toBe(true);
    expect(session.request.buffer).toBeUndefined();
    expect(session.forwardedRequestBody).toBeNull();
    // 计费投影仍在。
    expect(session.getBillingModel()).toBe("gpt-5.6-sol");
  });

  it("keeps the body for candidate-only sessions (no codex attempt yet)", () => {
    const session = createSession({ model: "gpt-5.6-sol", stream: true });
    session.noteRequestBodyReleaseCandidate();
    session.request.buffer = new ArrayBuffer(4096);

    session.releaseRequestBodyIfEligible();
    expect(session.isRequestBodyReleased()).toBe(false);
    expect(session.request.buffer).toBeDefined();
  });

  it("keeps the body for sessions outside the retention population", () => {
    const session = createSession({ model: "claude-x", stream: false });
    session.request.buffer = new ArrayBuffer(4096);
    session.releaseRequestBodyIfEligible();
    expect(session.isRequestBodyReleased()).toBe(false);
  });

  it("is idempotent across the success/abort/final-failure call sites", () => {
    const session = eligibleSession();
    session.request.buffer = new ArrayBuffer(4096);
    session.releaseRequestBodyIfEligible();
    session.releaseRequestBodyIfEligible();
    session.releaseRequestBodyIfEligible();
    expect(session.isRequestBodyReleased()).toBe(true);
  });

  it("discharges the working-set lease exactly once on release", () => {
    const session = eligibleSession();
    const release = vi.fn();
    session.attachWorkingSetLease({ release });
    session.releaseRequestBodyIfEligible();
    session.releaseRequestBodyIfEligible();
    expect(release).toHaveBeenCalledOnce();
  });

  it("consumeWorkingSetLeaseIfHeld reports held leases exactly once", () => {
    const session = eligibleSession();
    const release = vi.fn();
    session.attachWorkingSetLease({ release });
    expect(session.consumeWorkingSetLeaseIfHeld()).toBe(true);
    expect(session.consumeWorkingSetLeaseIfHeld()).toBe(false);
    expect(release).toHaveBeenCalledOnce();
    expect(session.consumeWorkingSetLeaseIfHeld()).toBe(false);
  });
});
