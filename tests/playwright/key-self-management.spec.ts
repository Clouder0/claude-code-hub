import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from "@playwright/test";

type CreatedUser = {
  user: { id: number; name: string; providerGroup?: string | null };
  defaultKey: { id: number; name: string; key: string };
};

type CreatedKey = {
  id: number;
  generatedKey: string;
  name: string;
};

const adminToken = process.env.TEST_ADMIN_TOKEN ?? process.env.ADMIN_TOKEN ?? "cch-dev-admin";
const authCookieName = "auth-token";
const browserErrors = new WeakMap<Page, string[]>();

function isExpectedDisplaySettingsFallback(message: string, sourceUrl: string): boolean {
  if (
    message !== "Failed to load resource: the server responded with a status of 403 (Forbidden)"
  ) {
    return false;
  }

  try {
    return new URL(sourceUrl).pathname === "/api/v1/system/settings";
  } catch {
    return false;
  }
}

test.beforeEach(({ page }) => {
  const errors: string[] = [];
  browserErrors.set(page, errors);

  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const location = message.location();
    if (isExpectedDisplaySettingsFallback(message.text(), location.url)) return;
    const source = location.url ? ` (${location.url}:${location.lineNumber})` : "";
    errors.push(`[console] ${message.text()}${source}`);
  });
  page.on("pageerror", (error) => {
    errors.push(`[pageerror] ${error.stack ?? error.message}`);
  });
});

test.afterEach(async ({ page }, testInfo) => {
  const errors = browserErrors.get(page) ?? [];
  if (errors.length > 0) {
    await testInfo.attach("browser-errors", {
      body: errors.join("\n\n"),
      contentType: "text/plain",
    });
  }
  expect(errors, `Unexpected browser errors:\n${errors.join("\n")}`).toEqual([]);
});

function adminHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${adminToken}` };
}

function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function expectStatus(response: APIResponse, status: number): Promise<void> {
  if (response.status() === status) return;
  const body = await response.text().catch(() => "");
  throw new Error(`${response.url()} returned ${response.status()}, expected ${status}: ${body}`);
}

async function csrfHeaders(page: Page): Promise<Record<string, string>> {
  const response = await page.request.get("/api/v1/auth/csrf");
  await expectStatus(response, 200);
  const body = (await response.json()) as { csrfToken?: string };
  if (!body.csrfToken) throw new Error("GET /api/v1/auth/csrf did not return csrfToken");
  return { "X-CCH-CSRF": body.csrfToken };
}

async function createUser(request: APIRequestContext, name: string): Promise<CreatedUser> {
  const response = await request.post("/api/v1/users", {
    headers: adminHeaders(),
    data: { name, providerGroup: "default", isEnabled: true },
  });
  await expectStatus(response, 201);
  const body = (await response.json()) as CreatedUser;
  expect(body.user.id).toEqual(expect.any(Number));
  expect(body.defaultKey.key).toMatch(/^sk-/);
  return body;
}

async function deleteUserIfExists(request: APIRequestContext, userId: number | undefined) {
  if (!userId) return;
  const response = await request.delete(`/api/v1/users/${userId}`, {
    headers: adminHeaders(),
  });
  if (![204, 404].includes(response.status())) {
    throw new Error(
      `cleanup failed for user ${userId}: ${response.status()} ${await response.text()}`
    );
  }
}

async function createKey(
  request: APIRequestContext,
  userId: number,
  body: Record<string, unknown>
): Promise<CreatedKey> {
  const response = await request.post(`/api/v1/users/${userId}/keys`, {
    headers: adminHeaders(),
    data: { providerGroup: "default", ...body },
  });
  await expectStatus(response, 201);
  return (await response.json()) as CreatedKey;
}

async function loginWithKey(page: Page, key: string): Promise<Record<string, unknown>> {
  await page.goto("/en/login");
  const result = await page.evaluate(async (apiKey) => {
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ key: apiKey }),
    });
    return { status: response.status, body: (await response.json()) as unknown };
  }, key);

  if (result.status !== 200 || !result.body || typeof result.body !== "object") {
    throw new Error(`POST /api/auth/login returned ${result.status}`);
  }
  const authCookies = await page.context().cookies();
  if (!authCookies.some((cookie) => cookie.name === authCookieName)) {
    throw new Error(`POST /api/auth/login did not set ${authCookieName}`);
  }
  return result.body as Record<string, unknown>;
}

async function readGlobalUsageView(request: APIRequestContext): Promise<boolean> {
  const response = await request.get("/api/v1/system/settings", { headers: adminHeaders() });
  await expectStatus(response, 200);
  return Boolean(
    ((await response.json()) as { allowGlobalUsageView?: boolean }).allowGlobalUsageView
  );
}

async function setGlobalUsageView(request: APIRequestContext, enabled: boolean): Promise<void> {
  const response = await request.put("/api/v1/system/settings", {
    headers: adminHeaders(),
    data: { allowGlobalUsageView: enabled },
  });
  await expectStatus(response, 200);
}

test.describe("dashboard self-service authorization", () => {
  test("normal Web users manage only their own keys and see only the user cost leaderboard", async ({
    page,
    request,
  }) => {
    let owner: CreatedUser | undefined;
    let other: CreatedUser | undefined;
    let previousGlobalUsageView: boolean | undefined;

    try {
      previousGlobalUsageView = await readGlobalUsageView(request);
      if (previousGlobalUsageView) await setGlobalUsageView(request, false);

      owner = await createUser(request, uniqueName("pw-owner"));
      other = await createUser(request, uniqueName("pw-other"));
      const ownerLoginKey = await createKey(request, owner.user.id, {
        name: uniqueName("web-login-key"),
        canLoginWebUi: true,
      });
      const otherOwnedKey = await createKey(request, other.user.id, {
        name: uniqueName("other-owned-key"),
        canLoginWebUi: true,
      });

      const loginBody = await loginWithKey(page, ownerLoginKey.generatedKey);
      expect(loginBody.loginType).toBe("dashboard_user");

      const currentUser = await page.request.get("/api/v1/users:self");
      await expectStatus(currentUser, 200);
      await expect(currentUser.json()).resolves.toMatchObject({
        items: [expect.objectContaining({ id: owner.user.id, name: owner.user.name })],
      });
      await expectStatus(await page.request.get("/api/v1/usage-logs"), 200);
      await expectStatus(await page.request.get("/api/v1/sessions"), 200);

      await page.goto("/en/dashboard/users");
      await expect(page).toHaveURL(/\/dashboard\/users/);
      await expect(page.getByText(owner.user.name)).toBeVisible();
      await expect(page.getByText(other.user.name)).toHaveCount(0);

      const ownCreate = await page.request.post("/api/v1/users:self/keys", {
        headers: await csrfHeaders(page),
        data: {
          name: uniqueName("self-api-key"),
          providerGroup: "default",
          canLoginWebUi: true,
        },
      });
      await expectStatus(ownCreate, 201);
      const ownCreateBody = (await ownCreate.json()) as CreatedKey;

      const ownReveal = await page.request.get(`/api/v1/keys/${ownCreateBody.id}:reveal`);
      await expectStatus(ownReveal, 200);
      await expect(ownReveal.json()).resolves.toMatchObject({ key: expect.stringMatching(/^sk-/) });

      const ownPatch = await page.request.patch(`/api/v1/keys/${ownCreateBody.id}`, {
        headers: await csrfHeaders(page),
        data: { name: `${ownCreateBody.name}-renamed`, canLoginWebUi: true, limitDailyUsd: 1 },
      });
      await expectStatus(ownPatch, 200);

      for (const response of [
        await page.request.get(`/api/v1/keys/${otherOwnedKey.id}:reveal`),
        await page.request.patch(`/api/v1/keys/${otherOwnedKey.id}`, {
          headers: await csrfHeaders(page),
          data: { name: `${otherOwnedKey.name}-attack` },
        }),
        await page.request.delete(`/api/v1/keys/${otherOwnedKey.id}`, {
          headers: await csrfHeaders(page),
        }),
        await page.request.get(`/api/v1/users/${other.user.id}/keys`),
      ]) {
        await expectStatus(response, 403);
      }

      const displaySettings = await page.request.get("/api/system-settings");
      await expectStatus(displaySettings, 200);
      const displaySettingsBody = (await displaySettings.json()) as Record<string, unknown>;
      expect(displaySettingsBody).toMatchObject({
        siteTitle: expect.any(String),
        currencyDisplay: expect.any(String),
        billingModelSource: expect.any(String),
      });
      expect(displaySettingsBody).not.toHaveProperty("allowGlobalUsageView");

      await expectStatus(await page.request.get("/api/leaderboard?scope=user&period=daily"), 200);
      for (const scope of ["userCacheHitRate", "provider", "providerCacheHitRate", "model"]) {
        await expectStatus(
          await page.request.get(`/api/leaderboard?scope=${scope}&period=daily`),
          403
        );
      }

      await page.goto("/en/dashboard/leaderboard?scope=provider");
      await expect(page).toHaveURL(/\/dashboard\/leaderboard/);
      await expect(page.getByRole("heading", { name: "Cost Leaderboard" })).toBeVisible();
      await expect(page.getByTestId("leaderboard-primary-tab-user")).toBeVisible();
      await expect(page.getByTestId("leaderboard-primary-tab-provider")).toHaveCount(0);
      await expect(page.getByTestId("leaderboard-primary-tab-model")).toHaveCount(0);

      const providerGroups = await page.request.get("/api/v1/providers/groups");
      await expectStatus(providerGroups, 403);

      const ownDelete = await page.request.delete(`/api/v1/keys/${ownCreateBody.id}`, {
        headers: await csrfHeaders(page),
      });
      await expectStatus(ownDelete, 204);
    } finally {
      if (previousGlobalUsageView !== undefined) {
        await setGlobalUsageView(request, previousGlobalUsageView);
      }
      await deleteUserIfExists(request, owner?.user.id);
      await deleteUserIfExists(request, other?.user.id);
    }
  });

  test("read-only keys stay current-key scoped and cannot reach management surfaces", async ({
    page,
    request,
  }) => {
    let user: CreatedUser | undefined;

    try {
      user = await createUser(request, uniqueName("pw-readonly"));
      const otherSameUserKey = await createKey(request, user.user.id, {
        name: uniqueName("same-user-web-key"),
        canLoginWebUi: true,
      });
      const readonlyKey = await createKey(request, user.user.id, {
        name: uniqueName("readonly-key"),
        canLoginWebUi: false,
      });

      const loginBody = await loginWithKey(page, readonlyKey.generatedKey);
      expect(loginBody.loginType).toBe("readonly_user");

      await page.goto("/en/dashboard/users");
      await expect(page).toHaveURL(/\/my-usage/);

      const metadata = await page.request.get("/api/v1/me/metadata");
      await expectStatus(metadata, 200);
      await expect(metadata.json()).resolves.toMatchObject({
        keyName: readonlyKey.name,
        userName: user.user.name,
      });

      for (const response of [
        await page.request.get("/api/v1/users:self"),
        await page.request.post("/api/v1/users:self/keys", {
          headers: await csrfHeaders(page),
          data: { name: uniqueName("forbidden-key") },
        }),
        await page.request.get(`/api/v1/keys/${otherSameUserKey.id}:reveal`),
        await page.request.get("/api/v1/usage-logs"),
        await page.request.get("/api/v1/sessions"),
        await page.request.get("/api/leaderboard?scope=user&period=daily"),
      ]) {
        expect([401, 403]).toContain(response.status());
      }
    } finally {
      await deleteUserIfExists(request, user?.user.id);
    }
  });
});
