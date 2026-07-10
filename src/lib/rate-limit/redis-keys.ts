export type RateLimitEntityType = "key" | "provider" | "user";
export type RollingCostWindow = "5h" | "daily";

const ROLLING_KEY_GENERATION = "v2";

export function buildRollingCostKey(
  entityType: RateLimitEntityType,
  entityId: number,
  window: RollingCostWindow
): string {
  return `${entityType}:${entityId}:cost_${window}_rolling:${ROLLING_KEY_GENERATION}`;
}

export function buildProviderTotalCostKey(providerId: number, resetAtMs?: number | null): string {
  return `total_cost:provider:${providerId}:${ROLLING_KEY_GENERATION}:${resetAtMs ?? "none"}`;
}
