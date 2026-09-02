/**
 * 进程级"在途请求保留字节"准入计量(request working-set admission)。
 *
 * 语义:每个进入转发阶梯的请求,在 intake 处按其工作集估算(固定开销 +
 * 倍率 × 线上字节数)计费;在请求体释放迁移(`releaseRequestBodyAfterCommit`,
 * 覆盖成功首字节 / 客户端断开 / 阶梯最终失败)处恰好退费一次。水位满时,
 * 新请求在选择 provider 之前被拒绝(429 + Retry-After),把"memcg OOM 全体
 * 在途陪葬"变成"新请求退避重试、在途请求自然排空"。
 *
 * 刻意保持粗粒度(与 `src/lib/cyber-check/capacity.ts` 同一模式):这是
 * 工作集准入,不是分配器记账。租约的存在期即请求的保留窗口(TTFB),由
 * Little 定律自动涌现"到达率 × 窗口 × 单体大小"的聚合,无需显式建模时长。
 *
 * 只计量"释放语义已验证"的人群(高并发 codex /v1/responses 流式请求),
 * 与 `ProxySession` 的释放资格标记共用同一判定,保证计费人群与退费路径
 * 一一对应——否则退费钩子永远不触发,计量泄漏等于永久误拒。
 */

const FIXED_CHARGE_BYTES = 64 * 1024;
const DEFAULT_BODY_MULTIPLIER = 5;
const DEFAULT_MAX_RETAINED_BYTES = 0; // 0 = 禁用(部署侧经 env 显式开启)
const RESERVOIR_CAPACITY = 512;

export interface RequestAdmissionConfig {
  /** 同时在途的估算保留字节上限;<= 0 表示禁用(准入恒通过,仍采样指标)。 */
  maxRetainedBytes: number;
  /** 每 body 字节的计费倍率(解析树 + 序列化串 + 转发树等工作集系数)。 */
  bodyMultiplier: number;
}

export interface RequestAdmissionLease {
  readonly chargedBytes: number;
  /** 恰好一次生效的退费。 */
  release(): void;
}

export interface PercentileSummary {
  p50: number;
  p95: number;
  max: number;
}

export interface RequestAdmissionSnapshot {
  maxRetainedBytes: number;
  inUseBytes: number;
  highWaterBytes: number;
  acquires: number;
  rejections: number;
  activeLeases: number;
  chargeBytes: PercentileSummary | null;
  /** 租约存活时长(≈ 请求保留窗口)的百分位,单位毫秒。 */
  windowMs: PercentileSummary | null;
}

export function admissionCharge(bodyBytes: number, bodyMultiplier: number): number {
  if (!Number.isSafeInteger(bodyBytes) || bodyBytes < 0 || !Number.isFinite(bodyMultiplier)) {
    return Number.POSITIVE_INFINITY;
  }
  return FIXED_CHARGE_BYTES + bodyBytes * bodyMultiplier;
}

class PercentileReservoir {
  private readonly samples: number[] = [];

  push(value: number): void {
    this.samples.push(value);
    if (this.samples.length > RESERVOIR_CAPACITY) {
      this.samples.splice(0, this.samples.length - RESERVOIR_CAPACITY);
    }
  }

  summary(): PercentileSummary | null {
    if (this.samples.length === 0) return null;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
    return { p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] };
  }
}

export class RequestAdmission {
  private readonly config: RequestAdmissionConfig;
  private inUseBytes = 0;
  private highWaterBytes = 0;
  private acquires = 0;
  private rejections = 0;
  private activeLeases = 0;
  private readonly chargeBytesReservoir = new PercentileReservoir();
  private readonly windowMsReservoir = new PercentileReservoir();

  constructor(config: RequestAdmissionConfig) {
    this.config = config;
  }

  /**
   * 获取租约;水位不足或单体计费超过水位时返回 null(拒绝)。
   * 禁用态(maxRetainedBytes <= 0)恒发放零计费租约,保持调用方流程统一。
   */
  tryAcquire(bodyBytes: number): RequestAdmissionLease | null {
    const chargedBytes = admissionCharge(bodyBytes, this.config.bodyMultiplier);
    const max = this.config.maxRetainedBytes;
    if (max > 0 && Number.isSafeInteger(max)) {
      if (chargedBytes > max || this.inUseBytes > max - chargedBytes) {
        this.rejections += 1;
        return null;
      }
      return this.grant(chargedBytes);
    }
    return this.grant(0);
  }

  snapshot(): RequestAdmissionSnapshot {
    return {
      maxRetainedBytes: this.config.maxRetainedBytes,
      inUseBytes: this.inUseBytes,
      highWaterBytes: this.highWaterBytes,
      acquires: this.acquires,
      rejections: this.rejections,
      activeLeases: this.activeLeases,
      chargeBytes: this.chargeBytesReservoir.summary(),
      windowMs: this.windowMsReservoir.summary(),
    };
  }

  private grant(chargedBytes: number): RequestAdmissionLease {
    this.acquires += 1;
    this.activeLeases += 1;
    if (chargedBytes > 0) {
      this.inUseBytes += chargedBytes;
      if (this.inUseBytes > this.highWaterBytes) {
        this.highWaterBytes = this.inUseBytes;
      }
      this.chargeBytesReservoir.push(chargedBytes);
    }
    const acquiredAt = Date.now();
    let released = false;
    return {
      chargedBytes,
      release: () => {
        if (released) return;
        released = true;
        this.activeLeases -= 1;
        if (chargedBytes > 0) {
          this.inUseBytes -= chargedBytes;
          this.windowMsReservoir.push(Date.now() - acquiredAt);
        }
      },
    };
  }
}

function parseNonNegativeIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return fallback;
  return parsed;
}

export function resolveRequestAdmissionConfigFromEnv(): RequestAdmissionConfig {
  return {
    maxRetainedBytes: parseNonNegativeIntEnv(
      "CCH_ADMISSION_MAX_RETAINED_BYTES",
      DEFAULT_MAX_RETAINED_BYTES
    ),
    bodyMultiplier: parseNonNegativeIntEnv(
      "CCH_ADMISSION_BODY_MULTIPLIER",
      DEFAULT_BODY_MULTIPLIER
    ),
  };
}

export interface RequestAdmissionSingleton {
  admission: RequestAdmission;
  config: RequestAdmissionConfig;
}

const singletonState = globalThis as unknown as {
  __CCH_REQUEST_ADMISSION__?: RequestAdmissionSingleton;
};

/** 进程级单例;测试请直接 new RequestAdmission(config),勿复用单例。 */
export function getRequestAdmission(): RequestAdmissionSingleton {
  if (!singletonState.__CCH_REQUEST_ADMISSION__) {
    const config = resolveRequestAdmissionConfigFromEnv();
    singletonState.__CCH_REQUEST_ADMISSION__ = { admission: new RequestAdmission(config), config };
  }
  return singletonState.__CCH_REQUEST_ADMISSION__;
}
