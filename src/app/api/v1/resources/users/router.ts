import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { requireAuth } from "@/lib/api/v1/_shared/auth-middleware";
import { fromZodError } from "@/lib/api/v1/_shared/error-envelope";
import { ProblemJsonSchema } from "@/lib/api/v1/schemas/_common";
import {
  GenericUserResponseSchema,
  StringListResponseSchema,
  UserAllLimitUsageResponseSchema,
  UserBioRestrictionReleaseSchema,
  UserBioUnconfirmedLocalReleaseSchema,
  UserCreateSchema,
  UserCyberClientInstanceResetSchema,
  UserCyberManualClientRestrictionSchema,
  UserCyberPrincipalResetSchema,
  UserCyberStateResponseSchema,
  UserDetailResponseSchema,
  UserEnableSchema,
  UserFilterSearchQuerySchema,
  UserIdParamSchema,
  UserLimitUsageResponseSchema,
  UserListQuerySchema,
  UserListResponseSchema,
  UserRenewSchema,
  UsersBatchUpdateSchema,
  UsersUsageBatchSchema,
  UserUpdateSchema,
} from "@/lib/api/v1/schemas/users";
import {
  batchUpdateUsers,
  createUser,
  deleteUser,
  enableUser,
  filterSearchUsers,
  getUser,
  getUserAllLimitUsage,
  getUserCyberState,
  getUserKeyGroups,
  getUserLimitUsage,
  getUsersUsage,
  getUserTags,
  listCurrentUser,
  listUsers,
  releaseLocalUnconfirmedBioContainment,
  releaseUserBioRestriction,
  renewUser,
  resetUserCyberClientInstance,
  resetUserCyberPrincipal,
  resetUserLimits,
  resetUserStatistics,
  searchUsers,
  setUserCyberManualClientRestriction,
  updateUser,
} from "./handlers";

export const usersRouter = new OpenAPIHono({
  defaultHook: (result, c) => {
    if (!result.success) return fromZodError(result.error, new URL(c.req.url).pathname);
  },
});

const security: Array<Record<string, string[]>> = [
  { cookieAuth: [] },
  { bearerAuth: [] },
  { apiKeyAuth: [] },
];

const problemResponses = {
  400: {
    description: "Invalid request.",
    content: { "application/problem+json": { schema: ProblemJsonSchema } },
  },
  401: {
    description: "Authentication required.",
    content: { "application/problem+json": { schema: ProblemJsonSchema } },
  },
  403: {
    description: "Admin access required.",
    content: { "application/problem+json": { schema: ProblemJsonSchema } },
  },
  404: {
    description: "User not found.",
    content: { "application/problem+json": { schema: ProblemJsonSchema } },
  },
  500: {
    description: "Internal server error.",
    content: { "application/problem+json": { schema: ProblemJsonSchema } },
  },
  503: {
    description: "Dependency unavailable.",
    content: { "application/problem+json": { schema: ProblemJsonSchema } },
  },
} as const;

usersRouter.openapi(
  createRoute({
    method: "get",
    path: "/users",
    middleware: requireAuth("admin"),
    tags: ["Users"],
    summary: "List users",
    description: "Lists users with cursor pagination and dashboard filters.",
    "x-required-access": "admin",
    security,
    request: { query: UserListQuerySchema },
    responses: {
      200: {
        description: "User page.",
        content: { "application/json": { schema: UserListResponseSchema } },
      },
      ...problemResponses,
    },
  }),
  listUsers as never
);

usersRouter.openapi(
  createRoute({
    method: "post",
    path: "/users",
    middleware: requireAuth("admin"),
    tags: ["Users"],
    summary: "Create user",
    description: "Creates a user, optionally with a default key.",
    "x-required-access": "admin",
    security,
    request: {
      body: { required: true, content: { "application/json": { schema: UserCreateSchema } } },
    },
    responses: {
      201: {
        description: "Created user.",
        content: { "application/json": { schema: GenericUserResponseSchema } },
      },
      ...problemResponses,
    },
  }),
  createUser as never
);

usersRouter.openapi(
  createRoute({
    method: "get",
    path: "/users:self",
    middleware: requireAuth("web"),
    tags: ["Users"],
    summary: "List current user",
    description: "Returns the current Web user in the legacy users-page list shape.",
    "x-required-access": "web",
    security,
    responses: {
      200: {
        description: "Current user list page.",
        content: { "application/json": { schema: UserListResponseSchema } },
      },
      ...problemResponses,
    },
  }),
  listCurrentUser as never
);

usersRouter.openapi(
  createRoute({
    method: "get",
    path: "/users/tags",
    middleware: requireAuth("admin"),
    tags: ["Users"],
    summary: "List user tags",
    description: "Lists distinct user tags.",
    "x-required-access": "admin",
    security,
    responses: {
      200: {
        description: "User tags.",
        content: { "application/json": { schema: StringListResponseSchema } },
      },
      ...problemResponses,
    },
  }),
  getUserTags as never
);

usersRouter.openapi(
  createRoute({
    method: "get",
    path: "/users/key-groups",
    middleware: requireAuth("admin"),
    tags: ["Users"],
    summary: "List user key groups",
    description: "Lists distinct key provider groups used by users.",
    "x-required-access": "admin",
    security,
    responses: {
      200: {
        description: "User key groups.",
        content: { "application/json": { schema: StringListResponseSchema } },
      },
      ...problemResponses,
    },
  }),
  getUserKeyGroups as never
);

usersRouter.openapi(
  createRoute({
    method: "get",
    path: "/users:filter-search",
    middleware: requireAuth("admin"),
    tags: ["Users"],
    summary: "Search users for filters",
    description: "Returns compact user options for filter controls.",
    "x-required-access": "admin",
    security,
    request: { query: UserFilterSearchQuerySchema },
    responses: {
      200: {
        description: "User options.",
        content: { "application/json": { schema: GenericUserResponseSchema } },
      },
      ...problemResponses,
    },
  }),
  filterSearchUsers as never
);

usersRouter.openapi(
  createRoute({
    method: "get",
    path: "/users:search",
    middleware: requireAuth("admin"),
    tags: ["Users"],
    summary: "Search users",
    description: "Returns user search results.",
    "x-required-access": "admin",
    security,
    request: { query: UserFilterSearchQuerySchema },
    responses: {
      200: {
        description: "Search results.",
        content: { "application/json": { schema: GenericUserResponseSchema } },
      },
      ...problemResponses,
    },
  }),
  searchUsers as never
);

usersRouter.openapi(
  createRoute({
    method: "post",
    path: "/users:usageBatch",
    middleware: requireAuth("admin"),
    tags: ["Users"],
    summary: "Batch get user key usage",
    description: "Returns lazy-loaded usage fields for a batch of users.",
    "x-required-access": "admin",
    security,
    request: {
      body: { required: true, content: { "application/json": { schema: UsersUsageBatchSchema } } },
    },
    responses: {
      200: {
        description: "Usage batch.",
        content: { "application/json": { schema: GenericUserResponseSchema } },
      },
      ...problemResponses,
    },
  }),
  getUsersUsage as never
);

usersRouter.openapi(
  createRoute({
    method: "post",
    path: "/users:batchUpdate",
    middleware: requireAuth("admin"),
    tags: ["Users"],
    summary: "Batch update users",
    description: "Updates selected users with one patch.",
    "x-required-access": "admin",
    security,
    request: {
      body: { required: true, content: { "application/json": { schema: UsersBatchUpdateSchema } } },
    },
    responses: {
      200: {
        description: "Batch update result.",
        content: { "application/json": { schema: GenericUserResponseSchema } },
      },
      ...problemResponses,
    },
  }),
  batchUpdateUsers as never
);

usersRouter.openapi(
  createRoute({
    method: "get",
    path: "/users/{id}",
    middleware: requireAuth("admin"),
    tags: ["Users"],
    summary: "Get user",
    description: "Gets one user from the admin user page data set.",
    "x-required-access": "admin",
    security,
    request: { params: UserIdParamSchema },
    responses: {
      200: {
        description: "User detail.",
        content: { "application/json": { schema: UserDetailResponseSchema } },
      },
      ...problemResponses,
    },
  }),
  getUser as never
);

usersRouter.openapi(
  createRoute({
    method: "get",
    path: "/users/{id}/cyber-state",
    middleware: requireAuth("admin"),
    tags: ["Users"],
    summary: "Get user Cyber Check state",
    description:
      "Reads live principal and installation state from Cyber Check without a CCH mirror.",
    "x-required-access": "admin",
    security,
    request: { params: UserIdParamSchema },
    responses: {
      200: {
        description: "Live Cyber Check state.",
        content: { "application/json": { schema: UserCyberStateResponseSchema } },
      },
      ...problemResponses,
    },
  }),
  getUserCyberState as never
);

usersRouter.openapi(
  createRoute({
    method: "post",
    path: "/users/{id}/cyber-state/client-instance-reset",
    middleware: requireAuth("admin"),
    tags: ["Users"],
    summary: "Reset one user installation",
    description: "Advances the installation strike watermark and removes only its restriction.",
    "x-required-access": "admin",
    security,
    request: {
      params: UserIdParamSchema,
      body: {
        required: true,
        content: { "application/json": { schema: UserCyberClientInstanceResetSchema } },
      },
    },
    responses: { 204: { description: "Installation state reset." }, ...problemResponses },
  }),
  resetUserCyberClientInstance as never
);

usersRouter.openapi(
  createRoute({
    method: "post",
    path: "/users/{id}/cyber-state/client-instance-manual-restriction",
    middleware: requireAuth("admin"),
    tags: ["Users"],
    summary: "Set one manual installation restriction",
    description:
      "Blocks or releases only the manual restriction source without changing automatic strikes.",
    "x-required-access": "admin",
    security,
    request: {
      params: UserIdParamSchema,
      body: {
        required: true,
        content: { "application/json": { schema: UserCyberManualClientRestrictionSchema } },
      },
    },
    responses: {
      204: { description: "Manual installation restriction updated." },
      ...problemResponses,
    },
  }),
  setUserCyberManualClientRestriction as never
);

usersRouter.openapi(
  createRoute({
    method: "post",
    path: "/users/{id}/cyber-state/principal-reset",
    middleware: requireAuth("admin"),
    tags: ["Users"],
    summary: "Reset user principal Cyber state",
    description: "Resets the principal epoch, then optionally enables the CCH user.",
    "x-required-access": "admin",
    security,
    request: {
      params: UserIdParamSchema,
      body: {
        required: true,
        content: { "application/json": { schema: UserCyberPrincipalResetSchema } },
      },
    },
    responses: {
      200: {
        description: "Principal state reset result.",
        content: { "application/json": { schema: GenericUserResponseSchema } },
      },
      ...problemResponses,
    },
  }),
  resetUserCyberPrincipal as never
);

usersRouter.openapi(
  createRoute({
    method: "post",
    path: "/users/{id}/policy-state/bio-restriction-release",
    middleware: requireAuth("admin"),
    tags: ["Users"],
    summary: "Release one bio policy restriction scope",
    description:
      "Releases only the selected provider_bio_policy scope; cyber and manual restrictions remain.",
    "x-required-access": "admin",
    security,
    request: {
      params: UserIdParamSchema,
      body: {
        required: true,
        content: { "application/json": { schema: UserBioRestrictionReleaseSchema } },
      },
    },
    responses: {
      200: {
        description: "Bio restriction release result.",
        content: { "application/json": { schema: GenericUserResponseSchema } },
      },
      ...problemResponses,
    },
  }),
  releaseUserBioRestriction as never
);

usersRouter.openapi(
  createRoute({
    method: "post",
    path: "/users/{id}/policy-state/bio-unconfirmed-local-release",
    middleware: requireAuth("admin"),
    tags: ["Users"],
    summary: "Release unconfirmed local bio containment",
    description:
      "Releases only the local containment created for an unconfirmed bio event; the user remains disabled.",
    "x-required-access": "admin",
    security,
    request: {
      params: UserIdParamSchema,
      body: {
        required: true,
        content: { "application/json": { schema: UserBioUnconfirmedLocalReleaseSchema } },
      },
    },
    responses: { 204: { description: "Local bio containment released." }, ...problemResponses },
  }),
  releaseLocalUnconfirmedBioContainment as never
);

usersRouter.openapi(
  createRoute({
    method: "patch",
    path: "/users/{id}",
    middleware: requireAuth("admin"),
    tags: ["Users"],
    summary: "Update user",
    description: "Partially updates one user.",
    "x-required-access": "admin",
    security,
    request: {
      params: UserIdParamSchema,
      body: { required: true, content: { "application/json": { schema: UserUpdateSchema } } },
    },
    responses: {
      200: {
        description: "Update result.",
        content: { "application/json": { schema: GenericUserResponseSchema } },
      },
      ...problemResponses,
    },
  }),
  updateUser as never
);

usersRouter.openapi(
  createRoute({
    method: "delete",
    path: "/users/{id}",
    middleware: requireAuth("admin"),
    tags: ["Users"],
    summary: "Delete user",
    description: "Deletes one user.",
    "x-required-access": "admin",
    security,
    request: { params: UserIdParamSchema },
    responses: { 204: { description: "User deleted." }, ...problemResponses },
  }),
  deleteUser as never
);

const enableUserRoute = createRoute({
  method: "post",
  path: "/users/{id}:enable",
  tags: ["Users"],
  summary: "Set user enabled state",
  description: "Enables or disables one user.",
  "x-required-access": "admin",
  security,
  request: {
    params: UserIdParamSchema,
    body: { required: true, content: { "application/json": { schema: UserEnableSchema } } },
  },
  responses: {
    200: {
      description: "Toggle result.",
      content: { "application/json": { schema: GenericUserResponseSchema } },
    },
    ...problemResponses,
  },
});

usersRouter.openAPIRegistry.registerPath(enableUserRoute);
usersRouter.post("/users/:id{[0-9]+:enable}", requireAuth("admin"), enableUser);

const renewUserRoute = createRoute({
  method: "post",
  path: "/users/{id}:renew",
  tags: ["Users"],
  summary: "Renew user expiration",
  description: "Updates one user expiration date.",
  "x-required-access": "admin",
  security,
  request: {
    params: UserIdParamSchema,
    body: { required: true, content: { "application/json": { schema: UserRenewSchema } } },
  },
  responses: {
    200: {
      description: "Renew result.",
      content: { "application/json": { schema: GenericUserResponseSchema } },
    },
    ...problemResponses,
  },
});

usersRouter.openAPIRegistry.registerPath(renewUserRoute);
usersRouter.post("/users/:id{[0-9]+:renew}", requireAuth("admin"), renewUser);

usersRouter.openapi(
  createRoute({
    method: "get",
    path: "/users/{id}/limit-usage",
    middleware: requireAuth("web"),
    tags: ["Users"],
    summary: "Get user limit usage",
    description: "Returns current per-user RPM and daily cost usage.",
    "x-required-access": "web",
    security,
    request: { params: UserIdParamSchema },
    responses: {
      200: {
        description: "Limit usage.",
        content: { "application/json": { schema: UserLimitUsageResponseSchema } },
      },
      ...problemResponses,
    },
  }),
  getUserLimitUsage as never
);

usersRouter.openapi(
  createRoute({
    method: "get",
    path: "/users/{id}/limit-usage:all",
    middleware: requireAuth("web"),
    tags: ["Users"],
    summary: "Get all user limit usage",
    description: "Returns all current user cost limit buckets.",
    "x-required-access": "web",
    security,
    request: { params: UserIdParamSchema },
    responses: {
      200: {
        description: "All limit usage.",
        content: { "application/json": { schema: UserAllLimitUsageResponseSchema } },
      },
      ...problemResponses,
    },
  }),
  getUserAllLimitUsage as never
);

usersRouter.openapi(
  createRoute({
    method: "post",
    path: "/users/{id}/limits:reset",
    middleware: requireAuth("admin"),
    tags: ["Users"],
    summary: "Reset user cost limits",
    description: "Resets user limit counters without deleting logs.",
    "x-required-access": "admin",
    security,
    request: { params: UserIdParamSchema },
    responses: { 204: { description: "User limits reset." }, ...problemResponses },
  }),
  resetUserLimits as never
);

usersRouter.openapi(
  createRoute({
    method: "post",
    path: "/users/{id}/statistics:reset",
    middleware: requireAuth("admin"),
    tags: ["Users"],
    summary: "Reset user statistics",
    description: "Resets all user statistics through the existing action.",
    "x-required-access": "admin",
    security,
    request: { params: UserIdParamSchema },
    responses: { 204: { description: "User statistics reset." }, ...problemResponses },
  }),
  resetUserStatistics as never
);
