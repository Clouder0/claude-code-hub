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

## Phase 2 — 管道副本清剿(2026-09-03 与 Human 对齐定稿;同日实现完成见文末状态)

背景:午间事故归因(cops `notes/2026-09-03-cch-midday-oom-final-root-cause.md`)证明 Commit 1/2 之外
的主导项 = **树(~2× body,V8 堆内)从 parse 持有到 TTFB**(codex 巨体 54MB 均值 × 30-120s 窗口 ×
~20 并发)。方向经多轮对齐收敛:**先做管道内逐点副本清剿(本阶段),admission 保持 env 可选
(已实现,默认 0=禁用),磁盘 offload 仅作最后手段不实现**。hotpath RAM 优化落在细节;任何门控按
字节估算 RAM 而非按并发请求计数(槽位信号量方案已否决)。

提交序列(每步独立可测,vitest + 本地合成负载断言 RSS):

1. **树在首次发送时死亡,出站 bytes 成为唯一通货**(2026-09-03 二次复检精化):源码已存
   `forwardedRequestBody`(完整序列化串,直到释放才 null)+`forwardedRequestMessage`(浅引用树,
   计费缓存)+`request.message`——正常路径 TTFB 前实存 ≈3×(树 2× + 堆内 string 1×),与实测
   3.25G 更吻合。修复=改造现有结构而非新机制:①setForwardedRequestBody 时以 Uint8Array 存储
   通货(堆→堆外,B 的 640M heap 关键);②同时把 request.message 就地换投影(投影机制已在
   release 中存在,计费"释放后走投影"语义已生产验证);③无变更 attempt 直接复用 bytes
   (原"缓存不值得"结论是树通货前提下的,bytes 通货下复用免费);有变更才瞬态重解析。
   净效果 3×(含堆内)→1×(堆外)。
2. buffer 在 parse 后即死(仅 raw-passthrough 例外)——生产 codex 流式人群**已在 parse 丢弃**
   (复检确认),本项收窄为 messages/gemini/非流式小流量路径 + **rectifier 例外**:
   `syncRequestBodyFromMessage`(response-input-rectifier 触发)会重建 buffer(1×)+ 重建**完整**
   pretty-log(1115 行,input 不截断)——实现时必须核其实际触发频率并纳入 2/3 的处置范围。
3. pretty-log 惰性化——生产 codex 路径 intake 已摘要化(复检确认),真正残留仅 rectifier 重建
   路径(见 2)与小流量端点;`input`/`contents` 截断照做。
4. (并入 1)通货用 Uint8Array 而非 string——不是微小优化,是堆→堆外的类别迁移。
5. ~~cyber tee 内部分支按字节限界~~ **(2026-09-03 复核降级)**:重读源码证实内部消费已有界——
   `BoundedStreamTextAccumulator` 只留头+尾快照(STREAM_STATS_HEAD_BYTES 封顶),慢 I/O
   (cyber 上传/计费/Redis)全在流结束后的 finalize,且 b614eb25 已拆掉上传对树/文本的钉扎。
   事故中的 TimeoutError 风暴是噪声无内存实害。残留疑点已闭:**生产 langfuse 未启用**
   (A/B env 与 system_settings 均无 langfuse 配置),全量文本路径不会激活,本项无事可做。
   compact pathname 补进两处保留判断照旧(现因精确匹配全程 ~4×)。
6. 摄入阶段客户端断开接线——复检降级:无背压暂停态时,Node http server 在断连时已让请求流
   error 出清,b614eb25 又已接响应阶段 abort;真正需要它的是 Layer 2 的"暂停中断开"状态,
   随 Layer 2 一并做。
7. 流式解压**不做**——先加压缩巨体计数器,有真实流量再议。

admission 使用原则:启用前保留观测(runtime_metrics 已输出 inUseBytes/highWaterBytes),
"估算 vs 实测 RSS"即生产校准;水位线用实测值回填。磁盘 offload 触发条件(记录不实现):
管道清剿后仍有 1×bytes × 并发的实测证据超出 memcg 预算。

### 基石提交实现简报(2026-09-03 开工,触点地图)

`session.request.message` 在 forwarder 的读写触点(改前必查):
- 678:早期读取(发送前,安全);1173:rectifier;
- **2681-2942:每 attempt 的 body 改写阶段**(model redirect/anthropic override/cache TTL,
  原地改写 session.request.message——这是树必须活到 commit 的原因,也是 bytes 通货要替代的消费者);
- 3067/4269:读 stream 标量;3078/5334:hedge shadow structuredClone(生产未启用);
- **3128-3181:序列化站点**(`{...spread}` 浅拷贝 → 过滤 → JSON.stringify → setForwardedRequestBody);
- 3380 附近注释:重试改写语义说明。
session 侧:`forwardedRequestBody: string|null`(计费惰性解码源, getForwardedRequestMessage
1041-1044 已有 released→投影 分支);`setForwardedRequestBody` 237-246。
设计落点:①序列化完成后立刻把 request.message 换投影+通货转 Uint8Array(堆外);
②2681-2942 的每 attempt 改写改为「从 bytes 重解析→浅改→重序列化」(瞬态,仅重试);
③无变更 attempt 直接复用 bytes;④getForwardedRequestMessage 的惰性解码源改为 bytes。
**最终落点(已核实)**:改写区+序列化站都在 `doForward(attemptNumber?)` 单函数内、每 attempt
重入——钩子=doForward 顶部「若 request.message 已是投影且 bytes 在→从 bytes 瞬态重解析为工作树」
+ setForwardedRequestBody 后「换投影+转 Uint8Array」。重解析源=上一次 attempt 的实际出站
(私有参数已滤,幂等改写安全)。注意:投影须含 `stream` 标量(3067/4269 读它);
release 的 source 选择 forwardedRequestMessage 优先,不受影响;rectifier(1173)在发送前,
不受影响。
计费语义锚点:post-TTFB 计费走投影已是生产验证行为(成功流每天如此)。

## 验证(Phase 1)

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

## Phase 2 实现状态(2026-09-03)

已实现并全量验证(worktree zcode/oom-retention-hardening):
- **bytes 通货**(基石):setForwardedRequestBody 以 Uint8Array 存出站体(堆外),request.message
  即刻退位为计费投影;重试经 rematerializeRequestMessageForRetry 从 bytes 瞬态重解析(doForward
  顶部钩子 + hedge 克隆前置重物化);getForwardedRequestMessage 只缓存投影,源引用守卫保留(直赋
  失效)。计费/诊断消费者经 getForwardedRequestBodyText()(仅 langfuse/调试快照,入口守卫后,
  langfuse 生产未启用=零边际成本)。TTFB 窗口存留 3×(含堆内)→1×(堆外)。
- **compact 释放域修正**:compact 是 raw_passthrough 端点(转发通货=request.buffer,bodyUsed=false
  契约),只纳入 TTFB 释放人群(RELEASE 集合),不进摄入人群(INTAKE 集合仅 /v1/responses)——
  初版把它放进摄入人群是错误,测试刑讯后纠正。
- **日志驻留上限**:input/contents 零填充方案被诊断可见性契约(compact trigger 的 type、
  normal-mode 内容)否决,改为 64KiB 字符截断(capRequestLogForRetention),非 JSON fallback 同限。
- 验证:全量 7525 passed / 3 failed = 与基线一致(已知 error-rule 时序 + openapi-drift);
  tsgo/biome 干净;bytes-currency-collectability.test 以 WeakRef+memoryUsage 双证明
  (树可回收、N 并发仅 ~1×body 外部字节)——需 NODE_OPTIONS=--expose-gtc 运行。
- 未做(记录):磁盘 offload(最后手段)、摄入背压(Layer 2)、流式解压(计数器先行)。
