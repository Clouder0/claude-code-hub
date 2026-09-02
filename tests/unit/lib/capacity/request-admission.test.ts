import { describe, expect, it } from "vitest";
import {
  admissionCharge,
  RequestAdmission,
  resolveRequestAdmissionConfigFromEnv,
} from "@/lib/capacity/request-admission";

describe("RequestAdmission working-set gauge", () => {
  it("charges fixed overhead plus multiplier times body bytes", () => {
    expect(admissionCharge(1000, 5)).toBe(64 * 1024 + 5000);
    expect(admissionCharge(0, 5)).toBe(64 * 1024);
    expect(admissionCharge(-1, 5)).toBe(Number.POSITIVE_INFINITY);
    expect(admissionCharge(Number.NaN, 5)).toBe(Number.POSITIVE_INFINITY);
  });

  it("admits while in-use stays within the watermark and rejects past it", () => {
    // 每租约计费 = 64KB 固定开销 + 400B(multiplier=1);水位 200_000B 容 3 不容 4。
    const admission = new RequestAdmission({ maxRetainedBytes: 200_000, bodyMultiplier: 1 });
    const leases = [];
    for (let i = 0; i < 3; i += 1) {
      const lease = admission.tryAcquire(400);
      expect(lease).not.toBeNull();
      leases.push(lease!);
    }
    expect(admission.tryAcquire(400)).toBeNull(); // 水位已满
    // 单体计费超水位同样拒绝。
    expect(admission.tryAcquire(Number.MAX_SAFE_INTEGER)).toBeNull();
    expect(admission.snapshot().rejections).toBe(2);

    leases[0]!.release();
    const readmitted = admission.tryAcquire(400);
    expect(readmitted).not.toBeNull(); // 退费后可再入
    readmitted!.release();
    for (const lease of leases.slice(1)) lease.release();

    const snapshot = admission.snapshot();
    expect(snapshot.inUseBytes).toBe(0);
    expect(snapshot.highWaterBytes).toBe(3 * (64 * 1024 + 400));
    expect(snapshot.activeLeases).toBe(0);
    expect(snapshot.acquires).toBe(4);
  });

  it("releases each lease exactly once", () => {
    const admission = new RequestAdmission({ maxRetainedBytes: 1_000_000, bodyMultiplier: 1 });
    const lease = admission.tryAcquire(1000)!;
    lease.release();
    lease.release();
    lease.release();
    const snapshot = admission.snapshot();
    expect(snapshot.inUseBytes).toBe(0);
    expect(snapshot.activeLeases).toBe(0);
    expect(snapshot.acquires).toBe(1);
  });

  it("disabled watermark always grants zero-charge leases and never rejects", () => {
    const admission = new RequestAdmission({ maxRetainedBytes: 0, bodyMultiplier: 5 });
    for (let i = 0; i < 3; i += 1) {
      const lease = admission.tryAcquire(10 * 1024 * 1024);
      expect(lease).not.toBeNull();
      expect(lease!.chargedBytes).toBe(0);
      lease!.release();
    }
    expect(admission.snapshot().rejections).toBe(0);
    expect(admission.snapshot().inUseBytes).toBe(0);
  });

  it("records charge and window summaries from released leases", () => {
    const admission = new RequestAdmission({ maxRetainedBytes: 1_000_000_000, bodyMultiplier: 5 });
    const lease = admission.tryAcquire(2000)!;
    // charge 在授予时记录;window(保留时长)在释放时才有样本。
    expect(admission.snapshot().chargeBytes).not.toBeNull();
    expect(admission.snapshot().chargeBytes!.max).toBe(64 * 1024 + 10_000);
    expect(admission.snapshot().windowMs).toBeNull();
    lease.release();
    const snapshot = admission.snapshot();
    expect(snapshot.windowMs).not.toBeNull();
    expect(snapshot.windowMs!.max).toBeGreaterThanOrEqual(0);
  });

  it("parses admission env config with safe defaults", () => {
    const previousMax = process.env.CCH_ADMISSION_MAX_RETAINED_BYTES;
    const previousMultiplier = process.env.CCH_ADMISSION_BODY_MULTIPLIER;
    try {
      delete process.env.CCH_ADMISSION_MAX_RETAINED_BYTES;
      delete process.env.CCH_ADMISSION_BODY_MULTIPLIER;
      expect(resolveRequestAdmissionConfigFromEnv()).toEqual({
        maxRetainedBytes: 0,
        bodyMultiplier: 5,
      });
      process.env.CCH_ADMISSION_MAX_RETAINED_BYTES = "123456789";
      process.env.CCH_ADMISSION_BODY_MULTIPLIER = "7";
      expect(resolveRequestAdmissionConfigFromEnv()).toEqual({
        maxRetainedBytes: 123456789,
        bodyMultiplier: 7,
      });
      process.env.CCH_ADMISSION_MAX_RETAINED_BYTES = "-5";
      expect(resolveRequestAdmissionConfigFromEnv().maxRetainedBytes).toBe(0);
    } finally {
      if (previousMax === undefined) {
        delete process.env.CCH_ADMISSION_MAX_RETAINED_BYTES;
      } else {
        process.env.CCH_ADMISSION_MAX_RETAINED_BYTES = previousMax;
      }
      if (previousMultiplier === undefined) {
        delete process.env.CCH_ADMISSION_BODY_MULTIPLIER;
      } else {
        process.env.CCH_ADMISSION_BODY_MULTIPLIER = previousMultiplier;
      }
    }
  });
});
