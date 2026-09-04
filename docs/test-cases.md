# 测试用例评审：NotifyHub v2.0

> 版本：v2.0 ｜ 上游：`docs/tech-design.md` v2.0（接口 §5、状态机 §5.4、失败策略 §4.2/4.3、回执机制 §5.3）
>
> 每条用例**可追溯**：来源列标注其验证的技术文档章节。评审列记录用例评审结论（通过/修改/补充）。
> v2.0 变更：随 D1（业务级回执）新增 ack 用例组（§5）；D3 退避序列更新（§4）；v1.0 用例全部保留并复核。
> v2.1 变更：三主机联调实测暴露 ack 竞态（TC-C8），修订 ack 可接受状态集合（TC-C3/TC-C4）。

## 1. 评审结论摘要

- 用例总数：**39**（接口功能 17、确认/回执 8、可靠性 8、并发/边界 6）
- 评审结论：**通过，需补充 3 条**（TC-R5 崩溃恢复、TC-B4 退避抖动、TC-C7 ack 乱序重复），已纳入
- 覆盖策略：接口契约为骨架（§5.1/§5.2/§5.3），状态机迁移为路径（§5.4），失败分类矩阵为可靠性用例（§4.2），PRD 决策 D1–D4 各至少一条端到端用例守护

## 2. 接口功能用例（POST /v1/notifications）

| 编号 | 标题 | 前置条件 | 步骤 | 预期结果 | 来源 | 评审 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-F1 | 正常提交通知 | — | POST 合法请求（全字段，ack_mode=http_2xx） | 202；notify_id、status=PENDING、duplicated=false；库中一条 PENDING 记录 | §5.1 | 通过 |
| TC-F1b | callback 模式受理 | — | ack_mode=callback | 202 受理；投递成功后期望状态路径为 DELIVERED→AWAITING_ACK（见 TC-C 组） | §5.1/§5.4 | 通过 |
| TC-F2 | 缺 idempotency_key | — | 省略该字段 | 422，fields 指明缺失字段；无记录产生 | §5.1 | 通过 |
| TC-F3 | target_url 非 https | — | http:// 地址 | 422 "must be https" | §5.1 | 通过 |
| TC-F4 | target_url 非法格式 | — | "not-a-url" | 422 "invalid url" | §5.1 | 通过 |
| TC-F5 | method 非法 | — | method="DELETE" | 422（仅允许 POST/PUT/PATCH） | §5.1 | 通过 |
| TC-F6 | headers 非对象 | — | headers 为字符串 | 422 | §5.1 | 通过 |
| TC-F7 | headers 含被禁字段 | — | 含 Host / Content-Length | 422 或剥离后受理（二选一，用例锁定"不得污染供应商请求"） | §5.1 | 通过 |
| TC-F8 | body 缺省 | — | 不提供 body | 202 受理，透传空体 | §5.1 | 通过 |
| TC-F9 | body 为任意 JSON | — | 嵌套对象/数组 | 202；存储与透传保持语义不变 | §5.1 | 通过 |
| TC-F10 | 重复提交同幂等键（同体） | 已用 K 提交成功 | 相同 body 再以 K 提交 | 202；duplicated=true；返回首次 notify_id；库中仍仅 1 条 | §5.1/§2.1 | 通过 |
| TC-F11 | 同幂等键不同请求体 | 已用 K 提交 | 不同 body 再以 K | 409 IDEMPOTENCY_CONFLICT | §5.1 | 通过 |
| TC-F12 | 并发同幂等键 | — | 两并发请求同 K 同 body | 均 202；仅 1 条记录；至少一个 duplicated=true；无 500（唯一索引兜底） | §3/§2.1 | 通过 |

## 3. 查询用例（GET /v1/notifications/{id}）

| 编号 | 标题 | 前置条件 | 步骤 | 预期结果 | 来源 | 评审 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-Q1 | 查询存在记录 | TC-F1 已受理 | GET | 200；字段齐全；completed_at 为 null | §5.2 | 通过 |
| TC-Q2 | 查询不存在 | — | GET 随机 id | 404 | §5.2 | 通过 |
| TC-Q3 | IN_FLIGHT 映射 | 任务正被 claim | GET | 对外不出现 IN_FLIGHT，映射为 PENDING/RETRYING | §5.4 | 通过 |
| TC-Q4 | 查询 ACKED 记录 | 某任务已 ACKED | GET | status=ACKED；completed_at 有值 | §5.2 | 通过 |
| TC-Q5 | 查询 AWAITING_ACK 记录 | callback 模式任务已 2xx | GET | status=AWAITING_ACK；ack_deadline=completed_at 基准 +24h | §5.2/§5.4 | 通过 |

## 4. 确认/回执用例（POST /v1/notifications/{id}/ack）

> D1 的核心验证组：「假送达」问题的解必须被独立用例守护。

| 编号 | 标题 | 前置条件 | 步骤 | 预期结果 | 来源 | 评审 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-C1 | ack success 闭环 | callback 任务处于 AWAITING_ACK | POST ack {result:success} | 200；status=ACKED；completed_at 写入 | §5.3/§5.4 | 通过 |
| TC-C2 | ack failed 路径 | 同上 | POST ack {result:failed, reason} | 200；status=ACK_FAILED；reason 记入 ack_result；触发 critical 告警 | §5.3/§4.2 | 通过 |
| TC-C3 | ack 迟到（超时后到达） | AWAITING_ACK 已超 ack_deadline 并告警 | POST ack | **接受**（200 → ACKED）：ack_deadline 是告警线而非状态过期线，滞留期间迟到的真实回执应当生效，避免人工误重放 | §4.2/§5.3 | **随竞速修复修订** |
| TC-C4 | 对非法态 ack | 任务为 PENDING / RETRYING / ACKED / DEAD / ACK_FAILED | POST ack | 409 INVALID_STATE；状态不被污染（请求尚未发出或已终结时不接受回执） | §5.3 | 通过 |
| TC-C5 | http_2xx 模式拒收 ack | ack_mode=http_2xx 的任务（2xx 后已直接 ACKED 终态） | POST ack | 409（终态拒绝） | §5.3/§5.4 | 通过 |
| TC-C6 | ack 超时告警 | callback 任务 AWAITING_ACK | 等待 ack_deadline 过期（测试可注入时钟） | warning 告警产生；**状态保持滞留**，不自动迁移 | §4.2/§5.3 | 通过 |
| TC-C7 | **重复/乱序 ack**（评审补充） | 同一任务连续两次 ack success | 第二次 ack | 第一次生效（ACKED）；第二次 409；不产生重复副作用 | §5.3 | **评审补充** |
| TC-C8 | **ack 与投递结果竞速**（三主机实测暴露） | callback 任务，供应商收到通知后**立即**回执（快于 worker 写库） | 观察最终状态 | 回执在 IN_FLIGHT/DELIVERED 态到达时被接受，最终恰好一次迁移到 ACKED；worker 迟到的投递结果写库因 `AND status='IN_FLIGHT'` 守卫而失效，不产生重复副作用 | §5.4 | **评审补充** |

## 5. 可靠性用例（投递与重试）

> 以 §4.2 失败分类矩阵逐行展开；供应商响应用本地 mock server 构造。

| 编号 | 标题 | 前置条件 | 步骤 | 预期结果 | 来源 | 评审 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-R1 | 2xx 投递成功（http_2xx 模式） | mock 返回 200 | 受理后观察 | status=ACKED；attempts=1；无 last_error | §4.2/§5.4 | 通过 |
| TC-R1b | 2xx 投递（callback 模式） | mock 200，ack_mode=callback | 受理后观察 | status=DELIVERED → AWAITING_ACK；**不得直接 ACKED** | §5.4 | 通过 |
| TC-R2 | 5xx 退避重试 | mock 连续 503 | 受理后观察 | RETRYING；attempts 递增；next_retry_at 按 1m/5m/30m/2h… 节奏 | §4.3 | 通过 |
| TC-R3 | 429 尊重 Retry-After | mock 429 + Retry-After: 120 | 同上 | next_retry_at = max(120s, 退避值) | §4.2 | 通过 |
| TC-R4 | 4xx 直接死信 | mock 400 | 受理后观察 | 不重试，直接 DEAD；attempts=1；last_error 含 400 | §4.2 | 通过 |
| TC-R5 | **Worker 崩溃恢复**（评审补充） | 任务 IN_FLIGHT 时 kill worker | 重启 worker | 孤儿任务重置 RETRYING（next_retry_at=now，退避档不重置）并最终送达；无任务永久滞留 | §4.4 | **评审补充** |
| TC-R6 | 重试耗尽进死信 | mock 持续 503 | 观察至 attempts=8 | DEAD + critical 告警；记录可查询；不再自动重试 | §4.3 | 通过 |
| TC-R7 | warning 告警阈值 | mock 持续 503 | 观察至 attempts=4 | 第 4 次重试时产生 warning 告警（约 2h 未成功的信号） | §4.3 | 通过 |

## 6. 并发与边界用例

| 编号 | 标题 | 前置条件 | 步骤 | 预期结果 | 来源 | 评审 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-B1 | 进程重启不丢任务 | 已受理 10 条 PENDING | 重启进程 | 继续投递，10 条全部达终态（D4 事务持久化） | §1/§5.1 | 通过 |
| TC-B2 | 供应商超时 | mock 挂起 30s | 受理后观察 | 10s 超时按可重试失败处理，无挂死 | §2.2 | 通过 |
| TC-B3 | 网络不可达 | mock 端口关闭 | 受理后观察 | 可重试失败 → RETRYING | §4.2 | 通过 |
| TC-B4 | **退避抖动**（评审补充） | mock 503，连续受理 20 条 | 对比 next_retry_at | 同批任务退避时间分散（±20% jitter），非齐发 | §4.3 | **评审补充** |
| TC-B5 | 受理后回执前崩溃 | 202 已返回 | 立即 kill 进程再重启 | 通知仍存在且可被投递（事务先于回执，D4） | §5.1/§4.4 | 通过 |
| TC-B6 | AWAITING_ACK 任务重启 | 任务处于 AWAITING_ACK | 重启进程 | ack_deadline 扫描恢复工作；任务不因重启回退或丢失 | §5.3 | 通过 |

## 7. 评审意见汇总

1. **D1–D4 决策的用例守护**：每条决策至少一条端到端用例——D1：TC-C 全组 + TC-R1b；D2：TC-F10/F11/F12；D3：TC-R2/R6/R7；D4：TC-B1/B5。
2. **补充 TC-R5**：初稿遗漏 §4.4 崩溃恢复扫描验证，这是 at-least-once 的关键兜底，必须有自动化用例。
3. **补充 TC-B4**：只验"会退避"不验"退避有抖动"，无抖动会对刚恢复的供应商形成重试风暴。
4. **补充 TC-C7**：回执通道与请求通道一样存在重复/乱序（两将军问题对 ack 同样成立），状态机必须拒绝非法迁移。
5. **不在 MVP 用例范围**：性能压测（100 TPS 为设计余量）、多实例竞争消费（v2.0）、安全渗透（假定内网可信）、真实告警通道集成（部署项）。已对应技术文档 §6 演进路线。
6. **测试实现建议**：TC-R*/TC-B*/TC-C* 用本地 HTTP mock 构造供应商响应与回执；时间相关断言（退避、ack_deadline）注入可控时钟或允许 ±10% 容差；TC-B5/TC-R5 的进程崩溃用子进程启动 + SIGKILL 实现。
