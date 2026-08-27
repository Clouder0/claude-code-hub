# Codex 请求审查适配器

CCH 把最终将发往 Codex 的 `/v1/responses` HTTP/SSE 请求投影给独立的 `cyber-check`
服务。调用点位于最终 request filter、provider override、校验与序列化之后、任何上游 I/O
之前。因此 Reviewer 看到的是完整有序的出站上下文，而不是仅看最新 user message；tool result、
assistant tool call、developer instruction、tool schema 和受支持的内联图片都不会漏掉。

## 启用

```dotenv
CYBER_CHECK_MODE=shadow
CYBER_CHECK_URL=http://127.0.0.1:8090
CYBER_CHECK_GATEWAY_TOKEN=replace-with-the-shared-gateway-token
CYBER_CHECK_ZSTD_MIN_BYTES=262144
```

`CYBER_CHECK_MODE`：

- `off`：默认，不调用服务；
- `shadow`：普通审查服务故障 fail open；
- `enforce`：投影、协议、同步 Reviewer 或服务故障 fail closed，返回
  `cyber_check_unavailable`。

CCH 和服务端的 rollout mode 应一起调整。服务端 shadow 会把本地负面判断表达为
`decision: allow` 加 `predicted_decision: deny`。CCH 始终执行服务返回的有效 `decision`：这样已经由
上游事件建立的 session/client/principal restriction 在 shadow 期间仍然有效。证据磁盘容量不足在
证据容量耗尽或异步审核队列无法建立 admission 时，任何模式都返回
`cyber_check_capacity` 并停止转发，因为继续发出请求会破坏审计不变量。非 loopback
服务必须使用 HTTPS。

达到 `CYBER_CHECK_ZSTD_MIN_BYTES` 的审查包使用 Node 异步 zstd level 1；压缩后没有更小时仍发送
普通 JSON。低级别用于降低跨服务字节数且不把 admission 变成 CPU 热点。服务端分别限制 wire body
与解压后 JSON。

## 身份与同步/异步结果

协议只发送直接字段：

- `request_id = message_request.id + final-body SHA-256`；
- `principal_id = CCH user.id`；
- 可选 `client_instance_id = client_metadata["x-codex-installation-id"]`；
- `session_id` 与 `sequence`。

installation ID 必须是非空、无 CR/LF、UTF-8 不超过 256 字节的字符串；不满足就省略。它只能用来在
已认证 principal 下做归因和 containment，不是认证凭据。协议不发送 gateway ID、key/credential ID、
`safety_identifier` 或推断设备指纹。Hedge attempt 只保留稳定 request/principal 标量；完整
`messageContext` 仍被释放以避免重复持久化。

```text
POST /v1/request-reviews
  200 completed -> 按 effective decision 继续或本地拒绝；没有 Job ID
  202 pending   -> 暂时放行，并取得 job_id

GET /v1/review-jobs/{job_id}
  pending | completed | failed
```

`202` 后 CCH 只在客户端连接仍存活时短期观察 Job。负面异步结果在终态可见前由服务端安装后续
session restriction；停止轮询不会丢掉限制。V1 不承诺撤回已经发出的当前上游请求。

## 上游事件、错误与人工解禁

只有同一个已 admission 的实际 provider attempt 返回结构化 `error.code == "cyber_policy"` 时，
CCH 才回报权威事件。普通文本、`invalid_prompt`、本地 Reviewer 预测和 `bio_policy` 都不会升级。

```text
POST /v1/provider-events
  200 -> principal strike 数及 session/client/principal containment 状态
```

中心回报与 CCH 既有的 Redis session block、security event 和本地 strike SQL 并行执行。一次中心
provider hit 会封锁当前 session 24 小时，并在存在 installation ID 时无限期封锁该 client instance；
30 天新 epoch 内两个去重 hit 会限制 principal。中心响应确认 principal restriction 后，CCH 直接禁用
整个 user 并失效鉴权缓存。

触发请求仍返回真实上游 `cyber_policy`。后续网关拒绝使用 `gateway_cyber_restricted`；session 文案可
携带 retry time，client/principal 文案提示联系管理员，但不会泄露匹配规则或 Reviewer rationale。

管理员通过 edit、toggle 或 renew-and-enable 把 CCH user 从 disabled 改回 enabled 之前，CCH 先调用：

```text
POST /v1/principals/{principal_id}/reinstatement
```

只有中心 reset 成功后才启用用户，并更新 CCH 本地 `cyber_policy_reset_at`。失败时用户保持 disabled。
解禁只开始新的 strike epoch，不加入白名单，也不会释放 client-instance restriction；client 必须另行
显式 release，且下次 provider hit 仍会再次封锁。

## 证据生命周期与 V1 边界

成功且无权威事件的终态 best-effort 回报 `POST /v1/request-outcomes`。普通候选从 `pending/` 删除，
选中的 allowed 校准样本进入滚动 `samples/`，风险与 provider evidence 留在 `cases/`。仍可能产生
provider event 的 billable hedge loser 不会被过早 clean；交给有界 TTL 清理。

V1 只处理 Codex provider 的 `/v1/responses` HTTP/SSE。Inbound Responses WebSocket、
`/v1/responses/compact` 和其他协议保持原行为。Referenced provider context、远程媒体、新 item/content
类型、encrypted compaction 等都显式标记 partial coverage；encrypted reasoning 只发送 opaque marker，
不复制 ciphertext。普通 CCH 日志也不记录投影正文。
