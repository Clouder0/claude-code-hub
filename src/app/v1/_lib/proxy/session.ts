import type { Context } from "hono";
import { logger } from "@/lib/logger";
import { writeLiveChain } from "@/lib/redis/live-chain-store";
import { clientRequestsContext1m as clientRequestsContext1mHelper } from "@/lib/special-attributes";
import { ERROR_CODES, getErrorMessageServer } from "@/lib/utils/error-messages";
import {
  type ResolvedPricing,
  resolvePricingForModelRecords,
} from "@/lib/utils/pricing-resolution";
import { findLatestPriceByModel } from "@/repository/model-price";
import { findAllProviders } from "@/repository/provider";
import type { CacheTtlResolved } from "@/types/cache";
import type { Key } from "@/types/key";
import type { ProviderChainItem } from "@/types/message";
import type { ModelPriceData } from "@/types/model-price";
import type { Provider, ProviderType } from "@/types/provider";
import type { SpecialSetting } from "@/types/special-settings";
import type { BillingModelSource, CodexPriorityBillingSource } from "@/types/system-config";
import type { User } from "@/types/user";
import { isCountTokensEndpointPath, V1_ENDPOINT_PATHS } from "./endpoint-paths";
import { type EndpointPolicy, resolveEndpointPolicy } from "./endpoint-policy";
import { ProxyError } from "./errors";
import type { ClientFormat } from "./format-mapper";
import {
  buildOpenAIImageLogicalBody,
  getOpenAIImageEndpoint,
  getOpenAIImageMultipartSummary,
  isOpenAIImageMultipartContentType,
  isOpenAIImageMultipartRequest,
  type OpenAIImageRequestMetadata,
  parseOpenAIImageMultipartMetadata,
} from "./openai-image-compat";
import { isRemoteCompactionV2Request } from "./remote-compaction";
import {
  decodeRequestBody,
  parseContentEncoding,
  resolveIntakeBodyLimitBytes,
} from "./request-body-codec";
import {
  buildHighConcurrencyCodexRequestSummary,
  type ProxySessionCreationOptions,
  shouldDirectlyConsumeHighConcurrencyCodexRequest,
  shouldUseHighConcurrencyCodexSseRetention,
} from "./request-retention";

export type { ProxySessionCreationOptions } from "./request-retention";

/**
 * 释放后的 request.message 占位符：冻结空对象。直接读取（应仅存在于
 * 释放前的代码路径）得到空对象而非崩溃；真实消费者走 getBillingRequestMessage()。
 */
const RELEASED_REQUEST_BODY_MESSAGE: Record<string, unknown> = Object.freeze({}) as Record<
  string,
  unknown
>;

/**
 * 计费投影保留的顶层标量字段（浅拷贝）。大数组/长文本（input/messages/
 * instructions/tools/system）全部丢弃——它们是内存大头，且提交后无人读取。
 */
const REQUEST_BODY_PROJECTION_KEYS = [
  "model",
  "stream",
  "service_tier",
  "prompt_cache_key",
  "max_tokens",
  "temperature",
  "top_p",
  "reasoning_effort",
] as const;

function buildRequestBodyProjection(message: Record<string, unknown>): Record<string, unknown> {
  const projection: Record<string, unknown> = {};
  for (const key of REQUEST_BODY_PROJECTION_KEYS) {
    const value = message[key];
    if (value !== undefined) {
      projection[key] = value;
    }
  }
  // thinking 配置是很小的对象（开关 + 预算数字），流式收尾的
  // isThinkingEnabled（Anthropic 实际模型检测）仍需读取它。
  if (message.thinking !== undefined && message.thinking !== null) {
    projection.thinking = message.thinking;
  }
  return projection;
}

/**
 * Classification of an auth failure, used to decide whether to record the
 * failure against the brute-force rate limiter.
 *
 * - `credentials`: the request did not present a valid key (missing,
 *   malformed, multiple conflicting keys, or the key does not match any
 *   record). These look like brute-force probes — record the failure.
 * - `account_state`: the credentials matched a real record but the
 *   key/user is disabled, expired, or otherwise administratively rejected.
 *   Recording these as failures would lock out legitimate operators whose
 *   keys were disabled by an admin.
 */
export type AuthFailureKind = "credentials" | "account_state";

export interface AuthState {
  user: User | null;
  key: Key | null;
  apiKey: string | null;
  success: boolean;
  errorResponse?: Response; // 认证失败时的详细错误响应
  /**
   * Set when `success` is false. Determines whether the proxy auth guard
   * records the failure against the IP/key rate-limiter.
   */
  failureKind?: AuthFailureKind;
}

export interface MessageContext {
  id: number;
  createdAt: Date;
  user: User;
  key: Key;
  apiKey: string;
}

export interface StableRequestIdentity {
  requestId: number;
  principalId: number;
}

export interface CyberCheckAdmissionCorrelation {
  identity: {
    request_id: string;
    principal_id: string;
    client_instance_id?: string;
    session_id: string;
    sequence: number;
  };
  upstreamProviderId: string;
}

export type CyberCheckObservationResult =
  | {
      status: "recorded";
      correlation: CyberCheckAdmissionCorrelation;
    }
  | {
      status: "capture_gap";
    };

export interface CyberCheckObservationHandle {
  completion: Promise<CyberCheckObservationResult>;
}

export interface ProxyRequestPayload {
  message: Record<string, unknown>;
  buffer?: ArrayBuffer;
  log: string;
  note?: string;
  model: string | null;
  imageRequestMetadata?: OpenAIImageRequestMetadata | null;
}

interface RequestBodyResult {
  requestMessage: Record<string, unknown>;
  requestBodyLog: string;
  requestBodyLogNote?: string;
  requestBodyBuffer?: ArrayBuffer;
  contentLength?: number | null;
  actualBodyBytes?: number;
  imageRequestMetadata?: OpenAIImageRequestMetadata | null;
  /** 高并发 codex SSE 保留人群标记（intake 丢 buffer / 摘要 log / 释放候选）。 */
  highConcurrencyCodexSseRetention?: boolean;
  /**
   * 入站请求体实际解压所用的 content-encoding（链）。
   * 非空表示代理已解压请求体，调用方需剥离出站 `content-encoding` 头，
   * 避免上游对明文再次解码。未解压时为 undefined。
   */
  decodedContentEncoding?: string;
}

export class ProxySession {
  readonly startTime: number;
  readonly method: string;
  requestUrl: URL; // 非 readonly，允许模型重定向修改 Gemini URL 路径
  readonly headers: Headers;
  // 原始 headers 的副本，用于检测过滤器修改
  private readonly originalHeaders: Headers;
  readonly headerLog: string;
  readonly request: ProxyRequestPayload;
  readonly userAgent: string | null; // User-Agent（用于客户端类型分析）
  readonly context: Context; // Hono Context（用于转换器）
  readonly clientAbortSignal: AbortSignal | null; // 客户端中断信号
  userName: string;
  authState: AuthState | null;
  provider: Provider | null;
  messageContext: MessageContext | null;
  // Hedge attempts intentionally drop messageContext so only the tracking session owns persistence.
  // These three scalar IDs remain available for request-scoped admission and audit correlation.
  private stableRequestIdentity: StableRequestIdentity | null = null;
  private cyberCheckObservation: CyberCheckObservationHandle | null = null;

  // Time To First Byte (ms). Streaming: first chunk. Non-stream: equals durationMs.
  ttfbMs: number | null = null;

  // Timestamp when guard pipeline finished and forwarding started (epoch ms).
  forwardStartTime: number | null = null;

  // Actual serialized request body sent to upstream (after all preprocessing).
  forwardedRequestBody: string | null = null;

  // Lazily decoded view of forwardedRequestBody. The source string guards against direct
  // assignments made by retries/tests so billing never reuses a snapshot from another attempt.
  private forwardedRequestMessageSource: string | null = null;
  private forwardedRequestMessage: Record<string, unknown> | null = null;

  // 最终流响应关闭内部重试边界后是否已释放请求体（见 releaseRequestBodyAfterCommit）。
  private requestBodyReleased = false;

  // 释放资格两段式标记：
  // - candidate 由 parse 阶段判定（高并发 + /v1/responses + stream:true,
  //   即 buffer 已在 intake 丢弃、request.log 已摘要化的同一人群）——
  //   仅用作在途准入计量的计费人群标记(其释放路径必然触发);
  // - eligible 在 doForward 按原始提交点门控（/v1/responses × codex × 高并发）
  //   标记——该人群的"释放后计费走投影"语义已在生产验证(成功流每天都在
  //   释放后结算)。abort/最终失败路径沿此标记释放,不越过既有门控人群。
  private requestBodyReleaseCandidate = false;
  private requestBodyReleaseEligible = false;

  // 在途保留字节准入租约（见 src/lib/capacity/request-admission.ts）。
  // 在 releaseRequestBodyAfterCommit 中恰好退费一次。
  private workingSetLease: { release(): void } | null = null;

  /**
   * Record the forwarded body together with the object it was serialized from.
   * Billing reads via getForwardedRequestMessage() then hit the cached object instead of
   * re-parsing a multi-MB string. Callers must not mutate `message` afterwards (the
   * forwarder serializes immediately before this call and never touches it again).
   */
  setForwardedRequestBody(bodyString: string, message: Record<string, unknown>): void {
    if (this.requestBodyReleased) {
      throw new Error(
        "setForwardedRequestBody called after releaseRequestBodyAfterCommit: the request body was released at gate commit and no re-forward path may exist"
      );
    }
    this.forwardedRequestBody = bodyString;
    this.forwardedRequestMessageSource = bodyString;
    this.forwardedRequestMessage = message;
  }

  /**
   * Drop the forwarded body and its cached decode (hedge shadow sessions must not
   * inherit the tracking session's pair, and should release the retained tree).
   */
  clearForwardedRequestBody(): void {
    this.forwardedRequestBody = null;
    this.forwardedRequestMessageSource = null;
    this.forwardedRequestMessage = null;
  }

  /** Carry the forwarded body and its cached decode across hedge winner sync. */
  copyForwardedRequestBodyFrom(source: ProxySession): void {
    this.forwardedRequestBody = source.forwardedRequestBody;
    this.forwardedRequestMessageSource = source.forwardedRequestMessageSource;
    this.forwardedRequestMessage = source.forwardedRequestMessage;
    // 正常时序中 winner sync 早于门控提交；若发生 copy 到已释放目标，
    // 以拷贝来的活跃对为准，解除 released 状态避免 getter 返回过期投影。
    this.requestBodyReleased = false;
  }

  isRequestBodyReleased(): boolean {
    return this.requestBodyReleased;
  }

  /**
   * 最终流响应关闭内部重试边界后释放请求体（2026-08-20 内存优化，
   * 2026-09-03 扩展至 gate-off/heartbeat 提交）。
   *
   * 前提（调用方必须保证）：Forwarder 已选定最终成功流响应，所有重试路径
   * （transport 错误、非 2xx、门控 fake-200 throw）已退出，此后重试在结构上
   * 不可能。这个边界可以由语义内容、legacy pass 或 heartbeat 建立。
   *
   * 释放内容：原始解析树（request.message）、过滤后副本与序列化字符串
   * （forwardedRequestBody 及其缓存解码）。中位 107k-token 上下文下这三者
   * 合计约 2-4.5MB/流，而流的 90%+ 生命周期在提交之后——这是每流驻留内存
   * 与 GC 分配压力的主要来源。
   *
   * 保留内容：计费投影（标量字段 + thinking 配置）。提交后的消费者
   * （getBillingModel / getRequestedCodexServiceTier / langfuse 预览 /
   * isThinkingEnabled）全部经由 getBillingRequestMessage() 读投影。
   * request.model / request.log 等既有标量字段不受影响。
   */
  releaseRequestBodyAfterCommit(): void {
    if (this.requestBodyReleased) return;
    const source =
      this.forwardedRequestMessage ??
      ((this.request.message as Record<string, unknown> | null) &&
      Object.keys(this.request.message as object).length > 0
        ? (this.request.message as Record<string, unknown>)
        : null);
    const projection = source ? buildRequestBodyProjection(source) : {};
    this.requestBodyReleased = true;
    this.workingSetLease?.release();
    this.workingSetLease = null;
    this.forwardedRequestBody = null;
    this.forwardedRequestMessageSource = null;
    this.forwardedRequestMessage = projection;
    // request 本身是 readonly，但其字段可变：就地清空大对象引用。
    this.request.message = RELEASED_REQUEST_BODY_MESSAGE;
    this.request.buffer = undefined;
  }

  /** parse 阶段标记：请求属于高并发 codex SSE 保留人群（见上方两段式注释）。 */
  noteRequestBodyReleaseCandidate(): void {
    this.requestBodyReleaseCandidate = true;
  }

  /** doForward 阶段标记：复刻原提交点门控（/v1/responses × codex × 高并发）。 */
  noteRequestBodyReleaseEligible(): void {
    this.requestBodyReleaseEligible = true;
  }

  isRequestBodyReleaseCandidate(): boolean {
    return this.requestBodyReleaseCandidate;
  }

  isRequestBodyReleaseEligible(): boolean {
    return this.requestBodyReleaseEligible;
  }

  /**
   * 释放钩子的补全入口：成功首字节（原有）、客户端断开、阶梯最终失败、
   * 以及 send() 成功返回的兜底，都经由这里收敛到同一个幂等释放。
   */
  releaseRequestBodyIfEligible(): void {
    if (this.requestBodyReleaseEligible) {
      this.releaseRequestBodyAfterCommit();
    }
  }

  /** 附着在途准入租约；由 releaseRequestBodyAfterCommit 恰好退费一次。 */
  attachWorkingSetLease(lease: { release(): void }): void {
    this.workingSetLease = lease;
  }

  // 接收到的原始（线上）请求字节数；准入计量按此计费。
  private receivedBodyBytesValue: number | null = null;

  noteReceivedBodyBytes(bytes: number | null): void {
    this.receivedBodyBytesValue = bytes;
  }

  get receivedBodyBytes(): number | null {
    return this.receivedBodyBytesValue;
  }

  /**
   * 兜底退费：请求已终结但释放迁移未触发（理论不可达；防御计量泄漏——
   * 漏退会导致准入永久误拒）。调用方应记录告警。
   */
  consumeWorkingSetLeaseIfHeld(): boolean {
    if (this.workingSetLease) {
      this.workingSetLease.release();
      this.workingSetLease = null;
      return true;
    }
    return false;
  }

  // Session ID（用于会话粘性和并发限流）
  sessionId: string | null;

  // 客户端 IP（由 ProxyAuthenticator 按系统设置的 ip_extraction_config 解析后写入）
  clientIp: string | null = null;

  // Request Sequence（Session 内请求序号）
  requestSequence: number = 1;

  // 请求格式追踪：记录原始请求格式和供应商类型
  originalFormat: ClientFormat = "claude";
  providerType: ProviderType | null = null;

  private readonly managedEndpoint: string;
  private readonly endpointPolicy: EndpointPolicy;

  // 模型重定向追踪：保存原始模型名（重定向前）
  private originalModelName: string | null = null;

  // 原始 URL 路径（用于 Gemini 模型重定向重置）
  private originalUrlPathname: string | null = null;

  // 当前供应商 attempt 的模型重定向快照。
  // 用于在 hedge shadow session 中延迟把 redirect 归属到真正的 winner/failed 链路项。
  private currentModelRedirect: {
    providerId: number;
    redirect: NonNullable<ProviderChainItem["modelRedirect"]>;
  } | null = null;

  // 上游决策链（记录尝试的供应商列表）
  private providerChain: ProviderChainItem[];

  // 上次选择的决策上下文（用于记录到 providerChain）
  private _lastSelectionContext?: ProviderChainItem["decisionContext"];

  // Cache TTL override (resolved)
  private cacheTtlResolved: CacheTtlResolved | null = null;

  // 1M Context Window applied (resolved)
  private context1mApplied: boolean = false;

  // Group-level cost multiplier (applied on top of provider costMultiplier)
  private groupCostMultiplier: number = 1;

  // 特殊设置（用于审计/展示，可扩展）
  private specialSettings: SpecialSetting[] = [];

  // Cached price data (lazy loaded: undefined=not loaded, null=no data)
  private cachedPriceData?: ModelPriceData | null;

  // Cached billing model source config (per-request)
  private cachedBillingModelSource?: BillingModelSource;

  // Cached Codex Priority 计费来源（per-request）
  private cachedCodexPriorityBillingSource?: CodexPriorityBillingSource;

  // 高并发模式（per-request）
  // 开启后：跳过部分 Redis 调试快照与实时观测写入，降低高并发下的热点开销
  private highConcurrencyModeEnabled = false;

  // raw non-chat endpoint 跨 provider fallback 的运行时开关（per-request）
  // endpoint policy 表示能力，系统设置决定本次请求是否实际启用。
  private rawCrossProviderFallbackEnabled: boolean | null = null;

  /**
   * Promise cache for billing-related system settings load (concurrency safe).
   * Ensures the relevant system settings are loaded at most once per request/session.
   */
  private billingSettingsPromise?: Promise<{
    billingModelSource: BillingModelSource;
    codexPriorityBillingSource: CodexPriorityBillingSource;
    source: "live" | "cache" | "default";
  }>;
  private billingSettingsSource?: "live" | "cache" | "default";

  // Resolved pricing cache (per request/provider combination)
  private resolvedPricingCache = new Map<string, ResolvedPricing | null>();

  /**
   * 请求级 Provider 快照
   *
   * 在 Session 首次获取时冻结，整个请求生命周期保持不变。
   * 用于保证故障迁移期间数据一致性（避免同一请求多次调用返回不同结果）。
   */
  private providersSnapshot: Provider[] | null = null;

  // 本请求已通过 Provider 并发检查获得的引用。
  // 失败切换 provider 时只能释放这里记录过的引用，避免 hedge/fallback 释放未 acquire 的 Redis 计数。
  private providerSessionRefs = new Set<number>();

  private constructor(init: {
    startTime: number;
    method: string;
    requestUrl: URL;
    headers: Headers;
    headerLog: string;
    request: ProxyRequestPayload;
    userAgent: string | null;
    context: Context;
    clientAbortSignal: AbortSignal | null;
  }) {
    this.startTime = init.startTime;
    this.method = init.method;
    this.requestUrl = init.requestUrl;
    this.headers = init.headers;
    this.originalHeaders = new Headers(init.headers); // 原始 headers 的副本，用于检测过滤器修改
    this.headerLog = init.headerLog;
    this.request = init.request;
    this.userAgent = init.userAgent;
    this.context = init.context;
    this.clientAbortSignal = init.clientAbortSignal;
    this.userName = "unknown";
    this.authState = null;
    this.provider = null;
    this.messageContext = null;
    this.sessionId = null;
    this.providerChain = [];
    this.managedEndpoint = resolveSessionManagedEndpoint(init.requestUrl, init.request.message);
    this.endpointPolicy = resolveEndpointPolicy(this.managedEndpoint);
  }

  static async fromContext(
    c: Context,
    options: ProxySessionCreationOptions = {}
  ): Promise<ProxySession> {
    const startTime = Date.now();
    const method = c.req.method.toUpperCase();
    const requestUrl = new URL(c.req.url);
    const headers = new Headers(c.req.header());
    const headerLog = formatHeadersForLog(headers);
    const bodyResult = await parseRequestBody(c, options);

    // 已在代理内解压请求体：剥离 content-encoding，避免上游对明文再次解码
    // （raw passthrough 也会转发解压后的字节；content-length 由出站黑名单重算）。
    if (bodyResult.decodedContentEncoding) {
      headers.delete("content-encoding");
    }

    // 提取 User-Agent
    const userAgent = headers.get("user-agent") || null;

    // 提取客户端 AbortSignal（如果存在）
    const clientAbortSignal = c.req.raw.signal || null;

    const modelFromBody =
      typeof bodyResult.requestMessage.model === "string" ? bodyResult.requestMessage.model : null;
    const modelFromImageRequest = bodyResult.imageRequestMetadata?.model ?? null;

    // 针对官方 Gemini 路径（/v1beta/models/{model}:generateContent）
    // 请求体中通常没有 model 字段，需从 URL 路径提取用于调度器匹配
    const modelFromPath = extractModelFromPath(requestUrl.pathname);

    // 双重检测（请求体优先，其次路径），若判断为 Gemini 请求则给出默认模型
    const isLikelyGeminiRequest =
      Array.isArray((bodyResult.requestMessage as Record<string, unknown>).contents) ||
      typeof (bodyResult.requestMessage as Record<string, unknown>).request === "object" ||
      modelFromPath !== null;

    const resolvedModel =
      modelFromBody ??
      modelFromImageRequest ??
      modelFromPath ??
      (isLikelyGeminiRequest ? "gemini-2.5-flash" : null);

    const isLargeRequestBody =
      (bodyResult.contentLength !== null &&
        bodyResult.contentLength !== undefined &&
        bodyResult.contentLength >= LARGE_REQUEST_BODY_BYTES) ||
      (bodyResult.actualBodyBytes !== undefined &&
        bodyResult.actualBodyBytes >= LARGE_REQUEST_BODY_BYTES);

    if (!resolvedModel && isLargeRequestBody) {
      logger.warn("[ProxySession] Missing model for large request body", {
        pathname: requestUrl.pathname,
        contentLength: bodyResult.contentLength ?? undefined,
        actualBodyBytes: bodyResult.actualBodyBytes ?? undefined,
      });

      throw new ProxyError(
        "Missing required field 'model'. If you provided it, your large request body may have been truncated by the proxy body size limit. Please reduce context size or contact the administrator to increase the limit.",
        400
      );
    }

    const request: ProxyRequestPayload = {
      message: bodyResult.requestMessage,
      buffer: bodyResult.requestBodyBuffer,
      log: bodyResult.requestBodyLog,
      note: bodyResult.requestBodyLogNote,
      model: resolvedModel,
      imageRequestMetadata: bodyResult.imageRequestMetadata,
    };

    const session = new ProxySession({
      startTime,
      method,
      requestUrl,
      headers,
      headerLog,
      request,
      userAgent,
      context: c,
      clientAbortSignal,
    });
    session.setHighConcurrencyModeEnabled(options.highConcurrencyModeEnabled ?? false);
    session.noteReceivedBodyBytes(bodyResult.actualBodyBytes ?? null);
    if (bodyResult.highConcurrencyCodexSseRetention) {
      session.noteRequestBodyReleaseCandidate();
    }
    return session;
  }

  /**
   * 检查 header 是否被过滤器修改过。
   *
   * 通过对比原始值和当前值判断。以下情况均视为"已修改"：
   * - 值被修改
   * - header 被删除
   * - header 从不存在变为存在
   *
   * @param key - header 名称（不区分大小写）
   * @returns true 表示 header 被修改过，false 表示未修改
   */
  isHeaderModified(key: string): boolean {
    const original = this.originalHeaders.get(key);
    const current = this.headers.get(key);
    return original !== current;
  }

  setAuthState(state: AuthState): void {
    this.authState = state;
    if (state.user) {
      this.userName = state.user.name;
    }
  }

  setProvider(provider: Provider | null): void {
    this.provider = provider;
    if (provider) {
      this.providerType = provider.providerType as ProviderType;
    }
  }

  recordProviderSessionRef(providerId: number): void {
    if (!this.providerSessionRefs) {
      this.providerSessionRefs = new Set<number>();
    }

    if (Number.isInteger(providerId) && providerId > 0) {
      this.providerSessionRefs.add(providerId);
    }
  }

  consumeProviderSessionRef(providerId: number): boolean {
    if (!this.providerSessionRefs?.has(providerId)) {
      return false;
    }

    this.providerSessionRefs.delete(providerId);
    return true;
  }

  setCacheTtlResolved(ttl: CacheTtlResolved | null): void {
    this.cacheTtlResolved = ttl;
  }

  getCacheTtlResolved(): CacheTtlResolved | null {
    return this.cacheTtlResolved;
  }

  setContext1mApplied(applied: boolean): void {
    this.context1mApplied = applied;
  }

  getContext1mApplied(): boolean {
    return this.context1mApplied;
  }

  setGroupCostMultiplier(value: number): void {
    // Guard against NaN, Infinity, negative values polluting cost calculations.
    if (!Number.isFinite(value) || value < 0) {
      this.groupCostMultiplier = 1;
      return;
    }
    this.groupCostMultiplier = value;
  }

  getGroupCostMultiplier(): number {
    return this.groupCostMultiplier;
  }

  setHighConcurrencyModeEnabled(enabled: boolean): void {
    this.highConcurrencyModeEnabled = enabled;
  }

  isHighConcurrencyModeEnabled(): boolean {
    return this.highConcurrencyModeEnabled;
  }

  setRawCrossProviderFallbackEnabled(enabled: boolean): void {
    this.rawCrossProviderFallbackEnabled = enabled;
  }

  isRawCrossProviderFallbackEnabled(): boolean {
    const endpointPolicy =
      this.endpointPolicy ??
      resolveEndpointPolicy((this.requestUrl as URL | undefined)?.pathname ?? "/");
    return (
      endpointPolicy.allowRawCrossProviderFallback &&
      (this.rawCrossProviderFallbackEnabled ?? false)
    );
  }

  shouldPersistSessionDebugArtifacts(): boolean {
    return !this.highConcurrencyModeEnabled;
  }

  shouldTrackSessionObservability(): boolean {
    return !this.highConcurrencyModeEnabled;
  }

  addSpecialSetting(setting: SpecialSetting): void {
    this.specialSettings.push(setting);
  }

  getSpecialSettings(): SpecialSetting[] | null {
    return this.specialSettings.length > 0 ? this.specialSettings : null;
  }

  /**
   * Check if client requests 1M context (based on anthropic-beta header)
   */
  clientRequestsContext1m(): boolean {
    return clientRequestsContext1mHelper(this.headers);
  }

  /**
   * 设置原始请求格式（从路由层调用）
   */
  setOriginalFormat(format: ClientFormat): void {
    this.originalFormat = format;
  }

  setMessageContext(context: MessageContext | null): void {
    this.messageContext = context;
    if (context) {
      this.stableRequestIdentity = {
        requestId: context.id,
        principalId: context.user.id,
      };
    }
    if (context?.user) {
      this.userName = context.user.name;
    }
  }

  getStableRequestIdentity(): StableRequestIdentity | null {
    return this.stableRequestIdentity;
  }

  setCyberCheckObservation(observation: CyberCheckObservationHandle): void {
    this.cyberCheckObservation = observation;
  }

  clearCyberCheckObservation(): void {
    this.cyberCheckObservation = null;
  }

  getCyberCheckObservation(): CyberCheckObservationHandle | null {
    return this.cyberCheckObservation;
  }

  copyCyberCheckObservationFrom(source: ProxySession): void {
    this.cyberCheckObservation = source.cyberCheckObservation;
  }

  /**
   * Record Time To First Byte (TTFB) for streaming responses.
   *
   * Definition: first body chunk received.
   * Non-stream responses should persist TTFB as `durationMs` at finalize time.
   */
  recordTtfb(): number {
    if (this.ttfbMs !== null) {
      return this.ttfbMs;
    }

    const value = Math.max(0, Date.now() - this.startTime);
    this.ttfbMs = value;
    this.persistLiveChain();
    return value;
  }

  /**
   * Record the timestamp when guard pipeline finished and upstream forwarding begins.
   * Called once; subsequent calls are no-ops.
   */
  recordForwardStart(): void {
    if (this.forwardStartTime === null) {
      this.forwardStartTime = Date.now();
    }
  }

  /**
   * 设置 session ID
   */
  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }

  /**
   * 设置请求序号（Session 内）
   */
  setRequestSequence(sequence: number): void {
    this.requestSequence = sequence;
  }

  /**
   * 获取请求序号（Session 内）
   */
  getRequestSequence(): number {
    return this.requestSequence;
  }

  /**
   * 获取 Provider 列表快照
   *
   * 首次调用时从进程缓存获取并冻结，后续调用返回相同数据。
   * 用于保证故障迁移期间数据一致性（避免同一请求多次调用返回不同结果）。
   *
   * @returns Provider 列表（整个请求生命周期不变）
   */
  async getProvidersSnapshot(): Promise<Provider[]> {
    if (this.providersSnapshot !== null) {
      return this.providersSnapshot;
    }

    this.providersSnapshot = await findAllProviders();
    return this.providersSnapshot;
  }

  /**
   * 获取 messages 数组长度（支持 Claude、Codex 和 Gemini 格式）
   */
  getMessagesLength(): number {
    const msg = this.request.message as Record<string, unknown>;
    // Claude 格式: messages[]
    if (Array.isArray(msg.messages)) {
      return msg.messages.length;
    }
    // Codex 格式: input[]
    if (Array.isArray(msg.input)) {
      return msg.input.length;
    }
    // Gemini 格式: contents[]
    if (Array.isArray(msg.contents)) {
      return msg.contents.length;
    }
    // Gemini CLI 包装格式: request.contents[]
    const requestData = msg.request as Record<string, unknown> | undefined;
    if (requestData && Array.isArray(requestData.contents)) {
      return requestData.contents.length;
    }
    return 0;
  }

  /**
   * 获取 messages 数组（支持 Claude、Codex 和 Gemini 格式）
   */
  getMessages(): unknown {
    const msg = this.request.message as Record<string, unknown>;
    // Claude 格式优先
    if (msg.messages !== undefined) {
      return msg.messages;
    }
    // Codex 格式
    if (msg.input !== undefined) {
      return msg.input;
    }
    // Gemini 格式: contents[]
    if (msg.contents !== undefined) {
      return msg.contents;
    }
    // Gemini CLI 包装格式: request.contents[]
    const requestData = msg.request as Record<string, unknown> | undefined;
    if (requestData?.contents !== undefined) {
      return requestData.contents;
    }
    return undefined;
  }

  /**
   * 是否应该复用 provider（基于 messages 长度）
   */
  shouldReuseProvider(): boolean {
    if (this.isRawCrossProviderFallbackEnabled()) {
      return true;
    }

    return this.getMessagesLength() > 1;
  }

  /**
   * 添加供应商到决策链（带详细元数据）
   */
  addProviderToChain(
    provider: Provider,
    metadata?: {
      reason?:
        | "session_reuse"
        | "initial_selection"
        | "concurrent_limit_failed"
        | "request_success" // 修复：添加 request_success
        | "retry_success"
        | "retry_failed" // 供应商错误（已计入熔断器）
        | "system_error" // 系统/网络错误（不计入熔断器）
        | "resource_not_found" // 上游 404 错误（不计入熔断器，仅切换供应商）
        | "retry_with_official_instructions" // Codex instructions 自动重试（官方）
        | "retry_with_cached_instructions" // Codex instructions 智能重试（缓存）
        | "client_error_non_retryable" // 不可重试的客户端错误（Prompt 超限、内容过滤、PDF 限制、Thinking 格式）
        | "http2_fallback" // HTTP/2 协议错误，回退到 HTTP/1.1（不切换供应商、不计入熔断器）
        | "responses_ws_attempted" // 已尝试上游 OpenAI Responses WebSocket 建连（信息性记录）
        | "responses_ws_fallback" // 上游 WebSocket 不可用，回退到 HTTP（不切换供应商、不计入熔断器）
        | "endpoint_pool_exhausted" // 端点池耗尽（strict endpoint policy 阻止了 fallback）
        | "vendor_type_all_timeout" // 供应商类型全端点超时（524），触发 vendor-type 临时熔断
        | "client_restriction_filtered" // 供应商因客户端限制被跳过（会话复用路径）
        | "hedge_triggered" // Hedge 计时器触发，启动备选供应商
        | "hedge_launched" // Hedge 备选供应商已启动（信息性记录）
        | "hedge_winner" // 该供应商赢得 Hedge 竞速（最先收到首字节）
        | "hedge_loser_cancelled" // 该供应商输掉 Hedge 竞速，请求被取消（未计费）
        | "hedge_loser_billed" // 该供应商输掉 Hedge 竞速，但其响应被后台拿回并计费
        | "client_abort"; // 客户端在响应完成前断开连接
      selectionMethod?:
        | "session_reuse"
        | "weighted_random"
        | "group_filtered"
        | "fail_open_fallback";
      circuitState?: "closed" | "open" | "half-open";
      attemptNumber?: number;
      errorMessage?: string; // 错误信息（失败时记录）
      endpointId?: number | null;
      endpointUrl?: string;
      // 修复：添加新字段
      statusCode?: number; // 成功时的状态码
      statusCodeInferred?: boolean; // statusCode 是否为响应体推断
      circuitFailureCount?: number; // 熔断失败计数
      circuitFailureThreshold?: number; // 熔断阈值
      errorDetails?: ProviderChainItem["errorDetails"]; // 结构化错误详情
      decisionContext?: ProviderChainItem["decisionContext"];
      strictBlockCause?: ProviderChainItem["strictBlockCause"]; // endpoint pool exhaustion cause
      endpointFilterStats?: ProviderChainItem["endpointFilterStats"]; // endpoint filter statistics
      modelRedirect?: ProviderChainItem["modelRedirect"];
      rawCrossProviderFallbackEnabled?: boolean;
    }
  ): void {
    const item: ProviderChainItem = {
      id: provider.id,
      name: provider.name,
      vendorId: provider.providerVendorId ?? undefined,
      providerType: provider.providerType,
      endpointId: metadata?.endpointId,
      endpointUrl: metadata?.endpointUrl,
      // 元数据
      reason: metadata?.reason,
      selectionMethod: metadata?.selectionMethod,
      priority: provider.priority,
      weight: provider.weight,
      costMultiplier: provider.costMultiplier,
      groupTag: provider.groupTag,
      circuitState: metadata?.circuitState,
      timestamp: Date.now(),
      attemptNumber: metadata?.attemptNumber,
      errorMessage: metadata?.errorMessage, // 记录错误信息
      // 修复：记录新字段
      statusCode: metadata?.statusCode,
      statusCodeInferred: metadata?.statusCodeInferred,
      circuitFailureCount: metadata?.circuitFailureCount,
      circuitFailureThreshold: metadata?.circuitFailureThreshold,
      errorDetails: metadata?.errorDetails, // 结构化错误详情
      decisionContext: metadata?.decisionContext,
      strictBlockCause: metadata?.strictBlockCause,
      endpointFilterStats: metadata?.endpointFilterStats,
      modelRedirect: metadata?.modelRedirect ?? this.getCurrentModelRedirect(provider.id),
      rawCrossProviderFallbackEnabled: metadata?.rawCrossProviderFallbackEnabled,
    };

    // 避免重复添加同一个供应商
    // 检查最后一条记录是否与当前记录完全相同（id + reason + attemptNumber）
    const lastItem = this.providerChain[this.providerChain.length - 1];
    const shouldAdd =
      this.providerChain.length === 0 ||
      lastItem.id !== provider.id ||
      lastItem.reason !== metadata?.reason ||
      (metadata?.attemptNumber !== undefined && lastItem.attemptNumber !== metadata.attemptNumber);

    if (shouldAdd) {
      this.providerChain.push(item);
      this.persistLiveChain();
    }
  }

  private persistLiveChain(): void {
    if (!this.sessionId || this.requestSequence == null) return;
    if (!this.shouldTrackSessionObservability()) return;
    void writeLiveChain(this.sessionId, this.requestSequence, this.providerChain);
  }

  /**
   * 获取决策链
   */
  getProviderChain(): ProviderChainItem[] {
    return this.providerChain;
  }

  setCurrentModelRedirect(
    providerId: number,
    redirect: NonNullable<ProviderChainItem["modelRedirect"]>
  ): void {
    this.currentModelRedirect = {
      providerId,
      redirect,
    };
  }

  clearCurrentModelRedirect(): void {
    this.currentModelRedirect = null;
  }

  getCurrentModelRedirect(providerId?: number): ProviderChainItem["modelRedirect"] | undefined {
    if (!this.currentModelRedirect) return undefined;
    if (providerId !== undefined && this.currentModelRedirect.providerId !== providerId) {
      return undefined;
    }
    return this.currentModelRedirect.redirect;
  }

  attachCurrentModelRedirectToLastChainItem(providerId: number): boolean {
    const redirect = this.getCurrentModelRedirect(providerId);
    if (!redirect) return false;

    const lastItem = this.providerChain[this.providerChain.length - 1];
    if (!lastItem || lastItem.id !== providerId) {
      return false;
    }

    lastItem.modelRedirect = redirect;
    this.persistLiveChain();
    return true;
  }

  /**
   * 获取原始模型（用户请求的，用于计费）
   * 如果没有发生重定向，返回当前模型
   */
  getOriginalModel(): string | null {
    return this.originalModelName ?? this.request.model;
  }

  /**
   * 获取当前模型（可能已重定向，用于转发）
   */
  getCurrentModel(): string | null {
    return this.request.model;
  }

  /**
   * Return the final JSON object sent to upstream for this attempt.
   *
   * Request filters intentionally operate on a detached body, so session.request.message may
   * describe the pre-filter request. Billing must use the serialized upstream body instead.
   *
   * After releaseRequestBodyAfterCommit() this returns the billing projection
   * (scalar fields + thinking config) instead of the full tree.
   */
  getForwardedRequestMessage(): Record<string, unknown> | null {
    if (this.requestBodyReleased) {
      return this.forwardedRequestMessage;
    }

    const source = this.forwardedRequestBody;
    if (!source) {
      return null;
    }

    if (this.forwardedRequestMessageSource === source) {
      return this.forwardedRequestMessage;
    }

    this.forwardedRequestMessageSource = source;
    try {
      const parsed = JSON.parse(source);
      this.forwardedRequestMessage =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : null;
    } catch {
      this.forwardedRequestMessage = null;
    }
    return this.forwardedRequestMessage;
  }

  /** Final request facts for billing, with a pre-forward fallback for isolated callers/tests. */
  getBillingRequestMessage(): Record<string, unknown> {
    return this.getForwardedRequestMessage() ?? (this.request.message as Record<string, unknown>);
  }

  /** Model actually sent upstream, falling back to the routed request model. */
  getBillingModel(): string | null {
    const model = this.getForwardedRequestMessage()?.model;
    return typeof model === "string" && model.trim() ? model : this.request.model;
  }

  getOpenAIImageRequestMetadata(): OpenAIImageRequestMetadata | null {
    return this.request.imageRequestMetadata ?? null;
  }

  isOpenAIImageMultipartRequest(): boolean {
    return isOpenAIImageMultipartRequest(this.getOpenAIImageRequestMetadata());
  }

  getEndpointPolicy(): EndpointPolicy {
    return this.endpointPolicy;
  }

  /**
   * 获取管理语义的 endpoint。
   * Remote Compaction v2 保留真实 /v1/responses wire path，但复用 v1 compact 的策略、日志和计费分类。
   */
  getManagedEndpoint(): string {
    return this.managedEndpoint ?? this.getEndpoint() ?? "/";
  }

  /**
   * 在请求 message 被原地规范化后，同步 raw wire body 与审计日志。
   * 标准数组请求不会调用此方法，因此原始请求字节仍保持不变。
   */
  async syncRequestBodyFromMessage(): Promise<void> {
    const serialized = JSON.stringify(this.request.message);
    if (serialized === undefined) {
      const { getLocale } = await import("next-intl/server");
      const message = await getErrorMessageServer(
        await getLocale(),
        ERROR_CODES.INVALID_NORMALIZED_BODY
      );
      throw new ProxyError(message, 400);
    }

    this.request.buffer = new TextEncoder().encode(serialized).buffer;
    this.request.log = JSON.stringify(optimizeRequestMessage(this.request.message), null, 2);
  }

  /**
   * 获取请求的 API endpoint（来自 URL.pathname）
   * 处理边界：若 URL 不存在则返回 null
   */
  getEndpoint(): string | null {
    try {
      const url = this.requestUrl;
      if (!url || typeof url.pathname !== "string") return null;
      return url.pathname || "/";
    } catch {
      return null;
    }
  }

  /**
   * 是否为 count_tokens 请求端点
   * - 依据 URL pathname 判断：/v1/messages/count_tokens
   */
  isCountTokensRequest(): boolean {
    const endpoint = this.getEndpoint();
    return endpoint !== null && isCountTokensEndpointPath(endpoint);
  }

  /**
   * 设置原始模型（在重定向前调用）
   * 只能设置一次，避免多次重定向覆盖
   * 同时保存原始 URL 路径（用于 Gemini 重置）
   */
  setOriginalModel(model: string | null): void {
    if (this.originalModelName === null) {
      this.originalModelName = model;
      this.originalUrlPathname = this.requestUrl.pathname;
    }
  }

  /**
   * 检查是否发生了模型重定向
   */
  isModelRedirected(): boolean {
    return this.originalModelName !== null && this.originalModelName !== this.request.model;
  }

  /**
   * 获取原始 URL 路径（用于 Gemini 模型重定向重置）
   */
  getOriginalUrlPathname(): string | null {
    return this.originalUrlPathname;
  }

  /**
   * 检查是否为 Claude Code CLI 探测请求
   * - [{"role":"user","content":"foo"}]
   * - [{"role":"user","content":"count"}]
   */
  isProbeRequest(): boolean {
    const messages = this.getMessages();

    // 必须是单条消息
    if (!Array.isArray(messages) || messages.length !== 1) {
      return false;
    }

    const firstMessage = messages[0] as Record<string, unknown>;
    const content = firstMessage.content;

    // content 必须是字符串
    if (typeof content !== "string") {
      return false;
    }

    // 匹配探测模式（完全匹配，忽略大小写和空格）
    const trimmed = content.trim().toLowerCase();
    return trimmed === "foo" || trimmed === "count";
  }

  /**
   * 检查是否为 Claude Messages Warmup 请求（仅用于 Anthropic /v1/messages）
   *
   * 判定标准（尽量严格，降低误判）：
   * - endpoint 必须是 /v1/messages（排除 count_tokens 等）
   * - messages 仅 1 条，且 role=user
   * - content 为单个 text block
   * - text == "Warmup"（忽略大小写/首尾空格）
   * - cache_control.type == "ephemeral"
   */
  isWarmupRequest(): boolean {
    const endpoint = this.getEndpoint();
    if (endpoint !== "/v1/messages") {
      return false;
    }

    const msg = this.request.message as Record<string, unknown>;
    const messages = msg.messages;

    if (!Array.isArray(messages) || messages.length !== 1) {
      return false;
    }

    const firstMessage = messages[0];
    if (!firstMessage || typeof firstMessage !== "object") {
      return false;
    }

    const firstObj = firstMessage as Record<string, unknown>;
    if (firstObj.role !== "user") {
      return false;
    }

    const content = firstObj.content;
    if (!Array.isArray(content) || content.length !== 1) {
      return false;
    }

    const firstBlock = content[0];
    if (!firstBlock || typeof firstBlock !== "object") {
      return false;
    }

    const blockObj = firstBlock as Record<string, unknown>;
    if (blockObj.type !== "text") {
      return false;
    }

    const text = typeof blockObj.text === "string" ? blockObj.text.trim() : "";
    if (!text || text.toLowerCase() !== "warmup") {
      return false;
    }

    const cacheControl = blockObj.cache_control;
    if (!cacheControl || typeof cacheControl !== "object") {
      return false;
    }

    const cacheControlObj = cacheControl as Record<string, unknown>;
    return cacheControlObj.type === "ephemeral";
  }

  /**
   * 设置上次选择的决策上下文（用于记录到 providerChain）
   */
  setLastSelectionContext(context: ProviderChainItem["decisionContext"]): void {
    this._lastSelectionContext = context;
  }

  /**
   * 获取上次选择的决策上下文
   */
  getLastSelectionContext(): ProviderChainItem["decisionContext"] | undefined {
    return this._lastSelectionContext;
  }

  /**
   * Get cached price data with lazy loading
   * Returns null if model not found or no pricing available
   */
  async getCachedPriceData(): Promise<ModelPriceData | null> {
    if (this.cachedPriceData === undefined && this.request.model) {
      const result = await findLatestPriceByModel(this.request.model);
      this.cachedPriceData = result?.priceData ?? null;
    }
    return this.cachedPriceData ?? null;
  }

  async getResolvedPricingByBillingSource(
    provider?: Provider | null,
    // Optional model override. Used by hedge-loser billing for the INITIAL provider's
    // losing attempt, whose session has been overwritten with the WINNER's model by
    // syncWinningAttemptSession — the override carries the loser's own model so it is
    // priced correctly. The cache key already incorporates these resolved models.
    modelOverride?: { originalModel?: string | null; redirectedModel?: string | null }
  ): Promise<ResolvedPricing | null> {
    const originalModel = modelOverride?.originalModel ?? this.getOriginalModel();
    const redirectedModel = modelOverride?.redirectedModel ?? this.getBillingModel();
    if (!originalModel && !redirectedModel) {
      return null;
    }

    if (this.cachedBillingModelSource === undefined) {
      await this.loadBillingSettings();
    }

    if (!this.hasUsableBillingSettings()) {
      logger.warn("[ProxySession] Billing settings unavailable, using fallback billing source", {
        billingSettingsSource: this.billingSettingsSource,
        fallbackBillingModelSource: this.cachedBillingModelSource,
      });
    }

    const providerIdentity = provider ?? this.provider;
    const cacheKey = [
      this.cachedBillingModelSource,
      originalModel ?? "",
      redirectedModel ?? "",
      providerIdentity?.id ?? 0,
      providerIdentity?.name ?? "",
      providerIdentity?.url ?? "",
    ].join("|");

    if (this.resolvedPricingCache.has(cacheKey)) {
      return this.resolvedPricingCache.get(cacheKey) ?? null;
    }

    const useOriginal = this.cachedBillingModelSource === "original";
    const primaryModel = useOriginal ? originalModel : redirectedModel;
    const fallbackModel = useOriginal ? redirectedModel : originalModel;

    const primaryRecord = primaryModel ? await findLatestPriceByModel(primaryModel) : null;
    let resolved = resolvePricingForModelRecords({
      provider: providerIdentity,
      primaryModelName: primaryModel,
      fallbackModelName: null,
      primaryRecord,
      fallbackRecord: null,
    });

    if (!resolved && fallbackModel && fallbackModel !== primaryModel) {
      const fallbackRecord = await findLatestPriceByModel(fallbackModel);
      resolved = resolvePricingForModelRecords({
        provider: providerIdentity,
        primaryModelName: primaryModel,
        fallbackModelName: fallbackModel,
        primaryRecord,
        fallbackRecord,
      });
    }

    this.resolvedPricingCache.set(cacheKey, resolved ?? null);
    return resolved ?? null;
  }

  /**
   * 根据系统配置的计费模型来源获取价格数据（带缓存）
   *
   * billingModelSource:
   * - "original": 优先使用重定向前模型（getOriginalModel）
   * - "redirected": 优先使用重定向后模型（request.model）
   *
   * Fallback：主模型无价格时尝试备选模型。
   *
   * @returns 价格数据；无模型或无价格时返回 null
   */
  async getCachedPriceDataByBillingSource(
    provider?: Provider | null
  ): Promise<ModelPriceData | null> {
    const resolved = await this.getResolvedPricingByBillingSource(provider);
    return resolved?.priceData ?? null;
  }

  async getCodexPriorityBillingSource(): Promise<CodexPriorityBillingSource> {
    if (this.cachedCodexPriorityBillingSource === undefined) {
      await this.loadBillingSettings();
    }

    return this.cachedCodexPriorityBillingSource ?? "requested";
  }

  private async loadBillingSettings(): Promise<void> {
    if (!this.billingSettingsPromise) {
      this.billingSettingsPromise = (async () => {
        try {
          // 主路径走 60s 进程内缓存（与各守卫同源）：finalization 每流触发一次，
          // 原先每请求直查 DB。缓存层内部已含刷新与降级（旧缓存→保守默认），
          // 基本不会抛错；catch 链保留为极端情况下的兜底。
          // 降级语义变化：冷进程 + DB 全挂时取设置层默认 billingModelSource=
          // "original"（与 DB 层默认一致），而非旧直查链的显式 "redirected"——
          // 该窗口内价格查询同样失败，实际无计费发生。
          const { getCachedSystemSettings } = await import("@/lib/config");
          const systemSettings = await getCachedSystemSettings();

          const billingModelSource =
            systemSettings.billingModelSource === "original" ||
            systemSettings.billingModelSource === "redirected"
              ? systemSettings.billingModelSource
              : "redirected";
          const codexPriorityBillingSource =
            systemSettings.codexPriorityBillingSource === "actual" ||
            systemSettings.codexPriorityBillingSource === "requested"
              ? systemSettings.codexPriorityBillingSource
              : "requested";

          if (billingModelSource !== systemSettings.billingModelSource) {
            logger.warn(
              `[ProxySession] Invalid billingModelSource: ${String(systemSettings.billingModelSource)}, fallback to "redirected"`
            );
          }
          if (codexPriorityBillingSource !== systemSettings.codexPriorityBillingSource) {
            logger.warn(
              `[ProxySession] Invalid codexPriorityBillingSource: ${String(systemSettings.codexPriorityBillingSource)}, fallback to "requested"`
            );
          }

          return {
            billingModelSource,
            codexPriorityBillingSource,
            source: "live" as const,
          };
        } catch (error) {
          logger.warn(
            "[ProxySession] Failed to load billing settings directly, trying cached fallback",
            {
              error,
            }
          );

          const { getCachedSystemSettingsOnlyCache } = await import("@/lib/config");
          const cachedSettings = getCachedSystemSettingsOnlyCache();
          const hasPersistedCachedSettings = cachedSettings != null && cachedSettings.id !== 0;
          if (hasPersistedCachedSettings && cachedSettings) {
            return {
              billingModelSource:
                cachedSettings.billingModelSource === "original" ? "original" : "redirected",
              codexPriorityBillingSource:
                cachedSettings.codexPriorityBillingSource === "actual" ? "actual" : "requested",
              source: "cache" as const,
            };
          }

          logger.error("[ProxySession] Billing settings unavailable after direct read failure", {
            error,
          });
          return {
            billingModelSource: "redirected" as BillingModelSource,
            codexPriorityBillingSource: "requested" as CodexPriorityBillingSource,
            source: "default" as const,
          };
        }
      })();
    }

    const settings = await this.billingSettingsPromise;
    this.cachedBillingModelSource = settings.billingModelSource;
    this.cachedCodexPriorityBillingSource = settings.codexPriorityBillingSource;
    this.billingSettingsSource = settings.source;
  }

  private hasUsableBillingSettings(): boolean {
    return (
      this.cachedBillingModelSource === "original" || this.cachedBillingModelSource === "redirected"
    );
  }
}

function formatHeadersForLog(headers: Headers): string {
  const collected: string[] = [];
  headers.forEach((value, key) => {
    collected.push(`${key}: ${value}`);
  });

  return collected.length > 0 ? collected.join("\n") : "(empty)";
}

function optimizeRequestMessage(message: Record<string, unknown>): Record<string, unknown> {
  const optimized = { ...message };

  if (Array.isArray(optimized.system)) {
    optimized.system = new Array(optimized.system.length).fill(0);
  }
  if (Array.isArray(optimized.messages)) {
    optimized.messages = new Array(optimized.messages.length).fill(0);
  }
  if (Array.isArray(optimized.tools)) {
    optimized.tools = new Array(optimized.tools.length).fill(0);
  }

  return optimized;
}

function resolveSessionManagedEndpoint(
  requestUrl: URL,
  requestMessage: Record<string, unknown>
): string {
  try {
    const pathname = requestUrl.pathname;
    if (typeof pathname === "string" && pathname.length > 0) {
      return isRemoteCompactionV2Request(pathname, requestMessage)
        ? V1_ENDPOINT_PATHS.RESPONSES_COMPACT
        : pathname;
    }
  } catch {}

  return "/";
}

export function extractModelFromPath(pathname: string): string | null {
  // 匹配 Vertex AI 路径：/v1/publishers/google/models/{model}:<action>
  const publishersMatch = pathname.match(/\/publishers\/google\/models\/([^/:]+)(?::[^/]+)?/);
  if (publishersMatch?.[1]) {
    return publishersMatch[1];
  }

  // 匹配官方 Gemini 路径：/v1beta/models/{model}:<action>
  const geminiMatch = pathname.match(/\/v1beta\/models\/([^/:]+)(?::[^/]+)?/);
  if (geminiMatch?.[1]) {
    return geminiMatch[1];
  }

  // 兼容 /v1/models/{model}:<action> 形式（未来可能的正式版本）
  const v1Match = pathname.match(/\/v1\/models\/([^/:]+)(?::[^/]+)?/);
  if (v1Match?.[1]) {
    return v1Match[1];
  }

  return null;
}

/**
 * Large request body threshold (10MB)
 * When request body exceeds this size and model field is missing,
 * return a friendly error suggesting possible truncation by proxy limit.
 * Related config: next.config.ts proxyClientMaxBodySize (100MB)
 */
const LARGE_REQUEST_BODY_BYTES = 10 * 1024 * 1024;

// 摄入路径的 TextDecoder：decode() 不带 stream 选项时每次调用前重置状态，可安全共享
const INTAKE_TEXT_DECODER = new TextDecoder();

function parseContentLengthHeader(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

async function parseRequestBody(
  c: Context,
  options: ProxySessionCreationOptions
): Promise<RequestBodyResult> {
  const method = c.req.method.toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";

  if (!hasBody) {
    return { requestMessage: {}, requestBodyLog: "(empty)" };
  }

  const contentLength = parseContentLengthHeader(c.req.header("content-length"));
  const contentType = c.req.header("content-type") ?? null;
  const contentEncoding = c.req.header("content-encoding") ?? null;
  const pathname = new URL(c.req.url).pathname;
  const isMultipartFormData = isOpenAIImageMultipartContentType(contentType);

  if (isMultipartFormData && parseContentEncoding(contentEncoding).length > 0) {
    throw new ProxyError("Encoded multipart request bodies are not supported.", 415);
  }

  // 未压缩/压缩请求体的 intake 体积天花板：与 codec 既有常量同源。
  // 压缩路径在 decodeRequestBody 内还有逐层检查；这里补齐"读入前按
  // content-length 预检、读入后按实际字节复核"的未压缩路径缺口。
  const intakeBodyLimitBytes = resolveIntakeBodyLimitBytes(contentEncoding);
  if (contentLength !== null && contentLength > intakeBodyLimitBytes) {
    throw new ProxyError(
      `Request body of ${contentLength} bytes exceeds the intake limit of ${intakeBodyLimitBytes} bytes.`,
      413
    );
  }

  // 原始（可能被压缩的）入站字节：用于截断检测与 multipart 透传。
  // Reading a cloned Request tees its body. If the original branch is never consumed, the stream
  // may retain the complete request in that branch's queue for the lifetime of the Hono Context.
  // High-concurrency standard Responses requests have no downstream raw-body consumer, so consume
  // the original stream directly. Normal/debug and raw-passthrough paths preserve their behavior.
  const rawRequest = shouldDirectlyConsumeHighConcurrencyCodexRequest(pathname, options)
    ? c.req.raw
    : c.req.raw.clone();
  const rawBodyBuffer = await rawRequest.arrayBuffer();
  const receivedBodyBytes = rawBodyBuffer.byteLength;
  if (receivedBodyBytes > intakeBodyLimitBytes) {
    // 复核：content-length 缺失/失真时以实际读入字节为准。
    throw new ProxyError(
      `Request body of ${receivedBodyBytes} bytes exceeds the intake limit of ${intakeBodyLimitBytes} bytes.`,
      413
    );
  }

  // Truncation detection: warn only when both conditions are met
  // 1. Absolute difference > 1MB (avoid false positives from minor discrepancies)
  // 2. Actual body < 80% of expected (significant truncation)
  // 注意：基于「接收到的原始字节」与 content-length 比较（同为压缩域），不受解压影响。
  const MIN_TRUNCATION_DIFF_BYTES = 1024 * 1024; // 1MB
  const TRUNCATION_RATIO_THRESHOLD = 0.8;
  if (
    contentLength !== null &&
    contentLength - receivedBodyBytes > MIN_TRUNCATION_DIFF_BYTES &&
    receivedBodyBytes < contentLength * TRUNCATION_RATIO_THRESHOLD
  ) {
    logger.warn("[parseRequestBody] Possible body truncation detected", {
      pathname,
      method,
      contentLength,
      actualBodyBytes: receivedBodyBytes,
      ratio: (receivedBodyBytes / contentLength).toFixed(2),
    });
  }

  let requestMessage: Record<string, unknown> = {};
  let requestBodyLog: string;
  let requestBodyLogNote: string | undefined;
  let imageRequestMetadata: OpenAIImageRequestMetadata | null = null;
  let highConcurrencyCodexSseRetention = false;

  if (getOpenAIImageEndpoint(pathname) && isMultipartFormData) {
    // 图片 multipart 请求保留 sidecar metadata，并为过滤/敏感词提供文本字段视图。
    // multipart 请求体不会被 content-encoding 压缩，按原始字节透传。
    imageRequestMetadata = await parseOpenAIImageMultipartMetadata(
      c.req.raw,
      pathname,
      contentType
    );
    requestMessage = buildOpenAIImageLogicalBody(imageRequestMetadata);
    requestBodyLog = imageRequestMetadata
      ? getOpenAIImageMultipartSummary(imageRequestMetadata)
      : "(multipart image request)";
    requestBodyLogNote = "图片 multipart 请求已记录结构化摘要。";

    return {
      requestMessage,
      requestBodyLog,
      requestBodyLogNote,
      requestBodyBuffer: rawBodyBuffer,
      contentLength,
      actualBodyBytes: receivedBodyBytes,
      imageRequestMetadata,
    };
  }

  // 非 multipart：按 content-encoding（zstd/gzip/deflate/br）解压请求体，
  // 使下游模型解析、过滤、计费、日志与转发都基于明文。
  const decodedBody = decodeRequestBody(rawBodyBuffer, contentEncoding);
  const requestBodyBuffer = decodedBody.buffer;
  const requestBodyText = INTAKE_TEXT_DECODER.decode(requestBodyBuffer);

  try {
    const parsedMessage = JSON.parse(requestBodyText) as Record<string, unknown>;
    requestMessage = parsedMessage; // 保留原始数据用于业务逻辑
    highConcurrencyCodexSseRetention = shouldUseHighConcurrencyCodexSseRetention(
      pathname,
      parsedMessage,
      options
    );
    if (highConcurrencyCodexSseRetention) {
      requestBodyLog = buildHighConcurrencyCodexRequestSummary(
        parsedMessage,
        receivedBodyBytes,
        requestBodyBuffer.byteLength
      );
      requestBodyLogNote =
        "High-concurrency Codex SSE request body omitted; structural summary retained.";
    } else {
      requestBodyLog = JSON.stringify(optimizeRequestMessage(parsedMessage), null, 2); // 仅在日志中优化
    }
  } catch {
    requestMessage = { raw: requestBodyText };
    requestBodyLog = requestBodyText;
    requestBodyLogNote = "请求体不是合法 JSON，已记录原始文本。";
  }

  return {
    requestMessage,
    requestBodyLog,
    requestBodyLogNote,
    requestBodyBuffer: highConcurrencyCodexSseRetention ? undefined : requestBodyBuffer,
    contentLength,
    // 维持原语义：actualBodyBytes 表示「接收到的原始（线上）字节」，供
    // isLargeRequestBody 的截断提示判断使用，不受解压后体积影响。
    actualBodyBytes: receivedBodyBytes,
    imageRequestMetadata,
    decodedContentEncoding: decodedBody.encoding ?? undefined,
    highConcurrencyCodexSseRetention,
  };
}
