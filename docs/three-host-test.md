# 三主机联调测试手册（three-host test）

> 目的：在统一子网的三台真实主机上，从下载代码开始，一步步验证「upstream 提交通知 → worker 投递 → downstream 处理并自动回执 ack」的全流程。
> 建模约定：按现有方案，ack 是**同一行记录的状态迁移**而非新记录——全流程走完后 worker 的 SQLite 中该通知为 **1 条记录、status=ACKED**（trace：PENDING → IN_FLIGHT → AWAITING_ACK → ACKED）。

## 0. 角色与拓扑总览

| 主机 | 角色 | 跑什么 | 需要的软件 | 端口 |
| --- | --- | --- | --- | --- |
| A | upstream（业务系统模拟器） | 只用 `curl` 发请求 | curl（任何系统自带） | 无 |
| B | worker（NotifyHub 完整服务） | `npm start` | Node.js ≥ 22.5 + git | 3100 |
| C | downstream（供应商模拟器） | `npm run vendor` | Node.js ≥ 22.5 + git | 4101 |

```
A (curl)                B (NotifyHub)                  C (mock vendor)
   │ POST /v1/notifications     │                              │
   │───────────────────────────▶│ 领取任务 ── POST /notify ───▶│
   │                            │ status=AWAITING_ACK          │ 读 X-Notify-Id 头
   │                            │◀── POST /:id/ack ────────────│ 自动回调回执
   │ GET 查询 → ACKED           │ status=ACKED                 │
```

下文用 `$A` `$B` `$C` 代表三台主机的局域网 IP，操作时全部替换成实际 IP。

---

## 1. 准备工作（每台主机都做）

### 1.1 确认 Node.js ≥ 22.5

代码用了 Node 内置的 `node:sqlite`（22.5 才引入），**版本不够会直接报错**：

```bash
node -v
# 要求 ≥ v22.5.0（如 v22.11.0、v24.x、v26.x 均可）
```

不够就装：

```bash
# macOS
brew install node
# Linux（apt）
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs
# 或用 nvm 装 22+：nvm install 22 && nvm use 22
```

### 1.2 查本机的局域网 IP

```bash
# macOS
ipconfig getifaddr en0        # 通常 192.168.x.x 或 10.x.x.x
# Linux
ip addr show | grep 'inet '   # 找非 127.0.0.1 的那条
# Windows (PowerShell)
ipconfig                      # 找“IPv4 地址”
```

把三个 IP 记下来，例如：

```
$A = 192.168.1.10
$B = 192.168.1.11
$C = 192.168.1.12
```

### 1.3 确认三台主机互通

在 A 上测（B、C 同理）：

```bash
ping -c 3 $B     # 能通
ping -c 3 $C
nc -zv $B 3100   # 暂时会显示 refused，因为服务还没起；通了网络即可
```

---

## 2. 下载代码（B 和 C 需要；A 只用 curl，不需要代码）

三台主机都需要能访问 GitHub。推荐 git clone：

```bash
# 在 B 和 C 上分别执行
git clone https://github.com/m1kasaz/rc_m1kasaz.git
cd rc_m1kasaz
```

没有 git 的话用 zip 下载：

```bash
curl -L -o rc.zip https://codeload.github.com/m1kasaz/rc_m1kasaz/zip/refs/heads/main
unzip rc.zip && cd rc_m1kasaz-main
```

---

## 3. 启动主机 B（worker / NotifyHub 服务）

```bash
cd rc_m1kasaz
npm install
```

预期：安装 `hono`、`@hono/node-server`、`tsx`，无编译报错（全部纯 JS 依赖，不需要原生编译）。

启动服务——**注意必须带 `NOTIFYHUB_ALLOW_HTTP=1`**，否则跨主机的 `http://` target_url 会被 422 拒绝：

```bash
NOTIFYHUB_ALLOW_HTTP=1 npm start
```

预期输出：

```
NotifyHub listening on :3100
```

（Node 可能额外打一行 `(node:xxxx) ExperimentalWarning: SQLite is an experimental feature` —— 正常，不影响功能。）

**保持这个终端不要关。** 另开一个终端验证它真的在监听：

```bash
lsof -i :3100          # 应看到 node 进程 LISTEN
curl -s http://$B:3100/v1/notifications/nope
# 预期：{"error":"NOT_FOUND"}   ← 服务活了
```

如果 B 上有防火墙/安全组，放行 3100（示例）：

```bash
# Ubuntu (ufw)
sudo ufw allow 3100/tcp
# macOS 应用层防火墙默认不拦，如启用过 pf 需自行加规则
```

---

## 4. 启动主机 C（downstream / 供应商模拟器）

`WORKER_URL` 告诉模拟器回执该发给谁——**必须是 B 的地址**：

```bash
cd rc_m1kasaz
npm install                                              # 若 C 已装过可跳过
WORKER_URL=http://$B:3100 PORT=4101 npm run vendor
```

预期输出：

```
mock vendor listening on :4101, ack → http://$B:3100 (success)
```

**保持终端不要关。** 另开终端验证：

```bash
curl -s -X POST http://$C:4101/notify -d '{}' 
# 预期：ok        （没带 X-Notify-Id 头，所以只会回 ok、不会发回执）
```

防火墙放行 4101：

```bash
sudo ufw allow 4101/tcp    # Ubuntu 示例
```

---

## 5. 在主机 A 上执行测试

A 只需要 curl。下面每条命令里的 `$B` `$C` 记得替换（或直接 `B=192.168.1.11 C=192.168.1.12` 先设变量）。

### 5.1 主流程：提交通知 → 自动回执 → ACKED

```bash
B=192.168.1.11    # ← 改成实际 IP
C=192.168.1.12    # ← 改成实际 IP

# ① 提交通知（callback 模式：2xx 后等供应商业务回执）
curl -s -X POST http://$B:3100/v1/notifications \
  -H 'content-type: application/json' \
  -d '{"idempotency_key":"e2e-1","target_url":"http://'$C':4101/notify","ack_mode":"callback","body":{"event":"user_registered"}}'
```

预期返回（**立刻返回，不等供应商**）：

```json
{"notify_id":"xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx","status":"PENDING","duplicated":false}
```

记下返回的 `notify_id`。

### 5.2 轮询状态直到终态

把 `<notify_id>` 换成上一步的值：

```bash
ID=<notify_id>
for i in $(seq 1 15); do
  curl -s http://$B:3100/v1/notifications/$ID; echo
  sleep 1
done
```

预期 2~3 秒内看到（中途可能短暂出现 `AWAITING_ACK`，最终以这个收尾）：

```json
{"notify_id":"…","status":"ACKED","attempts":0,"max_attempts":8,"next_retry_at":null,"ack_deadline":"…","last_error":null,"created_at":"…","completed_at":"…"}
```

**这一行就是"全流程验证"的证据**：B 受理 → B 投递到 C → C 读 `X-Notify-Id` 头 → C 回调 `http://$B:3100/v1/notifications/<id>/ack` → B 置为 ACKED。整条链只产生了 **1 条 SQL 记录**。

### 5.3 负向场景一：供应商故障（503 → 退避重试）

```bash
curl -s -X POST http://$B:3100/v1/notifications \
  -H 'content-type: application/json' \
  -d '{"idempotency_key":"e2e-2","target_url":"http://'$C':4101/fail"}'
ID2=<返回的 notify_id>
sleep 3
curl -s http://$B:3100/v1/notifications/$ID2; echo
```

预期：

```json
{"status":"RETRYING","attempts":1,"last_error":"HTTP 503","next_retry_at":"…约1分钟后…"}
```

### 5.4 负向场景二：请求无效（400 → 直接死信）

```bash
curl -s -X POST http://$B:3100/v1/notifications \
  -H 'content-type: application/json' \
  -d '{"idempotency_key":"e2e-3","target_url":"http://'$C':4101/bad"}'
ID3=<返回的 notify_id>
sleep 3
curl -s http://$B:3100/v1/notifications/$ID3; echo
```

预期：

```json
{"status":"DEAD","attempts":1,"last_error":"HTTP 400", …}
```

### 5.5 可选：回执失败 / 不回执

```bash
# 在 C 上改环境变量重启 vendor，可验证另外两条路径：
ACK_RESULT=failed WORKER_URL=http://$B:3100 PORT=4101 npm run vendor
# → 通知走到 ACK_FAILED（业务拒绝），B 的日志出现 [alert:critical] ack_failed

ACK_RESULT=none WORKER_URL=http://$B:3100 PORT=4101 npm run vendor
# → 通知停在 AWAITING_ACK；24 小时后 B 打 [alert:warning] ack_timeout
#   （可用小脚本把 ack_deadline 改短来快速验证：UPDATE notifications SET ack_deadline=1 WHERE id='…'）
```

---

## 6. 在主机 B 上验证 SQL 落库（最终断言）

先**另开终端**查（不用停服务，强制 checkpoint 即可读全量）：

```bash
cd rc_m1kasaz
node -e "
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync('notifyhub.db');
db.exec('PRAGMA wal_checkpoint(FULL);');
console.log(JSON.stringify(db.prepare('SELECT idempotency_key,status,attempts,last_error,completed_at FROM notifications ORDER BY created_at').all(),null,1));
"
```

预期三条记录：

| idempotency_key | status | attempts | last_error | 说明 |
| --- | --- | --- | --- | --- |
| e2e-1 | `ACKED` | 0 | null | 单条记录完成全流程（含自动回执），有 completed_at |
| e2e-2 | `RETRYING` | ≥1 | `HTTP 503` | 退避重试中，next_retry_at 已排程（约 1m，±20% 抖动） |
| e2e-3 | `DEAD` | 1 | `HTTP 400` | 4xx 直接死信，不重试 |

同时看 B 启动终端的日志，应有 e2e-3 的：

```
[alert:critical] dead notify_id=… error=HTTP 400
```

---

## 7. 可选进阶：网络故障注入（验证兜底）

在 C 上临时阻断 B 的访问，模拟供应商网络不可达：

```bash
# Ubuntu 示例：丢弃来自 B 的包
sudo iptables -A INPUT -p tcp --dport 4101 -s $B -j DROP
# 观察 B：e2e-2 类任务的 last_error 会变成 fetch failed，仍按退避节奏重试
# 恢复：
sudo iptables -D INPUT -p tcp --dport 4101 -s $B -j DROP
# 恢复后下一个退避到期（约 1 分钟）任务自动续投
```

也可以直接 **kill C 上的 vendor 进程**模拟供应商宕机：任务进入 RETRYING；重新启动 vendor 后自动恢复投递——这就是"供应商挂了一夜恢复后通知照样送达"（D3）。

---

## 8. 常见问题排查

| 现象 | 原因与解决 |
| --- | --- |
| `curl: (7) Failed to connect` | 服务没起 / IP 写错 / 防火墙拦了。`lsof -i :3100`（B）、`lsof -i :4101`（C）确认在监听 |
| submit 返回 422 `target_url must be https` | B 启动时忘了加 `NOTIFYHUB_ALLOW_HTTP=1`，重启 B |
| 状态一直停在 `AWAITING_ACK` | C 的 `WORKER_URL` 没指向 B（或写成了 localhost）→ 回执发错了地方；看 B 日志有没有收到 ack 请求 |
| `EADDRINUSE: :3100`（或 4101） | 上次进程没杀干净：`pkill -f "tsx src/index.ts"` / `pkill -f mock-vendor` 后重启 |
| 提交返回 `duplicated: true` | `notifyhub.db` 残留了旧数据（idempotency_key 冲突）：`rm -f notifyhub.db*` 后重启 B |
| 第 6 步 SQL 查询结果为空 | 服务没停时 WAL 未 checkpoint——用 `PRAGMA wal_checkpoint(FULL)`（上文已含），或停掉 B 再查 |
| `ExperimentalWarning: SQLite` | 正常现象，Node 内置模块的实验性警告，不影响功能 |
| 状态停在 `RETRYING` 不动 | 正常——退避间隔是分钟级的，等下一个 `next_retry_at` 到期（轮询每秒发生） |

## 9. 清理

```bash
# B 和 C：Ctrl+C 停掉服务即可；想清空数据：
rm -f notifyhub.db*
```

---

## 附：与单进程 smoke 的分工

| | `npm run smoke`（B 主机一条命令） | 三主机联调（本手册） |
| --- | --- | --- |
| 覆盖 | 18 条断言：两种确认模式、退避、死信、幂等三路径、422/404/409 | 主路径的跨网络边界验证 |
| 网络 | 进程内回环，无真实 TCP | 真实 TCP、真实超时、可防火墙丢包 |
| 适合 | 开发迭代、CI、快速回归 | 验收演示、网络层故障演练 |
| 崩溃恢复（TC-R5/B1） | 未覆盖 | 可 kill B 的进程后重启验证（任务从 RETRYING 续投） |
