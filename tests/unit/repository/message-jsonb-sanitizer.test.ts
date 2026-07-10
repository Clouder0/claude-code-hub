import { describe, expect, it } from "vitest";
import { sanitizeMessageRequestJsonbValue } from "@/repository/message-request-jsonb-sanitizer";

describe("message_request JSONB sanitizer", () => {
  it("sanitizes unsafe control characters and isolated surrogates in nested values", () => {
    const input = {
      provider: "bad\u0000provider\u0001name",
      nested: ["left\ud800", "right\udc00", "valid \u{1f600} pair"],
    };

    expect(sanitizeMessageRequestJsonbValue(input)).toEqual({
      provider: "badprovider name",
      nested: ["left\uFFFD", "right\uFFFD", "valid \u{1f600} pair"],
    });
  });

  it("sanitizes object keys without losing prototype-shaped keys or valid surrogate pairs", () => {
    const input: Record<string, unknown> = {};
    Object.defineProperty(input, "bad\u0000key\ud800", {
      value: "value \u{1f600}",
      enumerable: true,
    });
    Object.defineProperty(input, "__proto__", {
      value: "kept",
      enumerable: true,
    });

    const sanitized = sanitizeMessageRequestJsonbValue(input);

    expect(Object.keys(sanitized)).toEqual(["badkey\uFFFD", "__proto__"]);
    expect(sanitized["badkey\uFFFD"]).toBe("value \u{1f600}");
    expect(sanitized.__proto__).toBe("kept");
  });
});
