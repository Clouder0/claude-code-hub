# Codex 请求审查适配器

CCH 可把最终将要发往 Codex 的 `/v1/responses` HTTP/SSE 请求投影到独立
`cyber-check` 服务。审查发生在最终 request filter、provider override、校验与
`JSON.stringify` 之后，但在任何 HTTP 或 WebSocket 上游 I/O 之前。因此审查对象与实际出站
逻辑 body 一致，tool result、assistant tool call、developer context、tool schema 和内联图片不会
因只检查最新 user message 而丢失。

## 启用

```dotenv
CYBER_CHECK_MODE=shadow
CYBER_CHECK_URL=http://127.0.0.1:8090
CYBER_CHECK_GATEWAY_TOKEN=replace-with-the-shared-gateway-token
CYBER_CHECK_GATEWAY_ID=cch
CYBER_CHECK_ZSTD_MIN_BYTES=262144
```

`CYBER_CHECK_MODE` 有三个值：

- `off`：默认值，不调用审查服务；
- `shadow`：发送真实投影并记录结果，但同步 deny 或服务故障都不阻断请求；
- `enforce`：执行服务返回的有效 deny；投影、协议或服务不可用时 fail closed，返回本地
  `cyber_check_unavailable`，而不是伪造上游 `cyber_policy`。

`cyber-check` 服务本身也有独立的 `shadow/enforce`。只有服务返回有效 deny 且 CCH 处于
`enforce` 时才会阻断。非 loopback 服务必须使用 HTTPS。

CCH 对达到 `CYBER_CHECK_ZSTD_MIN_BYTES`（默认 256 KiB）的审查包使用 Node 异步 zstd，压缩
级别固定为 1；若压缩结果没有变小则仍发送普通 JSON。固定低级别是为了降低跨服务字节数，同时
避免把同步 admission 路径变成追求极致压缩率的 CPU 热点。服务端会分别限制 wire body 和解压后
JSON 的大小。

## 同步与异步

CCH 对每个受支持的最终请求调用：

```text
POST /v1/request-reviews
  200 completed -> 继续或本地拒绝
  202 pending   -> 暂时放行，并取得 job_id

GET /v1/review-jobs/{job_id}
  pending | completed | failed
```

`202` 后 CCH 在本次客户端连接仍存活时短期观察 Job；审查服务在异步 deny 提交时原子安装
session restriction，因此即使 CCH 停止轮询，下一次请求仍会在服务端命中限制。V0 不会在异步
deny 到达后中止已经发出的上游请求；这是后续需要独立验证取消、重试和计费语义的能力。

## 上游 Cyber 事件

审查服务成功接收一次 admission 后，CCH 只在同一个实际 provider attempt 收到结构化
`cyber_policy` 时回报：

```text
POST /v1/provider-events
  204 -> 事件与 session restriction 已持久化
```

Correlation 只包含该 admission 的 identity 与 provider ID，不持有审查正文。普通错误文本、
`invalid_prompt`、本地 reviewer 预测和 `bio_policy` 都不会升级成这个权威事件。Hedge attempt 各自
持有 correlation，只有赢家会同步回 tracking session，避免把拒绝归到错误的 provider 或最终 body。

事件回报与 CCH 已有的本地遏制同时启动，但两者不共享成败：CCH 仍会立即执行 session block、
security event 和 cyber strike；`cyber-check` 不可用时只记录无正文的回报失败。如果本次 attempt
没有成功 admission，就没有可验证的 join key，因此 CCH 不向中心服务猜测归因，本地遏制仍照常
执行。

网关 request id 使用 `message_request.id + final body SHA-256`。同一最终 body 的 provider
重试或 hedge 会命中服务端幂等结果；provider rewrite 产生不同最终 body 时会得到独立审查。
SHA-256 同时用于把审查记录与真实出站 bytes 关联，不用于判断内容安全。
Hedge attempt 仍会清空完整 `messageContext` 以避免重复持久化，但会保留 request/user/key 三个
标量 ID，因此每个真实出站 attempt 都能完成同一套审查，而不会重新持有整块用户上下文。

## V0 边界

- 只处理 Codex provider 的 `/v1/responses` HTTP/SSE 请求；inbound Responses WebSocket、
  `/v1/responses/compact` 和其他协议保持原行为。
- `previous_response_id`、`conversation`、prompt template、远程图片、新 item/content 类型和
  compaction 都被明确标为 partial coverage，不能静默当成完整上下文。
- encrypted reasoning 只发送 opaque marker，不复制 ciphertext；普通请求日志也不记录投影正文。
- 小于压缩阈值的请求仍使用普通 JSON；阈值应根据部署链路的 CPU、带宽和延迟测量调整，而不是
  提高 zstd 级别。
