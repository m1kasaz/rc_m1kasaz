# 三主机联调测试（three-host test）

> 目的：在统一子网的三台真实主机上验证「upstream 提交通知 → worker 投递 → downstream 处理并回执 ack」的全流程，覆盖单进程测试无法触及的真实网络边界（TCP 连接、超时、跨主机路由）。
> 建模约定：按现有方案，ack 是**同一行记录的状态迁移**而非新记录——全流程走完后 worker 的 SQLite 中该通知为 **1 条记录、status=ACKED**（trace：PENDING → IN_FLIGHT → AWAITING_ACK → ACKED）。

## 拓扑与角色

```
主机 A (upstream)          主机 B (worker)                    主机 C (downstream)
业务系统模拟器              NotifyHub 完整服务                  供应商模拟器
curl / 脚本                 API :3100 + Worker×2 + SQLite      scripts/mock-vendor.ts :4101
   │ POST /v1/notifications      │                                    │ POST /notify → 200
   │────────────────────────────▶│ 领取任务 → POST /notify ──────────▶│ 读 X-Notify-Id 头
   │                             │  status: AWAITING_ACK             │ 回调 POST /:id/ack
   │                             │◀───────────────────────────────────│  (WORKER_URL 指向 B)
   │ GET 查询 → ACKED            │  status → ACKED                   │
```

前提：三台主机同一子网互通；以下用 `$A`/`$B`/`$C` 表示各主机局域网 IP（`ipconfig getifaddr en0` / `ip addr` 查看）。

## 各主机执行步骤

### 主机 B（worker）

```bash
npm install
NOTIFYHUB_ALLOW_HTTP=1 npm start        # 跨主机 target_url 为 http，需测试特批
# 监听 :3100，db 文件 ./notifyhub.db
```

### 主机 C（downstream）

```bash
WORKER_URL=http://$B:3100 PORT=4101 npx tsx scripts/mock-vendor.ts
# ACK_RESULT 可选：success（默认）/ failed / none（不回执，验证滞留告警）
```

### 主机 A（upstream）

```bash
# 1. 提交通知（callback 模式）
curl -X POST http://$B:3100/v1/notifications \
  -H 'content-type: application/json' \
  -d '{"idempotency_key":"e2e-1","target_url":"http://'$C':4101/notify","ack_mode":"callback","body":{"event":"user_registered"}}'
# → 202 {"notify_id":"…","status":"PENDING"}

# 2. 轮询状态直至终态
curl http://$B:3100/v1/notifications/<notify_id>
# → {"status":"ACKED", ...}（约 2~3 秒内；worker 每秒轮询领取 + downstream 自动回执）

# 3. 负向场景
curl -X POST http://$B:3100/v1/notifications -H 'content-type: application/json' \
  -d '{"idempotency_key":"e2e-2","target_url":"http://'$C':4101/fail"}'
# → 轮询至 RETRYING（attempts 递增，next_retry_at 约 1 分钟后，±20% 抖动）

curl -X POST http://$B:3100/v1/notifications -H 'content-type: application/json' \
  -d '{"idempotency_key":"e2e-3","target_url":"http://'$C':4101/bad"}'
# → 轮询至 DEAD（4xx 不重试）
```

## 预期结果断言

在主机 B 上查询（服务需先停掉以 checkpoint WAL，或用 `PRAGMA wal_checkpoint(FULL)`）：

```bash
node -e "
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync('notifyhub.db');
console.log(db.prepare('SELECT idempotency_key,status,attempts,last_error FROM notifications ORDER BY created_at').all());
"
```

| 记录 | 预期 |
| --- | --- |
| e2e-1 | `ACKED`，attempts=0，有 completed_at——**单条记录完成全流程**（含 downstream 自动回执） |
| e2e-2 | `RETRYING`，attempts≥1，last_error=`HTTP 503`，next_retry_at 已排程 |
| e2e-3 | `DEAD`，attempts=1（4xx 直接死信，不重试） |

worker 日志（主机 B）应能看到：`[alert:warning] retrying … attempts=4`（若观察够久）与 e2e-3 的 `[alert:critical] dead …`；主机 C 日志确认收到通知并发出回执。

## 网络故障注入（可选，验证兜底）

在主机 C 上模拟供应商故障，观察主机 B 的退避行为：

```bash
# 防火墙丢包（模拟网络不可达，macOS 示例）
sudo pfctl -ef - <<'EOF'
block drop in on en0 proto tcp from $B to any port 4101
EOF
# 观察 e2e-2 类任务：last_error 变为 fetch failed，仍按退避重试
sudo pfctl -d   # 恢复后任务自动续投
```

## 与单进程 smoke 的分工

| | `npm run smoke` | 三主机联调（本文档） |
| --- | --- | --- |
| 覆盖 | 18 条断言全路径（含 422/409/幂等） | 主路径跨网络边界验证 |
| 网络 | 进程内回环 | 真实 TCP/超时/丢包 |
| 崩溃恢复（TC-R5/B1） | 未覆盖 | 可手动 kill worker 验证 recoverStale |
| 运行成本 | 一条命令 | 三台主机 |
