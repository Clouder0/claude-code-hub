import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_FORWARD_TOTAL_DEADLINE_MS,
  resolveForwardTotalDeadlineMs,
} from "@/app/v1/_lib/proxy/forwarder";

describe("forward ladder total deadline", () => {
  const previous = process.env.CCH_FORWARD_TOTAL_DEADLINE_MS;

  afterEach(() => {
    if (previous === undefined) {
      delete process.env.CCH_FORWARD_TOTAL_DEADLINE_MS;
    } else {
      process.env.CCH_FORWARD_TOTAL_DEADLINE_MS = previous;
    }
  });

  it("defaults to 90s", () => {
    delete process.env.CCH_FORWARD_TOTAL_DEADLINE_MS;
    expect(resolveForwardTotalDeadlineMs()).toBe(DEFAULT_FORWARD_TOTAL_DEADLINE_MS);
    expect(DEFAULT_FORWARD_TOTAL_DEADLINE_MS).toBe(90_000);
  });

  it("honors explicit values including disabled", () => {
    process.env.CCH_FORWARD_TOTAL_DEADLINE_MS = "45000";
    expect(resolveForwardTotalDeadlineMs()).toBe(45_000);
    process.env.CCH_FORWARD_TOTAL_DEADLINE_MS = "0";
    expect(resolveForwardTotalDeadlineMs()).toBe(0);
  });

  it("falls back to the default on malformed values", () => {
    process.env.CCH_FORWARD_TOTAL_DEADLINE_MS = "soon";
    expect(resolveForwardTotalDeadlineMs()).toBe(DEFAULT_FORWARD_TOTAL_DEADLINE_MS);
    process.env.CCH_FORWARD_TOTAL_DEADLINE_MS = "-5";
    expect(resolveForwardTotalDeadlineMs()).toBe(DEFAULT_FORWARD_TOTAL_DEADLINE_MS);
  });
});
