import { logger } from "@/lib/logger";
import { requestFilterEngine } from "@/lib/request-filter-engine";
import type { ProxySession } from "./session";

/**
 * Provider-specific Request Filter
 * Применяет фильтры, привязанные к конкретному провайдеру или группе
 * Выполняется ПОСЛЕ выбора провайдера
 */
export class ProxyProviderRequestFilter {
  static async ensure(session: ProxySession): Promise<void> {
    if (session.getEndpointPolicy().bypassRequestFilters) {
      return;
    }

    if (!session.provider) {
      logger.warn(
        "[ProxyProviderRequestFilter] No provider selected, skipping provider-specific filters"
      );
      return;
    }

    // 与 guard 期全局过滤器同一降解规则：provider 绑定的 body 手术需要完整树。
    if (
      session.isFastBodyPathActive?.() &&
      (await requestFilterEngine.hasGuardBodyScopeFilters())
    ) {
      session.rematerializeRequestMessageForRetry();
    }

    try {
      await requestFilterEngine.applyForProvider(session);
    } catch (error) {
      // Fail-open: фильтр не блокирует основной поток
      logger.error("[ProxyProviderRequestFilter] Failed to apply provider-specific filters", {
        error,
        providerId: session.provider.id,
      });
    }
  }
}
