import { defineConfig, devices } from "@playwright/test";

const port = process.env.PLAYWRIGHT_PORT ?? "13500";
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${port}`;
const adminToken = process.env.TEST_ADMIN_TOKEN ?? process.env.ADMIN_TOKEN ?? "cch-dev-admin";
const defaultDsn = "postgres://postgres:postgres@127.0.0.1:5432/claude_code_hub_test";
const dsn = process.env.PLAYWRIGHT_DSN ?? process.env.DSN ?? defaultDsn;
const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379/15";
const chromiumExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? "/usr/bin/chromium";

const inheritedEnv = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
);

function assertPlaywrightDsnIsTestDatabase(value: string) {
  let databaseName = value;
  try {
    databaseName = new URL(value).pathname.replace(/^\/+/, "");
  } catch {
    databaseName = value.split("/").pop() ?? value;
  }

  if (!databaseName.endsWith("_test")) {
    throw new Error(
      "Refusing to run Playwright against a non-test database. Use a DSN whose database name ends with _test."
    );
  }
}

assertPlaywrightDsnIsTestDatabase(dsn);

const webServerCommand = process.env.PLAYWRIGHT_WEB_SERVER_COMMAND ?? "bun run dev:playwright";

export default defineConfig({
  testDir: "./tests/playwright",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: { executablePath: chromiumExecutable },
      },
    },
  ],
  webServer: {
    command: webServerCommand,
    env: {
      ...inheritedEnv,
      PORT: port,
      DSN: dsn,
      REDIS_URL: redisUrl,
      ADMIN_TOKEN: adminToken,
      AUTO_MIGRATE: "true",
      ENABLE_RATE_LIMIT: "false",
      SESSION_TOKEN_MODE: "opaque",
      ENABLE_SECURE_COOKIES: "false",
      ENABLE_API_KEY_ADMIN_ACCESS: "false",
    },
    url: baseURL,
    // A reused process may point at a non-test database even when this config's DSN is safe.
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
