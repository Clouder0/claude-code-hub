import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

describe("v1 users authz evidence", () => {
  test("users test file covers auth and CSRF boundaries", () => {
    const source = readFileSync("tests/api/v1/users/users.test.ts", "utf8");

    expect(source).toContain("returns the current user from a Web-tier self list endpoint");
    expect(source).toContain("does not admit read-only credentials to the self management surface");
    expect(source).toContain("maps structured authorization action errors to HTTP status codes");
    expect(source).toContain("PERMISSION_DENIED");
  });
});
