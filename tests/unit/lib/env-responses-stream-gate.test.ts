import { describe, expect, it } from "vitest";
import { EnvSchema } from "@/lib/config/env.schema";

describe("Responses stream gate environment", () => {
  it("defaults to enforce with independently bounded ordinary and request-echo prefixes", () => {
    const parsed = EnvSchema.parse({ NODE_ENV: "test" });
    expect(parsed).toMatchObject({
      STREAM_GATE_MODE: "enforce",
      STREAM_GATE_PREBUFFER_EVENT_CAP: 64,
      STREAM_GATE_PREBUFFER_BYTE_CAP: 512 * 1024,
      STREAM_GATE_REQUEST_ECHO_BYTE_CAP: 4 * 1024 * 1024,
    });
  });

  it("accepts rollback modes and explicit caps", () => {
    const parsed = EnvSchema.parse({
      NODE_ENV: "test",
      STREAM_GATE_MODE: "shadow",
      STREAM_GATE_PREBUFFER_EVENT_CAP: "32",
      STREAM_GATE_PREBUFFER_BYTE_CAP: String(256 * 1024),
      STREAM_GATE_REQUEST_ECHO_BYTE_CAP: String(2 * 1024 * 1024),
    });
    expect(parsed).toMatchObject({
      STREAM_GATE_MODE: "shadow",
      STREAM_GATE_PREBUFFER_EVENT_CAP: 32,
      STREAM_GATE_PREBUFFER_BYTE_CAP: 256 * 1024,
      STREAM_GATE_REQUEST_ECHO_BYTE_CAP: 2 * 1024 * 1024,
    });
  });

  it("rejects unbounded or nonsensical caps", () => {
    expect(() =>
      EnvSchema.parse({ NODE_ENV: "test", STREAM_GATE_PREBUFFER_EVENT_CAP: "0" })
    ).toThrow();
    expect(() =>
      EnvSchema.parse({
        NODE_ENV: "test",
        STREAM_GATE_REQUEST_ECHO_BYTE_CAP: String(65 * 1024 * 1024),
      })
    ).toThrow();
  });
});
