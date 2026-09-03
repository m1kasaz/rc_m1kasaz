import type { DB } from "./db";
import {
  ackTimeouts, claimDue, markAcked, markDead, markDelivered, markRetrying,
  promoteDelivered, recoverStale, type Notification,
} from "./store";

const TIMEOUT_MS = 10_000;

export function startWorker(db: DB): void {
  setInterval(() => deliverTick(db), 1_000);
  setInterval(() => ackSweep(db), 1_000);
}

function deliverTick(db: DB): void {
  recoverStale(db);
  promoteDelivered(db);
  const n = claimDue(db);
  if (n) void deliver(db, n);
}

async function deliver(db: DB, n: Notification): Promise<void> {
  let res: Response;
  try {
    res = await fetch(n.target_url, {
      method: n.method,
      headers: JSON.parse(n.headers),
      body: n.body ?? undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    await res.text(); // 消费响应体，释放底层连接
  } catch (e) {
    return onRetryable(db, n, String(e));
  }
  if (res.status === 429 || res.status >= 500) return onRetryable(db, n, `HTTP ${res.status}`);
  if (res.status >= 400) {
    markDead(db, n.id, n.attempts + 1, `HTTP ${res.status}`);
    return console.error(`[alert:critical] dead notify_id=${n.id} error=HTTP ${res.status}`);
  }
  if (n.ack_mode === "callback") return void markDelivered(db, n.id);
  markAcked(db, n.id);
}

// 429 / 5xx / 网络错误：D3 退避；attempts>=4 warning，耗尽 critical
function onRetryable(db: DB, n: Notification, error: string): void {
  const status = markRetrying(db, n, error);
  const attempts = n.attempts + 1;
  if (status === "DEAD")
    return console.error(`[alert:critical] dead notify_id=${n.id} attempts=${attempts} error=${error}`);
  if (attempts >= 4)
    console.warn(`[alert:warning] retrying notify_id=${n.id} attempts=${attempts} error=${error}`);
}

// AWAITING_ACK 滞留：告警 + 保持状态（MVP 人工处理，§4.2）
function ackSweep(db: DB): void {
  for (const n of ackTimeouts(db))
    console.warn(`[alert:warning] ack_timeout notify_id=${n.id} ack_deadline=${n.ack_deadline}`);
}
