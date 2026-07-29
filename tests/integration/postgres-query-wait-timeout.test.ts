import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

interface ProbeResult {
  fetchTypes: boolean;
  caughtName?: string;
  caughtMessage?: string;
  caughtCode?: string;
  unhandledBeforeEnd: number;
  unhandled: Array<{ name?: string; message?: string; code?: string }>;
}

const probePath = path.resolve(
  process.cwd(),
  "tests/fixtures/postgres-query-wait-timeout-probe.mjs"
);

function runProbe(fetchTypes: boolean): ProbeResult {
  const result = spawnSync(process.execPath, [probePath], {
    encoding: "utf8",
    env: {
      ...process.env,
      PROBE_FETCH_TYPES: String(fetchTypes),
    },
    timeout: 5_000,
  });

  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout.trim()) as ProbeResult;
}

describe("postgres.js query_wait_timeout first-connect behavior", () => {
  it("reproduces the extra private rejection when dynamic type discovery is enabled", () => {
    const result = runProbe(true);

    expect(result.caughtMessage).toBe("query_wait_timeout");
    expect(result.caughtCode).toBe("57014");
    expect(result.unhandledBeforeEnd).toBe(1);
    expect(result.unhandled).toEqual([
      expect.objectContaining({
        name: "PostgresError",
        message: "query_wait_timeout",
        code: "57014",
      }),
    ]);
  });

  it("contains the failure inside the awaited query when dynamic type discovery is disabled", () => {
    const result = runProbe(false);

    expect(result.caughtName).toBeTruthy();
    expect(result.unhandledBeforeEnd).toBe(0);
    expect(result.unhandled).toEqual([]);
  });
});
