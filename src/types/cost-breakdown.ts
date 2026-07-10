import type { CacheWriteAccounting } from "@/lib/billing/openai-usage-accounting";
import type {
  BillingPricingTier,
  BillingRateSource,
  Gpt56UnsupportedPricingReason,
} from "@/lib/utils/billing-rate-resolution";
import type { ResolvedPricingSource } from "@/lib/utils/pricing-resolution";
import type { PricingSupplementMetadata } from "@/types/model-price";

export interface StoredBillingUnitRates {
  input: string;
  cache_read: string;
  cache_write: string;
  output: string;
}

export interface StoredPricingSnapshot {
  tier: BillingPricingTier;
  unit_rates: StoredBillingUnitRates;
  rate_source: BillingRateSource;
  rate_source_id?: string;
  rate_source_url?: string;
  price_book_source: ResolvedPricingSource;
  price_book_model: string;
  price_book_provider: string;
}

/** Price-book identity captured independently of whether settlement succeeds. */
export interface StoredPricingContext {
  source: ResolvedPricingSource;
  model: string;
  provider: string;
  supplement?: PricingSupplementMetadata;
}

/**
 * Stored cost breakdown for a request.
 * Persisted as jsonb in messageRequest.costBreakdown.
 * All cost values are Decimal strings for precision.
 */
export interface StoredCostBreakdown {
  /** Base input cost (no multiplier) */
  input: string;
  /** Base output cost (no multiplier) */
  output: string;
  /**
   * Base cache creation cost aggregated across 5m + 1h TTLs (no multiplier).
   * Retained for backward compatibility; use cache_creation_5m / _1h for per-TTL display.
   */
  cache_creation: string;
  /** Base cache creation cost without a TTL classification. Optional for historical rows. */
  cache_creation_default?: string;
  /** Base cache creation cost for 5-minute TTL only (no multiplier). Optional for historical rows. */
  cache_creation_5m?: string;
  /** Base cache creation cost for 1-hour TTL only (no multiplier). Optional for historical rows. */
  cache_creation_1h?: string;
  /** Base cache read cost (no multiplier) */
  cache_read: string;
  /** Atomic GPT-5.6 unit-rate and price-book provenance snapshot. */
  pricing?: StoredPricingSnapshot;
  /** Sum of all base costs before multipliers */
  base_total: string;
  /** Provider cost multiplier applied */
  provider_multiplier: number;
  /** Provider group cost multiplier applied */
  group_multiplier: number;
  /** Final total cost after both multipliers */
  total: string;
}

/**
 * Billing record for a single hedge (provider racing) loser whose upstream
 * response was drained in the background and billed.
 *
 * Persisted as one element of the jsonb array `messageRequest.hedgeLosers`.
 * Each loser's `costUsd` is already accumulated into the row's grand-total
 * `costUsd`; this array only keeps the per-loser breakdown for display.
 * All cost values are Decimal strings for precision.
 */
export interface HedgeLoserBilling {
  /** Losing provider id */
  providerId: number;
  /** Losing provider name (snapshot, for display) */
  providerName: string;
  /** Hedge attempt sequence number (1 = initial provider) */
  attemptNumber: number;
  /** Billed cost (USD) for this loser, with multipliers applied */
  costUsd: string;
  /** Settlement outcome. Historical entries may omit this field. */
  billingStatus?: "settled" | "unsupported";
  /** Fail-closed reason when no defensible GPT-5.6 price exists. */
  billingReason?: Gpt56UnsupportedPricingReason;
  /** Required rate fields absent from the price book, if applicable. */
  missingPricingFields?: string[];
  /** Price-book identity retained even when the loser cannot be cost-settled. */
  pricingContext?: StoredPricingContext;
  inputTokens?: number;
  observedInputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheWriteTokensReported?: number | null;
  cacheWriteAccounting?: CacheWriteAccounting;
  cacheReadInputTokens?: number;
  requestedServiceTier?: string | null;
  actualServiceTier?: string | null;
  serviceTierResolvedFrom?: "requested" | "actual" | null;
  effectivePriority?: boolean;
  costBreakdown?: StoredCostBreakdown;
}
