import { describe, expect, it } from "vitest";
import { EncodingCapacity, encodingCapacityCharge } from "@/lib/cyber-check/capacity";

describe("Cyber Check encoding capacity", () => {
  it("admits weighted work and releases an idempotent lease", () => {
    const capacity = new EncodingCapacity();
    const charge = encodingCapacityCharge(1024);
    const limit = charge * 2;

    const first = capacity.tryAcquire(1024, limit);
    const second = capacity.tryAcquire(1024, limit);
    expect(first?.bytes).toBe(charge);
    expect(second?.bytes).toBe(charge);
    expect(capacity.snapshot()).toBe(limit);
    expect(capacity.tryAcquire(0, limit)).toBeNull();

    first?.release();
    first?.release();
    expect(capacity.snapshot()).toBe(charge);
    const replacement = capacity.tryAcquire(1024, limit);
    expect(replacement).not.toBeNull();
    second?.release();
    replacement?.release();
    expect(capacity.snapshot()).toBe(0);
  });

  it("rejects one request that cannot fit without mutating the ledger", () => {
    const capacity = new EncodingCapacity();

    expect(capacity.tryAcquire(1024 * 1024, 64 * 1024)).toBeNull();
    expect(capacity.tryAcquire(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)).toBeNull();
    expect(capacity.snapshot()).toBe(0);
  });
});
