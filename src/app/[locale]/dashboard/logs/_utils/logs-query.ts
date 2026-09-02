import { dateStringWithClockToTimestamp, getQuickDateRange } from "./time-range";

export interface LogsUrlFilters {
  userId?: number;
  keyId?: number;
  providerId?: number;
  sessionId?: string;
  startTime?: number;
  endTime?: number;
  /** 显式请求全部时间（绕过默认 7 天窗口） */
  allTime?: boolean;
  statusCode?: number;
  excludeStatusCode200?: boolean;
  model?: string;
  actualResponseModelMismatch?: boolean;
  endpoint?: string;
  minRetryCount?: number;
  page?: number;
}

function firstString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function parseIntParam(value: string | string[] | undefined): number | undefined {
  const raw = firstString(value);
  if (!raw) return undefined;
  const num = Number.parseInt(raw, 10);
  return Number.isFinite(num) ? num : undefined;
}

function parseStringParam(value: string | string[] | undefined): string | undefined {
  const raw = firstString(value);
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

export function parseLogsUrlFilters(searchParams: {
  [key: string]: string | string[] | undefined;
}): LogsUrlFilters {
  const statusCodeParam = parseStringParam(searchParams.statusCode);
  const pageRaw = parseIntParam(searchParams.page);
  const page = pageRaw && pageRaw >= 1 ? pageRaw : undefined;

  const statusCode =
    statusCodeParam && statusCodeParam !== "!200"
      ? Number.parseInt(statusCodeParam, 10)
      : undefined;

  const actualResponseModelMismatch =
    parseStringParam(searchParams.actualResponseModelMismatch) === "true" ? true : undefined;

  const allTime = parseStringParam(searchParams.allTime) === "true" ? true : undefined;

  return {
    userId: parseIntParam(searchParams.userId),
    keyId: parseIntParam(searchParams.keyId),
    providerId: parseIntParam(searchParams.providerId),
    sessionId: parseStringParam(searchParams.sessionId),
    startTime: parseIntParam(searchParams.startTime),
    endTime: parseIntParam(searchParams.endTime),
    allTime,
    statusCode: Number.isFinite(statusCode) ? statusCode : undefined,
    excludeStatusCode200: statusCodeParam === "!200",
    model: parseStringParam(searchParams.model),
    actualResponseModelMismatch,
    endpoint: parseStringParam(searchParams.endpoint),
    minRetryCount: parseIntParam(searchParams.minRetry),
    page,
  };
}

/**
 * 客户端侧的默认时间窗口：URL 未带 startTime 且未显式 allTime 时应用
 * "最近 7 天"快捷周期（与 action 层的 server 端默认保持同一策略）。
 * 转换方式与 TimeFilters.handleDateRangeChange 完全一致（00:00:00 起至
 * 23:59:59 + 1s），保证 picker 能识别为 last7days 快捷周期并显示选中态。
 */
export function applyDefaultLogsTimeWindow<
  T extends { startTime?: number; endTime?: number; allTime?: boolean },
>(filters: T, serverTimeZone?: string): T {
  if (filters.startTime !== undefined || filters.allTime) {
    return filters;
  }
  const range = getQuickDateRange("last7days", serverTimeZone);
  const start = dateStringWithClockToTimestamp(range.startDate, "00:00:00", serverTimeZone);
  const endInclusive = dateStringWithClockToTimestamp(range.endDate, "23:59:59", serverTimeZone);
  if (start === undefined || endInclusive === undefined) {
    return filters;
  }
  return { ...filters, startTime: start, endTime: endInclusive + 1000 };
}

export function buildLogsUrlQuery(filters: LogsUrlFilters): URLSearchParams {
  const query = new URLSearchParams();

  if (filters.userId !== undefined) query.set("userId", filters.userId.toString());
  if (filters.keyId !== undefined) query.set("keyId", filters.keyId.toString());
  if (filters.providerId !== undefined) query.set("providerId", filters.providerId.toString());

  const sessionId = filters.sessionId?.trim();
  if (sessionId) query.set("sessionId", sessionId);

  if (filters.startTime !== undefined) query.set("startTime", filters.startTime.toString());
  if (filters.endTime !== undefined) query.set("endTime", filters.endTime.toString());
  if (filters.allTime) query.set("allTime", "true");

  if (filters.excludeStatusCode200) {
    query.set("statusCode", "!200");
  } else if (filters.statusCode !== undefined) {
    query.set("statusCode", filters.statusCode.toString());
  }

  if (filters.model) query.set("model", filters.model);
  if (filters.actualResponseModelMismatch) query.set("actualResponseModelMismatch", "true");
  if (filters.endpoint) query.set("endpoint", filters.endpoint);

  if (filters.minRetryCount !== undefined) {
    query.set("minRetry", filters.minRetryCount.toString());
  }

  if (filters.page !== undefined && filters.page > 1) {
    query.set("page", filters.page.toString());
  }

  return query;
}
