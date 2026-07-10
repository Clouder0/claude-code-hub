import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { extractApiCredentialFromHeaders } from "@/lib/api/auth-header-extractor";
import type { AuthCredentialType, AuthSession } from "@/lib/auth";
import { AUTH_COOKIE_NAME } from "@/lib/auth-constants";
import { isApiKeyAdminAccessEnabled } from "@/lib/config/env.schema";
import { logger } from "@/lib/logger";
import { CSRF_HEADER } from "./constants";
import { isMutationMethod, verifyCsrfToken } from "./csrf";
import { createProblemResponse } from "./error-envelope";

export type AuthTier = "public" | "read" | "web" | "admin";

export type ResolvedAuth = {
  session: AuthSession | null;
  token: string | null;
  source: "bearer" | "api-key" | "cookie" | "none";
  credentialType: AuthCredentialType;
  allowReadOnlyAccess: boolean;
  adminAuthority: boolean;
};

export async function extractManagementAuthToken(
  c: Context
): Promise<Pick<ResolvedAuth, "token" | "source">> {
  const credential = extractApiCredentialFromHeaders({
    authorization: c.req.header("authorization") ?? null,
    "x-api-key": c.req.header("x-api-key") ?? null,
    "x-goog-api-key": null,
  });
  if (credential.token) {
    return {
      token: credential.token,
      source: credential.source === "bearer" ? "bearer" : "api-key",
    };
  }

  const cookieToken =
    getCookie(c, AUTH_COOKIE_NAME) ||
    getAuthCookieFromHeader(
      AUTH_COOKIE_NAME,
      c.req.header("cookie") ??
        c.req.header("Cookie") ??
        c.req.raw?.headers.get("cookie") ??
        c.req.raw?.headers.get("Cookie")
    );
  return cookieToken ? { token: cookieToken, source: "cookie" } : { token: null, source: "none" };
}

function getAuthCookieFromHeader(
  cookieName: string,
  raw: string | null | undefined
): string | undefined {
  const cookiePairs = raw?.split(";") ?? [];
  for (const pair of cookiePairs) {
    const [name, ...valueParts] = pair.trim().split("=");
    if (name !== cookieName) continue;
    const value = valueParts.join("=").trim();
    if (!value) return undefined;
    try {
      return decodeURIComponent(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export async function resolveAuth(c: Context, tier: AuthTier): Promise<ResolvedAuth | Response> {
  if (tier === "public") {
    return {
      session: null,
      token: null,
      source: "none",
      credentialType: "none",
      allowReadOnlyAccess: true,
      adminAuthority: false,
    };
  }

  const extracted = await extractManagementAuthToken(c);
  if (!extracted.token) {
    return createProblemResponse({
      status: 401,
      instance: new URL(c.req.url).pathname,
      errorCode: "auth.missing",
      detail: "Authentication is required.",
    });
  }

  const allowReadOnlyAccess = tier === "read";
  const [{ isAdminAuthSubject, toEffectiveAuthSession, validateAuthToken }, credentialType] =
    await Promise.all([
      import("@/lib/auth"),
      classifyManagementCredential(extracted.token, extracted.source),
    ]);
  const validatedSession = await validateAuthToken(extracted.token, { allowReadOnlyAccess });
  if (!validatedSession) {
    return createProblemResponse({
      status: 401,
      instance: new URL(c.req.url).pathname,
      errorCode: "auth.invalid",
      detail: "Authentication is invalid or expired.",
    });
  }
  const apiKeyAdminAccessEnabled = isApiKeyAdminAccessEnabled();
  const adminCredentialPermitted =
    credentialType === "admin-token" ||
    (credentialType === "user-api-key" && apiKeyAdminAccessEnabled);
  const adminSubject = isAdminAuthSubject(validatedSession);
  const adminAuthority = adminSubject && adminCredentialPermitted;

  if (
    tier === "admin" &&
    adminSubject &&
    credentialType === "user-api-key" &&
    !apiKeyAdminAccessEnabled
  ) {
    return createProblemResponse({
      status: 403,
      instance: new URL(c.req.url).pathname,
      errorCode: "auth.api_key_admin_disabled",
      detail: "API key admin access is disabled.",
    });
  }

  if (tier === "admin" && !adminAuthority) {
    return createProblemResponse({
      status: 403,
      instance: new URL(c.req.url).pathname,
      errorCode: "auth.forbidden",
      detail: "Admin access is required.",
    });
  }

  const session = toEffectiveAuthSession(validatedSession, adminAuthority);

  if (
    extracted.source === "cookie" &&
    isMutationMethod(c.req.method) &&
    !verifyCsrfToken({
      token: c.req.header(CSRF_HEADER),
      authToken: extracted.token,
      userId: session.user.id,
    })
  ) {
    return createProblemResponse({
      status: 403,
      instance: new URL(c.req.url).pathname,
      errorCode: "auth.csrf_invalid",
      detail: "CSRF token is missing or invalid.",
    });
  }

  return {
    session,
    token: extracted.token,
    source: extracted.source,
    credentialType,
    allowReadOnlyAccess,
    adminAuthority,
  };
}

export async function classifyManagementCredential(
  token: string,
  source: ResolvedAuth["source"]
): Promise<ResolvedAuth["credentialType"]> {
  if (source === "none") return "none";

  const [
    { detectSessionTokenKind, getSessionTokenMode, isSignedAdminAuthToken },
    { config },
    { constantTimeEqual },
  ] = await Promise.all([
    import("@/lib/auth"),
    import("@/lib/config/config"),
    import("@/lib/security/constant-time-compare"),
  ]);

  const adminToken = config.auth.adminToken;
  if (adminToken && constantTimeEqual(token, adminToken)) return "admin-token";
  if (getSessionTokenMode() !== "legacy" && (await isSignedAdminAuthToken(token))) {
    return "admin-token";
  }
  const tokenKind = detectSessionTokenKind(token);
  if (tokenKind === "opaque") {
    return classifyOpaqueSessionCredential(token);
  }
  // Legacy and dual modes store the raw database key in the cookie. Cookie transport does not
  // change credential provenance or grant more authority than the originating key.
  return "user-api-key";
}

async function classifyOpaqueSessionCredential(
  token: string
): Promise<ResolvedAuth["credentialType"]> {
  try {
    const { RedisSessionStore } = await import("@/lib/auth-session-store/redis-session-store");
    const sessionData = await new RedisSessionStore().read(token);
    return sessionData?.userId === -1 && sessionData.credentialType === "admin-token"
      ? "admin-token"
      : "user-api-key";
  } catch (error) {
    logger.warn("[V1Auth] Failed to classify opaque session credential", {
      error: error instanceof Error ? error.message : String(error),
    });
    return "user-api-key";
  }
}

export function requireAuth(tier: AuthTier): MiddlewareHandler {
  return async (c, next) => {
    const resolved = await resolveAuth(c, tier);
    if (resolved instanceof Response) return resolved;

    c.set("auth", resolved);
    const [{ runWithRequestContext }, { runWithAuthSession }, { getClientIp }] = await Promise.all([
      import("@/lib/audit/request-context"),
      import("@/lib/auth"),
      import("@/lib/ip"),
    ]);
    const requestContext = {
      ip: getClientIp(c.req.raw.headers),
      userAgent: c.req.header("user-agent") ?? null,
    };

    if (!resolved.session) {
      return runWithRequestContext(requestContext, next);
    }

    return runWithAuthSession(resolved.session, () => runWithRequestContext(requestContext, next), {
      allowReadOnlyAccess: resolved.allowReadOnlyAccess,
      adminAuthority: resolved.adminAuthority,
    });
  };
}
