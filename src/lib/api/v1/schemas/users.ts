import { z } from "@hono/zod-openapi";
import { createCursorResponseSchema } from "./_common";

const DateLikeSchema = z.string().datetime().nullable().optional();
const IsoDateTimeSchema = z
  .string()
  .datetime()
  .nullable()
  .describe("ISO 8601 timestamp, or null when unset.");
const ResetModeSchema = z.enum(["fixed", "rolling"]);

const UserMutationFieldsSchema = {
  name: z.string().trim().min(1).max(64).describe("User name."),
  note: z.string().max(200).optional().describe("Operator note."),
  providerGroup: z.string().max(200).nullable().optional().describe("Provider group expression."),
  tags: z.array(z.string().max(32)).max(20).optional().describe("User tags."),
  rpm: z.number().int().min(0).max(1_000_000).nullable().optional().describe("RPM limit."),
  dailyQuota: z.number().min(0).max(10_000).nullable().optional().describe("Daily USD quota."),
  limit5hUsd: z.number().min(0).max(10_000).nullable().optional().describe("Five-hour USD quota."),
  limit5hResetMode: ResetModeSchema.optional().describe("Five-hour reset mode."),
  limitWeeklyUsd: z.number().min(0).max(50_000).nullable().optional().describe("Weekly USD quota."),
  limitMonthlyUsd: z
    .number()
    .min(0)
    .max(200_000)
    .nullable()
    .optional()
    .describe("Monthly USD quota."),
  limitTotalUsd: z
    .number()
    .min(0)
    .max(10_000_000)
    .nullable()
    .optional()
    .describe("Total USD quota."),
  limitConcurrentSessions: z
    .number()
    .int()
    .min(0)
    .max(1000)
    .nullable()
    .optional()
    .describe("Concurrent session limit."),
  dailyResetMode: ResetModeSchema.optional().describe("Daily reset mode."),
  dailyResetTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .optional()
    .describe("Daily reset time in HH:mm."),
  isEnabled: z.boolean().optional().describe("Whether the user is enabled."),
  expiresAt: DateLikeSchema.describe("Expiration timestamp, or null to clear."),
  allowedClients: z
    .array(z.string().max(64))
    .max(50)
    .optional()
    .describe("Allowed client patterns."),
  blockedClients: z
    .array(z.string().max(64))
    .max(50)
    .optional()
    .describe("Blocked client patterns."),
  allowedModels: z.array(z.string().max(64)).max(50).optional().describe("Allowed model ids."),
};

export const UserIdParamSchema = z.object({
  id: z.coerce.number().int().positive().describe("User id."),
});

export const UserListQuerySchema = z.object({
  cursor: z.string().optional().describe("Cursor for admin batch listing."),
  limit: z.coerce.number().int().min(1).max(100).default(50).describe("Page size."),
  q: z.string().trim().optional().describe("Search text."),
  tags: z.string().optional().describe("Comma-separated tag filters."),
  keyGroups: z.string().optional().describe("Comma-separated key provider group filters."),
  status: z
    .enum(["active", "expired", "expiringSoon", "enabled", "disabled"])
    .optional()
    .describe("Status filter."),
  sortBy: z
    .enum([
      "name",
      "tags",
      "expiresAt",
      "rpm",
      "limit5hUsd",
      "limitDailyUsd",
      "limitWeeklyUsd",
      "limitMonthlyUsd",
      "createdAt",
    ])
    .optional()
    .describe("Sort field."),
  sortOrder: z.enum(["asc", "desc"]).optional().describe("Sort order."),
});

export const UserFilterSearchQuerySchema = z.object({
  q: z.string().trim().optional().describe("Search text."),
  limit: z.coerce.number().int().min(1).max(5000).default(20).describe("Result limit."),
});

export const UserCreateSchema = z.object(UserMutationFieldsSchema).strict();

export const UserUpdateSchema = z
  .object(UserMutationFieldsSchema)
  .partial()
  .strict()
  .describe("Partial user update request.");

export const UserRenewSchema = z
  .object({
    expiresAt: z.string().min(1).describe("New expiration timestamp."),
    enableUser: z.boolean().optional().describe("Enable the user while renewing."),
  })
  .strict();

export const UserEnableSchema = z
  .object({
    enabled: z.boolean().describe("Target enabled state."),
  })
  .strict();

const CyberTimestampSchema = z.number().int().nonnegative();
const CyberScopeStateSchema = z.object({
  current_strikes: z.number().int().nonnegative(),
  restricted: z.boolean(),
  last_hit_at_ms: CyberTimestampSchema.optional(),
  last_reset_at_ms: CyberTimestampSchema.optional(),
});

export const UserCyberStateResponseSchema = z.object({
  configured: z.boolean().describe("Whether Cyber Check is configured for this CCH process."),
  state: z
    .object({
      principal_id: z.string(),
      strike_window_seconds: z.number().int().positive(),
      disable_threshold: z.number().int().positive(),
      principal: CyberScopeStateSchema,
      client_instances: z.array(
        CyberScopeStateSchema.extend({
          client_instance_id: z.string(),
          automatic_restricted: z.boolean(),
          manual_restricted: z.boolean(),
          manual_reason: z.string().optional(),
          manual_actor: z.string().optional(),
          manual_restricted_at_ms: CyberTimestampSchema.optional(),
          expires_at_ms: CyberTimestampSchema.optional(),
        })
      ),
      bio_restrictions: z.array(
        z.object({
          scope: z.enum(["session", "client_instance", "principal"]),
          subject_id: z.string(),
          reason: z.string(),
          expires_at_ms: CyberTimestampSchema.optional(),
        })
      ),
    })
    .nullable(),
});

export const UserCyberClientInstanceResetSchema = z
  .object({
    clientInstanceId: z
      .string()
      .min(1)
      .max(256)
      .refine((value) => !value.includes("\n") && !value.includes("\r")),
  })
  .strict();

export const UserCyberManualClientRestrictionSchema = z
  .object({
    clientInstanceId: z
      .string()
      .min(1)
      .max(256)
      .refine((value) => !value.includes("\n") && !value.includes("\r")),
    reason: z
      .string()
      .trim()
      .min(1)
      .max(1024)
      .refine((value) => !value.includes("\n") && !value.includes("\r")),
    restricted: z.boolean(),
  })
  .strict();

export const UserCyberPrincipalResetSchema = z
  .object({
    enableUser: z.boolean().describe("Enable the CCH user only after central reset succeeds."),
  })
  .strict();

export const UserBioRestrictionReleaseSchema = z
  .object({
    scope: z.enum(["session", "client_instance", "principal"]),
    subjectId: z.string().min(1).max(256),
    reason: z.string().trim().min(1).max(1024),
    enableUser: z.boolean().default(false),
  })
  .strict();

export const UserBioUnconfirmedLocalReleaseSchema = z
  .object({
    messageRequestId: z.number().int().positive(),
    sessionId: z.string().min(1).max(256),
    clientInstanceId: z.string().max(256).nullable(),
    reason: z.string().trim().min(1).max(1024),
  })
  .strict();

export const UsersUsageBatchSchema = z
  .object({
    userIds: z.array(z.number().int().positive()).max(500).describe("User ids."),
  })
  .strict();

export const UsersBatchUpdateSchema = z
  .object({
    userIds: z.array(z.number().int().positive()).max(500).describe("User ids."),
    updates: UserUpdateSchema.pick({
      note: true,
      tags: true,
      rpm: true,
      dailyQuota: true,
      limit5hUsd: true,
      limit5hResetMode: true,
      limitWeeklyUsd: true,
      limitMonthlyUsd: true,
    }).describe("Fields to update."),
  })
  .strict();

export const GenericUserResponseSchema = z
  .record(z.string(), z.unknown())
  .describe("User API response object.");

export const UserDetailResponseSchema = z
  .object({
    id: z.number().int().positive().describe("User id."),
    name: z.string().describe("User name."),
    description: z.string().optional().describe("Operator note stored on the user."),
    role: z.enum(["admin", "user"]).describe("User role."),
    rpm: z.number().nullable().describe("Per-minute request limit, or null for unlimited."),
    dailyQuota: z.number().nullable().describe("Daily USD quota, or null for unlimited."),
    providerGroup: z.string().nullable().describe("Provider group expression, or null."),
    tags: z.array(z.string()).optional().describe("User tags."),
    createdAt: IsoDateTimeSchema.describe("Creation timestamp."),
    updatedAt: IsoDateTimeSchema.describe("Last update timestamp."),
    deletedAt: IsoDateTimeSchema.optional().describe("Deletion timestamp when soft deleted."),
    limit5hUsd: z.number().nullable().optional().describe("Five-hour USD quota."),
    limit5hResetMode: ResetModeSchema.describe("Five-hour reset mode."),
    limitWeeklyUsd: z.number().nullable().optional().describe("Weekly USD quota."),
    limitMonthlyUsd: z.number().nullable().optional().describe("Monthly USD quota."),
    limitTotalUsd: z.number().nullable().optional().describe("Total USD quota."),
    costResetAt: IsoDateTimeSchema.optional().describe("Cost reset timestamp."),
    limit5hCostResetAt: IsoDateTimeSchema.optional().describe("Rolling five-hour reset timestamp."),
    limitConcurrentSessions: z.number().nullable().optional().describe("Concurrent session limit."),
    dailyResetMode: ResetModeSchema.describe("Daily reset mode."),
    dailyResetTime: z.string().describe("Daily reset time in HH:mm."),
    isEnabled: z.boolean().describe("Whether the user can authenticate."),
    expiresAt: IsoDateTimeSchema.optional().describe("Expiration timestamp."),
    allowedClients: z.array(z.string()).optional().describe("Allowed client patterns."),
    blockedClients: z.array(z.string()).optional().describe("Blocked client patterns."),
    allowedModels: z.array(z.string()).optional().describe("Allowed model ids."),
  })
  .passthrough()
  .describe("User detail response.");

export const UserLimitUsageResponseSchema = z
  .object({
    rpm: z
      .object({
        current: z.number().describe("Current RPM usage."),
        limit: z.number().nullable().describe("Configured RPM limit, or null."),
        window: z.literal("per_minute").describe("RPM window."),
      })
      .describe("Per-minute request usage."),
    dailyCost: z
      .object({
        current: z.number().describe("Current daily cost in USD."),
        limit: z.number().nullable().describe("Configured daily USD quota, or null."),
        resetAt: z
          .string()
          .datetime()
          .optional()
          .describe("Next daily reset timestamp when available."),
      })
      .describe("Daily cost usage."),
  })
  .describe("Current user limit usage.");

const LimitBucketSchema = z.object({
  usage: z.number().describe("Current usage in USD."),
  limit: z.number().nullable().describe("Configured USD quota, or null."),
});

export const UserAllLimitUsageResponseSchema = z
  .object({
    limit5h: LimitBucketSchema.describe("Five-hour usage bucket."),
    limitDaily: LimitBucketSchema.describe("Daily usage bucket."),
    limitWeekly: LimitBucketSchema.describe("Weekly usage bucket."),
    limitMonthly: LimitBucketSchema.describe("Monthly usage bucket."),
    limitTotal: LimitBucketSchema.describe("Total usage bucket."),
  })
  .describe("All current user limit usage buckets.");

export const UserListResponseSchema = createCursorResponseSchema(z.unknown()).describe(
  "Cursor-paginated users response."
);

export const StringListResponseSchema = z.object({
  items: z.array(z.string()).describe("String items."),
});

export type UserCreateInput = z.infer<typeof UserCreateSchema>;
export type UserUpdateInput = z.infer<typeof UserUpdateSchema>;
export type UserRenewInput = z.infer<typeof UserRenewSchema>;
