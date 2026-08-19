import { describe, expect, it } from "vitest";
import {
  categorizeErrorAsync,
  ErrorCategory,
  isCyberPolicyError,
  ProxyError,
} from "@/app/v1/_lib/proxy/errors";

describe("cyber policy error categorization", () => {
  it("classifies an HTTP structured policy rejection independently of error rules", async () => {
    const parsed = { error: { code: "cyber_policy", message: "blocked" } };
    const error = new ProxyError("blocked", 400, {
      body: JSON.stringify(parsed),
      parsed,
    });

    expect(isCyberPolicyError(error)).toBe(true);
    expect(await categorizeErrorAsync(error)).toBe(ErrorCategory.CYBER_POLICY);
  });

  it("classifies an SSE response.failed policy rejection", async () => {
    const rawBody =
      'data: {"type":"response.failed","response":{"error":{"code":"cyber_policy"}}}\n\n';
    const error = new ProxyError("fake 200", 400, {
      body: "blocked",
      rawBody,
    });

    expect(isCyberPolicyError(error)).toBe(true);
    expect(await categorizeErrorAsync(error)).toBe(ErrorCategory.CYBER_POLICY);
  });

  it("does not classify message text as a cyber policy signal", async () => {
    const error = new ProxyError("cyber_policy", 400, { body: "cyber_policy" });
    expect(isCyberPolicyError(error)).toBe(false);
  });
});
