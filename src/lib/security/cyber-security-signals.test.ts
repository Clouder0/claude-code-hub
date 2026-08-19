import { describe, expect, it } from "vitest";
import {
  containsCyberPolicySignal,
  containsCyberPolicySignalInText,
  detectCyberSecuritySignals,
  detectCyberSecuritySignalsFromText,
} from "./cyber-security-signals";

describe("cyber security signal detection", () => {
  it("detects a structured HTTP cyber policy error", () => {
    expect(
      detectCyberSecuritySignals({ error: { code: "cyber_policy", message: "blocked" } })
    ).toEqual(["cyber_policy"]);
  });

  it("detects response.failed only at the protocol error location", () => {
    const event = {
      type: "response.failed",
      response: { error: { code: "cyber_policy", message: "blocked" } },
    };

    expect(detectCyberSecuritySignals(event)).toEqual(["cyber_policy"]);
    expect(
      detectCyberSecuritySignals({
        type: "response.completed",
        response: { error: { code: "cyber_policy" } },
      })
    ).toEqual([]);
  });

  it("detects only cyber safety buffering objects", () => {
    expect(
      detectCyberSecuritySignals({
        type: "response.output_text.delta",
        safety_buffering: { use_cases: ["cyber"], reasons: ["user_risk"] },
      })
    ).toEqual(["cyber_safety_check"]);
    expect(detectCyberSecuritySignals({ safety_buffering: false })).toEqual([]);
    expect(detectCyberSecuritySignals({ safety_buffering: { use_cases: ["other"] } })).toEqual([]);
  });

  it("deduplicates repeated SSE signals and keeps the two facts separate", () => {
    const text = [
      'event: response.created\ndata: {"type":"response.created","safety_buffering":{"use_cases":["cyber"]}}',
      'data: {"type":"response.output_text.delta","safety_buffering":{"use_cases":["cyber"]}}',
      'event: response.failed\ndata: {"type":"response.failed","response":{"error":{"code":"cyber_policy"}}}',
      "",
    ].join("\n\n");

    expect(detectCyberSecuritySignalsFromText(text)).toEqual([
      "cyber_safety_check",
      "cyber_policy",
    ]);
    expect(containsCyberPolicySignalInText(text)).toBe(true);
  });

  it("does not match text, case variants, or unrelated nested lookalikes", () => {
    expect(containsCyberPolicySignal({ message: "cyber_policy" })).toBe(false);
    expect(containsCyberPolicySignal({ error: { code: "CYBER_POLICY" } })).toBe(false);
    expect(containsCyberPolicySignal({ output: { error: { code: "cyber_policy" } } })).toBe(false);
    expect(containsCyberPolicySignalInText("data: not-json\n\n")).toBe(false);
  });

  it("accepts a BOM-prefixed JSON response and the SSE event name contract", () => {
    expect(detectCyberSecuritySignalsFromText('\ufeff  {"error":{"code":"cyber_policy"}}')).toEqual(
      ["cyber_policy"]
    );
    expect(
      detectCyberSecuritySignals(
        { response: { error: { code: "cyber_policy" } } },
        "response.failed"
      )
    ).toEqual(["cyber_policy"]);
  });

  it("ignores malformed top-level JSON without falling back to text matching", () => {
    expect(detectCyberSecuritySignalsFromText('{"error":{"code":"cyber_policy"}')).toEqual([]);
    expect(detectCyberSecuritySignals(null)).toEqual([]);
  });
});
