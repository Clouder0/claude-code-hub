import { describe, expect, it } from "vitest";
import {
  containsPolicyRejection,
  containsPolicyRejectionInText,
  detectPolicyRejectionCode,
  detectPolicyRejectionCodeFromText,
  detectSecuritySignals,
  detectSecuritySignalsFromText,
  firstPolicyRejectionCode,
  isPolicyRejectionType,
} from "./security-signals";

describe("security signal detection", () => {
  it("detects a structured HTTP cyber policy error", () => {
    expect(detectSecuritySignals({ error: { code: "cyber_policy", message: "blocked" } })).toEqual([
      "cyber_policy",
    ]);
  });

  it("detects a structured HTTP bio policy error", () => {
    expect(
      detectSecuritySignals({
        error: {
          code: "bio_policy",
          message: "This content was flagged for possible biological risk.",
        },
      })
    ).toEqual(["bio_policy"]);
    expect(detectPolicyRejectionCode({ error: { code: "bio_policy" } })).toBe("bio_policy");
  });

  it("detects response.failed only at the protocol error location", () => {
    const event = {
      type: "response.failed",
      response: { error: { code: "cyber_policy", message: "blocked" } },
    };

    expect(detectSecuritySignals(event)).toEqual(["cyber_policy"]);
    expect(
      detectSecuritySignals({
        type: "response.completed",
        response: { error: { code: "cyber_policy" } },
      })
    ).toEqual([]);
  });

  it("detects bio_policy in a response.failed event", () => {
    const event = {
      type: "response.failed",
      response: { error: { code: "bio_policy", message: "flagged for biological risk" } },
    };

    expect(detectSecuritySignals(event)).toEqual(["bio_policy"]);
    expect(
      detectSecuritySignals({ response: { error: { code: "bio_policy" } } }, "response.failed")
    ).toEqual(["bio_policy"]);
  });

  it("prefers cyber when both rejection codes are present", () => {
    const text = [
      'event: response.failed\ndata: {"type":"response.failed","response":{"error":{"code":"bio_policy"}}}',
      'data: {"error":{"code":"cyber_policy"}}',
      "",
    ].join("\n\n");

    const signals = detectSecuritySignalsFromText(text);
    expect(signals).toContain("bio_policy");
    expect(signals).toContain("cyber_policy");
    expect(firstPolicyRejectionCode(signals)).toBe("cyber_policy");
    expect(detectPolicyRejectionCodeFromText(text)).toBe("cyber_policy");
  });

  it("detects only cyber safety buffering objects", () => {
    expect(
      detectSecuritySignals({
        type: "response.output_text.delta",
        safety_buffering: { use_cases: ["cyber"], reasons: ["user_risk"] },
      })
    ).toEqual(["cyber_safety_check"]);
    expect(detectSecuritySignals({ safety_buffering: false })).toEqual([]);
    expect(detectSecuritySignals({ safety_buffering: { use_cases: ["other"] } })).toEqual([]);
    expect(detectSecuritySignals({ safety_buffering: { use_cases: ["bio"] } })).toEqual([]);
  });

  it("deduplicates repeated SSE signals and keeps the facts separate", () => {
    const text = [
      'event: response.created\ndata: {"type":"response.created","safety_buffering":{"use_cases":["cyber"]}}',
      'data: {"type":"response.output_text.delta","safety_buffering":{"use_cases":["cyber"]}}',
      'event: response.failed\ndata: {"type":"response.failed","response":{"error":{"code":"cyber_policy"}}}',
      "",
    ].join("\n\n");

    expect(detectSecuritySignalsFromText(text)).toEqual(["cyber_safety_check", "cyber_policy"]);
    expect(containsPolicyRejectionInText(text)).toBe(true);
  });

  it("deduplicates repeated bio signals across SSE frames", () => {
    const text = [
      'event: response.failed\ndata: {"type":"response.failed","response":{"error":{"code":"bio_policy"}}}',
      'event: response.failed\ndata: {"type":"response.failed","response":{"error":{"code":"bio_policy"}}}',
      "",
    ].join("\n\n");

    expect(detectSecuritySignalsFromText(text)).toEqual(["bio_policy"]);
    expect(detectPolicyRejectionCodeFromText(text)).toBe("bio_policy");
  });

  it("does not match text, case variants, or unrelated nested lookalikes", () => {
    expect(containsPolicyRejection({ message: "cyber_policy" })).toBe(false);
    expect(containsPolicyRejection({ message: "bio_policy" })).toBe(false);
    expect(containsPolicyRejection({ error: { code: "CYBER_POLICY" } })).toBe(false);
    expect(containsPolicyRejection({ error: { code: "BIO_POLICY" } })).toBe(false);
    expect(containsPolicyRejection({ error: { code: "invalid_prompt" } })).toBe(false);
    expect(containsPolicyRejection({ output: { error: { code: "cyber_policy" } } })).toBe(false);
    expect(
      containsPolicyRejection({ nested: { response: { error: { code: "bio_policy" } } } })
    ).toBe(false);
    expect(containsPolicyRejectionInText("data: not-json\n\n")).toBe(false);
  });

  it("accepts a BOM-prefixed JSON response and the SSE event name contract", () => {
    expect(detectSecuritySignalsFromText('\ufeff  {"error":{"code":"cyber_policy"}}')).toEqual([
      "cyber_policy",
    ]);
    expect(detectSecuritySignalsFromText('\ufeff  {"error":{"code":"bio_policy"}}')).toEqual([
      "bio_policy",
    ]);
    expect(
      detectSecuritySignals({ response: { error: { code: "cyber_policy" } } }, "response.failed")
    ).toEqual(["cyber_policy"]);
  });

  it("ignores malformed top-level JSON without falling back to text matching", () => {
    expect(detectSecuritySignalsFromText('{"error":{"code":"cyber_policy"}')).toEqual([]);
    expect(detectSecuritySignalsFromText('{"error":{"code":"bio_policy"}')).toEqual([]);
    expect(detectSecuritySignals(null)).toEqual([]);
  });

  it("keeps the closed type partition: rejection codes vs additional checks", () => {
    expect(isPolicyRejectionType("cyber_policy")).toBe(true);
    expect(isPolicyRejectionType("bio_policy")).toBe(true);
    expect(isPolicyRejectionType("cyber_safety_check")).toBe(false);
  });
});
