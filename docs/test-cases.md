# 测试用例评审：NotifyHub v1.0

> 版本：v1.0 ｜ 上游：`docs/tech-design.md`（接口 §5、状态机 §5.3、失败策略 §4.2）
>
> 每条用例**可追溯**：来源列标注其验证的技术文档章节。评审列记录用例评审结论（通过/修改/补充）。

## 1. 评审结论摘要

- 用例总数：**26**（接口功能 16、可靠性 6、并发/边界 4）
- 评审结论：**通过，需补充 2 条**（TC-R5 崩溃恢复、TC-B4 超时边界），已纳入下表
- 覆盖策略：以接口契约为骨架（§5.1/§5.2），以状态机迁移为路径（§5.3），以失败分类矩阵为可靠性用例（§4.2）

## 2. 接口功能用例（POST /v1/notifications）

| 编号 | 标题 | 前置条件 | 步骤 | 预期结果 | 来源 | 评审 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-F1 | 正常提交通知 | — | POST 合法请求（idempotency_key/target_url/method/headers/body 齐全，https） | 202；返回 notify_id、status=PENDING、duplicated=false；库中落一条 PENDING 记录 | §5.1 | 通过 |
| TC-F2 | 缺 idempotency_key | — | 省略该字段 POST | 422 VALIDATION_FAILED，fields 指明缺失字段；不产生任何记录 | §5.1 | 通过 |
| TC-F3 | target_url 非 https | — | target_url=http://api.vendor.com | 422，reason="must be https" | §5.1 | 通过 |
| TC-F4 | target_url 非法格式 | — | target_url="not-a-url" | 422，reason="invalid url" | §5.1 | 通过 |
| TC-F5 | method 非法 | — | method="DELETE" | 422（MVP 仅允许 POST/PUT/PATCH） | §5.1 | 通过 |
| TC-F6 | headers 非对象 | — | headers="Authorization: x"（字符串） | 422 | §5.1 | 通过 |
| TC-F7 | headers 含被禁字段 | — | headers 含 Host 或 Content-Length | 422 或注入剥离后受理（实现二选一，以代码为准，用例锁定"不得污染供应商请求"） | §5.1 | 通过 |
| TC-F8 | body 缺省 | — | 不提供 body | 202 受理，透传空体 | §5.1 | 通过 |
| TC-F9 | body 为任意 JSON | — | body 为嵌套 JSON 对象/数组 | 202；存储与透传保持原文不变（序列化不改变语义） | §5.1 | 通过 |
| TC-F10 | 重复提交同幂等键（同请求体） | 已用 key=K 提交成功 | 相同 body 再以 K 提交 | 202；duplicated=true；返回**首次** notify_id；库中仍只有 1 条记录 | §5.1/§2.1 | 通过 |
| TC-F11 | 同幂等键不同请求体 | 已用 key=K 提交 | 不同 body 再以 K 提交 | 409 Conflict | §5.1 | 通过 |
| TC-F12 | 并发同幂等键提交 | — | 两个并发请求同 K 同 body | 两者均 202；仅一条记录；至少一个 duplicated=true（唯一索引兜底，无 500） | §3/§2.1 | 通过 |

## 3. 接口功能用例（GET /v1/notifications/{id}）

| 编号 | 标题 | 前置条件 | 步骤 | 预期结果 | 来源 | 评审 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-Q1 | 查询存在记录 | TC-F1 已受理 | GET 该 notify_id | 200；字段齐全（status/attempts/next_retry_at/created_at）；completed_at 为 null | §5.2 | 通过 |
| TC-Q2 | 查询不存在 | — | GET 随机 id | 404 NOT_FOUND | §5.2 | 通过 |
| TC-Q3 | 状态映射正确性 | 任务正被 claim（内部 IN_FLIGHT） | GET 查询 | 对外不出现 IN_FLIGHT，映射为 PENDING/RETRYING | §5.3 | 通过 |
| TC-Q4 | 查询成功态记录 | 某任务已 SUCCESS | GET 查询 | status=SUCCESS；completed_at 有值；next_retry_at 为 null | §5.2 | 通过 |

## 4. 可靠性用例（投递与重试）

> 以 §4.2 失败分类矩阵逐行展开；供应商响应通过本地 mock server 构造。

| 编号 | 标题 | 前置条件 | 步骤 | 预期结果 | 来源 | 评审 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-R1 | 2xx 投递成功 | mock 返回 200 | 受理后等待 worker 轮询 | status=SUCCESS；attempts=1；completed_at 已写；last_error 为空 | §4.2/§2.2 | 通过 |
| TC-R2 | 5xx 触发退避重试 | mock 连续返回 503 | 受理后观察 | 首次失败后 status=RETRYING，attempts=1，next_retry_at≈now+1m；后续按 1m/5m/30m/2h 节奏重试 | §4.2 | 通过 |
| TC-R3 | 429 尊重退避 | mock 返回 429 | 同上 | 进入 RETRYING；若响应带 Retry-After 则取其与退避值较大者 | §4.2 | 通过 |
| TC-R4 | 4xx（除429）直接死信 | mock 返回 400 | 受理后观察 | 不重试，直接 DEAD；attempts=1；last_error 含 400 | §4.2 | 通过 |
| TC-R5 | **Worker 崩溃恢复**（评审补充） | 任务处于 IN_FLIGHT 时 kill worker | 重启 worker | 恢复扫描将孤儿任务重置为 RETRYING（next_retry_at=now），最终被成功投递；全程无任务永久滞留 IN_FLIGHT | §4.3 | **评审补充** |
| TC-R6 | 重试耗尽进死信 | mock 持续 503 | 观察至 attempts=max_attempts(5) | status=DEAD；记录保留可查询；不再自动重试 | §4.2 | 通过 |

## 5. 并发与边界用例

| 编号 | 标题 | 前置条件 | 步骤 | 预期结果 | 来源 | 评审 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-B1 | 进程重启不丢任务 | 已受理 10 条 PENDING | 重启进程 | 重启后 worker 继续投递，10 条全部达终态 | §1/§4.1 | 通过 |
| TC-B2 | 供应商超时 | mock 挂起 30s | 受理后观察 | 10s 超时按可重试失败处理（RETRYING），无挂死任务 | §2.2 | 通过 |
| TC-B3 | 网络不可达 | mock 端口关闭 | 受理后观察 | 按可重试失败处理，RETRYING | §4.2 | 通过 |
| TC-B4 | **退避抖动**（评审补充） | mock 503，连续受理 20 条 | 对比各任务 next_retry_at | 同批次任务的退避时间呈分散分布（±20% jitter），非同一时刻齐发 | §4.2 | **评审补充** |

## 6. 评审意见汇总

1. **通过**：接口契约（TC-F1~F12、TC-Q1~Q4）覆盖正常流、参数校验矩阵、幂等三种路径（重复/冲突/并发），与 §5.1 一一对应，无遗漏。
2. **补充 TC-R5**：初稿遗漏 §4.3 崩溃恢复扫描的验证。该逻辑是 at-least-once 的关键兜底（防 IN_FLIGHT 孤儿），必须有自动化用例守护。
3. **补充 TC-B4**：初稿只验"会退避"，未验"退避有抖动"。无抖动的齐重重试会对刚恢复的供应商形成重试风暴（惊群），属于真实工程风险。
4. **不在 MVP 用例范围**：性能压测（≥100 TPS 为设计余量而非验收线）、多实例并发消费（v2.0 演进项）、安全渗透（MVP 内部服务假定内网可信）。已记录于技术文档 §6 演进路线，避免用例膨胀。
5. **测试实现建议**：TC-R*/TC-B* 用例以本地 HTTP mock（如 `msw` 或 node 原生 http server）构造供应商响应；时间相关的退避断言允许 ±10% 容差，避免对 wall-clock 的脆弱依赖。
