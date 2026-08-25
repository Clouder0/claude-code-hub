import { describe, expect, it } from "vitest";
import { EnvSchema } from "@/lib/config/env.schema";

describe("EnvSchema - cyber-check", () => {
  it("defaults the gateway integration to off", () => {
    const parsed = EnvSchema.parse({ NODE_ENV: "test" });

    expect(parsed.CYBER_CHECK_MODE).toBe("off");
    expect(parsed.CYBER_CHECK_GATEWAY_ID).toBe("cch");
    expect(parsed.CYBER_CHECK_URL).toBeUndefined();
    expect(parsed.CYBER_CHECK_GATEWAY_TOKEN).toBeUndefined();
  });

  it("accepts an explicit shadow service configuration", () => {
    const parsed = EnvSchema.parse({
      NODE_ENV: "test",
      CYBER_CHECK_MODE: "shadow",
      CYBER_CHECK_URL: "http://127.0.0.1:8090",
      CYBER_CHECK_GATEWAY_TOKEN: "token",
      CYBER_CHECK_GATEWAY_ID: "cch-staging",
    });

    expect(parsed).toMatchObject({
      CYBER_CHECK_MODE: "shadow",
      CYBER_CHECK_URL: "http://127.0.0.1:8090",
      CYBER_CHECK_GATEWAY_TOKEN: "token",
      CYBER_CHECK_GATEWAY_ID: "cch-staging",
    });
  });

  it("rejects multiline gateway identities", () => {
    expect(() =>
      EnvSchema.parse({ NODE_ENV: "test", CYBER_CHECK_GATEWAY_ID: "cch\nstaging" })
    ).toThrow();
  });
});
