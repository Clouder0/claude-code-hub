# CCH DB 写路径降 churn：单语句 finalize + ledger 触发器 WHEN 守卫

Status: Implemented + locally verified (2026-08-21)；待 canary 灰度部署。
Branch: `codex/db-write-churn`（基于 `codex/compaction-v2` @ 5d0ec232；
与 `codex/perf-bundle-a` 独立并行，其落地后需合流）。

## Goal

高并发 Codex SSE 转发路径的每请求 DB 写预算从 ~6 row versions 降到 4
（2 条语句 × 两表各 1 版本；进一步到 3 需去掉 INSERT 时的 ledger 触发，
见「后续候选」）：

- 现状：1 sync INSERT + 1 sync cost UPDATE + 1 buffered details UPDATE，每条
  语句再触发 `trg_upsert_usage_ledger` 全行重写（37 列 × 14 索引）。
  message_request 另有 25 个索引要维护。这是 30GB PG 膨胀（死:活 >2:1）
  的生成机制，也是每请求的实打实 CPU/IO 税。
- 成功路径（O1）后：1 INSERT + 1 合并 settlement UPDATE（终态 facts 折叠），
  ledger 触发 2 次而非 3 次（mr 2 版 + ledger 2 版 = 4）。
- 触发器守卫（O2）后：soft-delete（deleted_at）、updated_at 触碰、
  error_stack/error_cause 追加不再重写 ledger 全行（此前一次管理员批量
  软删 = N 次全行重写）。

## 非目标

- 索引删减（O3）：等 08-27 idx_scan 观察窗确认后在线 DROP，另行处理。
- 非流式路径、错误路径保持旧写形状（不动）。
- 不改任何账本语义：overlay 对重叠列（token/model 等）取 details 的观测值
  覆盖 settlement 的 billable 拆桶值，与合并前"details 最后写赢"的终态一致。

## 实现要点

- `MessageRequestFinalizeOverlay`（message.ts）：终态列集合；三个 settlement
  写（cost/winner/unsupported）可选接收，overlay 展开在 settlement 列之后
  （同键覆盖）。写成功后执行原 details 路径的副作用：public-status seed +
  rollup（once-only 机制复用）。
- finalizeStream（response-handler.ts）：anthropic 检测块前移（specialSettings
  在 settlement 快照前完成变异），构造 `finalizeDetailsPayload`，传入
  `updateRequestCostFromUsage`；返回 `detailsPersisted=false`（无 usage/无价格/
  零成本/写失败）时回退旧的 duration+details 缓冲写。非流式调用点不传 overlay，
  行为不变。
- `drizzle/0115`：PG WHEN 不能引用 TG_OP，故拆双触发器——
  `trg_upsert_usage_ledger`（AFTER INSERT，无守卫）+
  `trg_upsert_usage_ledger_on_update`（AFTER UPDATE，34 个账本消费列任一
  IS DISTINCT FROM 才触发）。`trigger.sql` 镜像同步。

## 验证（本地，postgres:18 docker + bun vitest）

- 新增单测 `message-finalize-overlay.test.ts` 6/6：overlay 合并、同键覆盖
  语义、无 overlay 时列集不变、rollup 触发/不触发边界、三个 settlement 变体。
- 新增集成 `usage-ledger-trigger-guard.test.ts` 6/6（真 PG，计数触发器作
  可观测证据）：INSERT 触发、soft-delete/error_stack/updated_at-only 不触发、
  status/cost 变更触发。
- 既有集成套件与干净库基线 parity（基线 3 个环境性失败不变）；
  gpt56-billing-lifecycle 契约已迁移到 overlay 形态（流式：settlement 带
  overlay 且 details/duration 零调用；非流式 40_003/40_007 保持旧契约）。
- 全量单测 791 文件 / 7320 用例全过；typecheck 通过；biome 对触及文件干净。

## 后续候选（未实施）

- 4 → 3：去掉 INSERT 时的 ledger 触发（推迟 ledger 行创建到 finalize）。
  代价：ledger 无在途行（实时性由 Redis session 层承担）、warmup 需显式
  补写、崩溃丢终态更依赖 backfill。判断点：ledger 是否需要在途可见性。
- settlement 前的 flushMessageRequestWriteBuffer 已加（review 发现的
  stale-patch 覆盖窗口）；fire-and-forget 写与终态的竞态为旧代码同款，
  非回归，未处理。

## 部署注意（canary 阶梯时）

1. 0115 迁移必须在应用滚动前应用（AUTO_MIGRATE=false，生产手工跑）；
   触发器替换是 DROP+CREATE，毫秒级，无锁风险。
2. 灰度验收新增观察项：`pg_stat_user_tables` 的 usage_ledger n_tup_upd 增速
   下降 ~1/3；message_request n_tup_upd 降 ~1/3。
3. 本地测试 PG：workstation docker `cch-it-pg`（127.0.0.1:5466，
   库 cch_it_test），复测可直接用。
