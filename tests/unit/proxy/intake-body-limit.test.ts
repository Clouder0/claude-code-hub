import { describe, expect, it } from "vitest";
import {
  MAX_COMPRESSED_REQUEST_BYTES,
  MAX_DECOMPRESSED_REQUEST_BYTES,
  resolveIntakeBodyLimitBytes,
} from "@/app/v1/_lib/proxy/request-body-codec";

describe("intake body limit resolution", () => {
  it("maps uncompressed bodies to the decompressed ceiling", () => {
    expect(resolveIntakeBodyLimitBytes(null)).toBe(MAX_DECOMPRESSED_REQUEST_BYTES);
    expect(resolveIntakeBodyLimitBytes(undefined)).toBe(MAX_DECOMPRESSED_REQUEST_BYTES);
    expect(resolveIntakeBodyLimitBytes("")).toBe(MAX_DECOMPRESSED_REQUEST_BYTES);
    expect(resolveIntakeBodyLimitBytes("identity")).toBe(MAX_DECOMPRESSED_REQUEST_BYTES);
  });

  it("maps encoded bodies to the compressed ceiling", () => {
    expect(resolveIntakeBodyLimitBytes("gzip")).toBe(MAX_COMPRESSED_REQUEST_BYTES);
    expect(resolveIntakeBodyLimitBytes("br, gzip")).toBe(MAX_COMPRESSED_REQUEST_BYTES);
    expect(resolveIntakeBodyLimitBytes("zstd")).toBe(MAX_COMPRESSED_REQUEST_BYTES);
  });

  it("keeps both ceilings at the canonical 100MB default unless overridden by env", () => {
    // 基线断言:规范常量默认 100MB(env 可覆盖,此处不设 env)。
    expect(MAX_DECOMPRESSED_REQUEST_BYTES).toBe(100 * 1024 * 1024);
    expect(MAX_COMPRESSED_REQUEST_BYTES).toBe(MAX_DECOMPRESSED_REQUEST_BYTES);
  });
});
