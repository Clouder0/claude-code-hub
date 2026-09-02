import { describe, expect, it, vi } from "vitest";
import { RequestAdmission } from "@/lib/capacity/request-admission";
import { tryAcquireRequestWorkingSetOrRespond } from "@/app/v1/_lib/proxy/admission-guard";
import type { ProxySession } from "@/app/v1/_lib/proxy/session";

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function fakeSession(candidate: boolean, receivedBytes: number | null): ProxySession {
  return {
    isRequestBodyReleaseCandidate: () => candidate,
    receivedBodyBytes: receivedBytes,
    attachWorkingSetLease: vi.fn(),
  } as unknown as ProxySession;
}

describe("admission guard (working-set intake boundary)", () => {
  it("passes through sessions outside the retention population without charging", () => {
    const admission = new RequestAdmission({ maxRetainedBytes: 1000, bodyMultiplier: 5 });
    const session = fakeSession(false, 5 * 1024 * 1024);
    expect(tryAcquireRequestWorkingSetOrRespond(session, admission)).toBeNull();
    expect(session.attachWorkingSetLease).not.toHaveBeenCalled();
  });

  it("attaches a lease when the watermark admits the request", () => {
    const admission = new RequestAdmission({
      maxRetainedBytes: 64 * 1024 * 1024,
      bodyMultiplier: 5,
    });
    const session = fakeSession(true, 1024 * 1024);
    expect(tryAcquireRequestWorkingSetOrRespond(session, admission)).toBeNull();
    expect(session.attachWorkingSetLease).toHaveBeenCalledOnce();
    expect(admission.snapshot().activeLeases).toBe(1);
  });

  it("rejects with 429 + Retry-After when the watermark is exhausted", () => {
    const admission = new RequestAdmission({ maxRetainedBytes: 64 * 1024, bodyMultiplier: 5 });
    const session = fakeSession(true, 10 * 1024 * 1024);
    const response = tryAcquireRequestWorkingSetOrRespond(session, admission);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(429);
    expect(response!.headers.get("Retry-After")).toBe("3");
    expect(session.attachWorkingSetLease).not.toHaveBeenCalled();
    expect(admission.snapshot().rejections).toBe(1);
    // 拒绝不产生租约:退费路径不可能被跳过。
    expect(admission.snapshot().activeLeases).toBe(0);
  });

  it("always grants when the watermark is disabled", () => {
    const admission = new RequestAdmission({ maxRetainedBytes: 0, bodyMultiplier: 5 });
    const session = fakeSession(true, 512 * 1024 * 1024);
    expect(tryAcquireRequestWorkingSetOrRespond(session, admission)).toBeNull();
    expect(session.attachWorkingSetLease).toHaveBeenCalledOnce();
  });
});
