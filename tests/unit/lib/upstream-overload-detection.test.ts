import { describe, expect, it } from "vitest";
import {
  detectUpstreamErrorFromSseOrJsonText,
  detectUpstreamOverloadFromSseOrJsonText,
  resolveFake200EffectiveStatus,
} from "@/lib/utils/upstream-error-detection";

describe("detectUpstreamOverloadFromSseOrJsonText", () => {
  it.each([
    "server_is_overloaded",
    "slow_down",
  ])("detects the structured overload code %s", (code) => {
    const result = detectUpstreamOverloadFromSseOrJsonText(
      JSON.stringify({ error: { code, message: "temporary capacity failure" } })
    );

    expect(result).toMatchObject({ isOverload: true });
  });

  it("detects the observed OpenAI overload message", () => {
    const result = detectUpstreamOverloadFromSseOrJsonText(
      JSON.stringify({
        error: {
          type: "service_unavailable_error",
          code: "service_unavailable_error",
          message: "Our servers are currently overloaded. Please try again later.",
        },
      })
    );

    expect(result).toEqual({
      isOverload: true,
      matcherId: "message_servers_currently_overloaded",
      message: "Our servers are currently overloaded. Please try again later.",
    });
  });

  it("detects a Responses response.failed event", () => {
    const text = [
      "event: response.failed",
      `data: ${JSON.stringify({
        type: "response.failed",
        response: {
          error: {
            code: "server_is_overloaded",
            message: "The model is currently overloaded",
          },
        },
      })}`,
      "",
      "",
    ].join("\n");

    expect(detectUpstreamOverloadFromSseOrJsonText(text)).toMatchObject({
      isOverload: true,
      matcherId: "error_code_server_is_overloaded",
    });
    expect(detectUpstreamErrorFromSseOrJsonText(text)).toMatchObject({
      isError: true,
      code: "FAKE_200_JSON_ERROR_MESSAGE_NON_EMPTY",
    });
  });

  it("treats a top-level SSE error message as both fake 200 and overload", () => {
    const text = [
      "event: error",
      'data: {"message":"Our servers are currently overloaded. Please try again later."}',
      "",
      "",
    ].join("\n");

    expect(detectUpstreamOverloadFromSseOrJsonText(text)).toMatchObject({
      isOverload: true,
    });
    expect(detectUpstreamErrorFromSseOrJsonText(text)).toMatchObject({
      isError: true,
      code: "FAKE_200_JSON_ERROR_MESSAGE_NON_EMPTY",
    });
  });

  it("does not classify generic retry advice as overload", () => {
    expect(
      detectUpstreamOverloadFromSseOrJsonText(
        JSON.stringify({ error: { message: "Please try again later." } })
      )
    ).toEqual({ isOverload: false });
  });

  it("does not inspect model output text", () => {
    expect(
      detectUpstreamOverloadFromSseOrJsonText(
        JSON.stringify({
          type: "response.output_text.delta",
          delta: "The model is currently overloaded",
        })
      )
    ).toEqual({ isOverload: false });
  });
});

describe("resolveFake200EffectiveStatus", () => {
  it("classifies the real-world overload fake-200 body as 503 with overload flag", () => {
    // 2026-09-02 生产实况:datawave-jp2 / backup_clouder_pro2 的 fake-200
    // 曾被推断为 409/502(409 还会落入不可重试语义)。
    const body = JSON.stringify({
      error: { message: "Our servers are currently overloaded. Please try again later." },
    });
    const result = resolveFake200EffectiveStatus(body);
    expect(result.statusCode).toBe(503);
    expect(result.isOverload).toBe(true);
    expect(result.inferred).toBe(true);
    expect(result.matcherId).toBe("message_servers_currently_overloaded");
  });

  it("keeps the conflict inference for non-overload bodies", () => {
    const body = JSON.stringify({
      error: { code: "conflict", message: "request conflicts with an existing item" },
    });
    const result = resolveFake200EffectiveStatus(body);
    expect(result.statusCode).toBe(409);
    expect(result.isOverload).toBe(false);
    expect(result.inferred).toBe(true);
  });

  it("falls back to 502 when no overload or inference matches", () => {
    const body = JSON.stringify({ error: { message: "something odd happened" } });
    const result = resolveFake200EffectiveStatus(body);
    expect(result.statusCode).toBe(502);
    expect(result.isOverload).toBe(false);
    expect(result.inferred).toBe(false);
  });

  it("handles SSE-wrapped overload events", () => {
    const text = `event: error\ndata: ${JSON.stringify({
      type: "error",
      error: { message: "Our servers are currently overloaded. Please try again later." },
    })}\n\n`;
    const result = resolveFake200EffectiveStatus(text);
    expect(result.statusCode).toBe(503);
    expect(result.isOverload).toBe(true);
  });
});
