# OOM 保留修复:生命周期 + 有界性(2026-09-03)

Status: **Implemented and tested in worktree `zcode/oom-retention-hardening`**
(基于生产 revision c8ef2686)。未部署、未合并——上线按 canary 阶梯另行授权。

## Goal

消除 2026-09-02/03 OOM 风暴的放大机制(断连僵尸 + 惊群重试把请求体保留
推过 memcg 顶),并把内存形态变成有界、可观测。根因调查见 cops 仓
`notes/2026-09-03-cch-post-fix-oom-root-cause-investigation.md`。

成功条件:经历一次完整上线周期(含 drain/recreate)零 OOM;合成断连测试
RSS 回落基线;TTFB 无回归;在途计量与 RSS 相关。

## 变更(按 commit)

### Commit 1 — 保留正确性(原子)

- **释放迁移补全**:`releaseRequestBodyAfterCommit` 本就幂等(session.ts);
  新增三个收敛调用点——①成功首字节(原有,保持原始内联门控
  /v1/responses × codex × 高并发,并顺带标记资格)、②客户端断开
  (response-handler 的 abort 监听)、③阶梯最终失败(send() wrapper 的
  catch) + 非 SSE 成功兜底(send() wrapper 的成功分支)。
  doForward 按同门控标记资格(服务 ③②;doForward 被替身接管时 ① 仍自足)。
- **tee 客户端分支显式 cancel**(abort 监听):拆掉 60s usage-drain 窗内
  无人读分支的无界堆外队列;内部分支独立,usage 采集不受影响。
- **cyber-check 作用域拆分**(admission.ts):`submitFinalResponsesReview`
  变为同步序章(容量计费 O(1) + 投影,仍在 setImmediate 任务内与上游网络
  等待重叠,**刻意不在 TTFB 路径**)+ 异步 `uploadFinalResponsesReview`
  只捕获 packet/lease/config/context。解析树与序列化串在投影完成后毫秒级
  不可达,不再被 async 帧钉到上传结束(≤25s+轮询)。同步序章抛错
  (容量耗尽/投影失败)在 runShadowObservation 内折算 capture_gap——
  本函数绝不同步抛出,否则 setImmediate 回调的 `.then(settle, ...)` 挂不上,
  completion 永不 settle。
- **运行时指标**(runtime-metrics.ts + instrumentation-node):30s 周期
  记录 `process.memoryUsage()`(rss/heap/external/arrayBuffers)与准入
  计量快照。修复效果从推理变成测量。

明确不做:compact 透传的 `forwardedRequestBody = request.log` 别名(与
request.log 共享引用,无增量保留;它是计费降级解析源;量 ~1-3/夜)。

### Commit 2 — 边界有界性

- **intake 体积上限**:`resolveIntakeBodyLimitBytes`(codec)把既有规范常量
  接到未压缩路径——content-length 预检 + 读入后按实际字节复核,超限 413。
  不引入新数值(未压缩→MAX_DECOMPRESSED 100MB,压缩→MAX_COMPRESSED)。
- **在途保留字节准入**(`src/lib/capacity/request-admission.ts` +
  admission-guard.ts):`RequestAdmission` 进程级计量(cyber capacity 同一
  模式),charge = 64KB + k×wireBytes(k 默认 5,env
  `CCH_ADMISSION_BODY_MULTIPLIER`);intake 计费、释放迁移恰好退费一次;
  水位满在选择 provider 之前 429 + Retry-After: 3(不占 attempt、不触发
  熔断)。水位 env `CCH_ADMISSION_MAX_RETAINED_BYTES`(**默认 0=禁用**,
  部署侧显式开启:A ~2.0G / B ~0.7G 初值,按 memoryMetrics 标定)。
  计量人群 = parse 阶段的释放候选标记(高并发+/v1/responses+stream:true,
  即 buffer 已丢、log 已摘要的同一人群),保证计费人群与退费路径一一对应。
  send() wrapper 兜底退费防计量泄漏(理论不可达)。
- **阶梯总 deadline**:env `CCH_FORWARD_TOTAL_DEADLINE_MS`(默认 90s,
  0=禁用),超时抛 504 终态失败(走 ③ 释放)——失败路径保留时间获得硬上界。

### Commit 3 — PR-3 收窄说明

原计划的 buffer 丢弃与浅拷贝优化**上游已存在**(parse 阶段对高并发 codex
SSE 人群丢 buffer + 摘要 log;doForward 浅拷贝透传),无需重做。跨 attempt
stringify 缓存评估后不做:ModelRedirector 每 attempt 原地改写顶层
message.model,缓存 key 复杂化不值得(重试占比小,单次 ~2-5ms)。
字节直方图已并入 Commit 1 的指标循环(charge/window 百分位)。

## 验证

- 新增 24 测试(准入计量/释放资格/cyber 作用域/准入守卫/intake 上限/
  deadline 解析)全绿;
- 全量套件 7522 passed / 3 failed = **与基线完全一致**(已知
  error-rule-detector-reload-queue 时序 + openapi-types-drift);
- tsgo typecheck 干净;biome check 干净;
- 既有关键套件(fake-200-html、cyber-check-forwarder-admission、
  hedge-error-pipeline、request-body-release、forwarded-request-body-cache)
  全部通过——包括"gate-off 最终 SSE 无 marker 释放"与"上游先于 shadow
  观测发起"两个行为锚点(证明 TTFB 语义与释放语义保真)。

## 部署注意(另行授权)

1. Phase 0 配置先行:71 provider `streamingIdleTimeoutMs=300000`(=心跳
   MAX_MS);上线流程 drain 后 settle ≥90s 再 recreate。
2. Commit 1→2 分步上线(1 浸泡 ≥24h 后再 2),每步走 canary 阶梯
   (0→1→5→25→A/B)。
3. 启用水位:A `CCH_ADMISSION_MAX_RETAINED_BYTES=2147483648`(2G)、
   B=751619276(0.7G)量级起步,按 runtime_metrics 标定。
4. TTFB 回归对照:上线前后各取一天 sol p50/p95。
