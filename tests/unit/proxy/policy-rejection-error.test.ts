import { describe, expect, it } from "vitest";
import {
  categorizeErrorAsync,
  ErrorCategory,
  isPolicyRejectionError,
  policyRejectionCodeOf,
  ProxyError,
  RequestReviewError,
} from "@/app/v1/_lib/proxy/errors";

describe("policy rejection error categorization", () => {
  it("classifies an HTTP structured cyber policy rejection independently of error rules", async () => {
    const parsed = { error: { code: "cyber_policy", message: "blocked" } };
    const error = new ProxyError("blocked", 400, {
      body: JSON.stringify(parsed),
      parsed,
    });

    expect(isPolicyRejectionError(error)).toBe(true);
    expect(policyRejectionCodeOf(error)).toBe("cyber_policy");
    expect(await categorizeErrorAsync(error)).toBe(ErrorCategory.POLICY_REJECTION);
  });

  it("classifies an HTTP structured bio policy rejection identically", async () => {
    const parsed = {
      error: {
        code: "bio_policy",
        message: "This content was flagged for possible biological risk.",
      },
    };
    const error = new ProxyError("flagged", 400, {
      body: JSON.stringify(parsed),
      parsed,
    });

    expect(isPolicyRejectionError(error)).toBe(true);
    expect(policyRejectionCodeOf(error)).toBe("bio_policy");
    expect(await categorizeErrorAsync(error)).toBe(ErrorCategory.POLICY_REJECTION);
  });

  it("classifies an SSE response.failed cyber policy rejection", async () => {
    const rawBody =
      'data: {"type":"response.failed","response":{"error":{"code":"cyber_policy"}}}\n\n';
    const error = new ProxyError("fake 200", 400, {
      body: "blocked",
      rawBody,
    });

    expect(isPolicyRejectionError(error)).toBe(true);
    expect(policyRejectionCodeOf(error)).toBe("cyber_policy");
    expect(await categorizeErrorAsync(error)).toBe(ErrorCategory.POLICY_REJECTION);
  });

  it("classifies an SSE response.failed bio policy rejection", async () => {
    const rawBody =
      'data: {"type":"response.failed","response":{"error":{"code":"bio_policy"}}}\n\n';
    const error = new ProxyError("fake 200", 400, {
      body: "flagged",
      rawBody,
    });

    expect(isPolicyRejectionError(error)).toBe(true);
    expect(policyRejectionCodeOf(error)).toBe("bio_policy");
    expect(await categorizeErrorAsync(error)).toBe(ErrorCategory.POLICY_REJECTION);
  });

  it("derives the code from rawBody when parsed is absent", () => {
    const error = new ProxyError("upstream error", 400, {
      body: "",
      rawBody: '{"error":{"code":"bio_policy"}}',
    });
    expect(policyRejectionCodeOf(error)).toBe("bio_policy");
  });

  it("does not classify message text as a policy rejection signal", async () => {
    const error = new ProxyError("cyber_policy", 400, { body: "cyber_policy" });
    expect(isPolicyRejectionError(error)).toBe(false);
    const bioError = new ProxyError("bio_policy", 400, { body: "bio_policy text" });
    expect(isPolicyRejectionError(bioError)).toBe(false);
  });

  it("does not classify invalid_prompt or ordinary 400s as policy rejections", async () => {
    const parsed = {
      error: {
        code: "invalid_prompt",
        message:
          "Invalid prompt: your prompt was flagged as potentially violating our usage policy.",
      },
    };
    const error = new ProxyError("invalid prompt", 400, {
      body: JSON.stringify(parsed),
      parsed,
    });

    expect(isPolicyRejectionError(error)).toBe(false);
    expect(policyRejectionCodeOf(error)).toBeNull();
    // invalid_prompt 落回通用 4xx 分类（规则或供应商错误），不属于策略拒绝短路。
    const category = await categorizeErrorAsync(error);
    expect(category).not.toBe(ErrorCategory.POLICY_REJECTION);
  });

  it("classifies local request-review outcomes as non-retryable without impersonating cyber_policy", async () => {
    const error = RequestReviewError.restricted();

    expect(await categorizeErrorAsync(error)).toBe(ErrorCategory.NON_RETRYABLE_CLIENT_ERROR);
    expect(isPolicyRejectionError(error)).toBe(false);
    expect(policyRejectionCodeOf(error)).toBeNull();
  });
});
