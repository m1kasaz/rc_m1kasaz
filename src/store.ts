import { randomUUID } from "node:crypto";
import type { DB } from "./db";

// D3 退避序列：1m / 5m / 30m / 2h / 6h / 24h / 72h
export const BACKOFF_MS = [60e3, 300e3, 1800e3, 7200e3, 21600e3, 86400e3, 259200e3];

export interface Notification {
  id: string;
  idempotency_key: string;
  target_url: string;
  method: string;
  headers: string;
  body: string | null;
  ack_mode: string;
  status: string;
  attempts: number;
  max_attempts: number;
  next_retry_at: number | null;
  backoff: number;
  last_error: string | null;
  ack_deadline: number | null;
  ack_result: string | null;
  created_at: number;
  completed_at: number | null;
}

export interface SubmitInput {
  idempotency_key: string;
  target_url: string;
  method: string;
  headers: string;
  body: string | null;
  ack_mode: string;
}

export function getByKey(db: DB, key: string): Notification | undefined {
  return db.prepare("SELECT * FROM notifications WHERE idempotency_key = ?").get(key) as Notification | undefined;
}

export function getById(db: DB, id: string): Notification | undefined {
  return db.prepare("SELECT * FROM notifications WHERE id = ?").get(id) as Notification | undefined;
}

export function sameRequest(a: Notification, b: SubmitInput): boolean {
  return a.target_url === b.target_url && a.method === b.method &&
    a.headers === b.headers && a.body === b.body && a.ack_mode === b.ack_mode;
}

export function insertNotification(db: DB, input: SubmitInput): Notification {
  const now = Date.now();
  const row: Notification = {
    id: randomUUID(), ...input, status: "PENDING", attempts: 0, max_attempts: 8,
    next_retry_at: now, backoff: 0, last_error: null, ack_deadline: null, ack_result: null,
    created_at: now, completed_at: null, updated_at: now,
  };
  db.prepare(`INSERT INTO notifications
    (id, idempotency_key, target_url, method, headers, body, ack_mode, status,
     attempts, max_attempts, next_retry_at, backoff, last_error, ack_deadline, ack_result,
     created_at, completed_at, updated_at)
    VALUES
    (@id, @idempotency_key, @target_url, @method, @headers, @body, @ack_mode, @status,
     @attempts, @max_attempts, @next_retry_at, @backoff, @last_error, @ack_deadline, @ack_result,
     @created_at, @completed_at, @updated_at)`).run(row);
  return row;
}

// 原子领取一条 due 任务（单进程内同步执行，天然无竞态）
export function claimDue(db: DB): Notification | undefined {
  const now = Date.now();
  return db.prepare(`UPDATE notifications SET status = 'IN_FLIGHT', updated_at = ?
    WHERE id = (SELECT id FROM notifications
                WHERE status IN ('PENDING','RETRYING') AND next_retry_at <= ?
                ORDER BY next_retry_at LIMIT 1)
    RETURNING *`).get(now, now) as Notification | undefined;
}

// §4.4 Worker 崩溃恢复：孤儿 IN_FLIGHT 重新入队，退避档不重置
export function recoverStale(db: DB, staleMs = 60e3): void {
  const now = Date.now();
  db.prepare(`UPDATE notifications SET status = 'RETRYING', next_retry_at = ?, updated_at = ?
    WHERE status = 'IN_FLIGHT' AND updated_at < ?`).run(now, now, now - staleMs);
}

// DELIVERED → AWAITING_ACK（独立小步：worker 两步写之间崩溃也能被下一 tick 推进）
export function promoteDelivered(db: DB, ackWindowMs = 24 * 3600e3): void {
  const now = Date.now();
  db.prepare(`UPDATE notifications SET status = 'AWAITING_ACK', ack_deadline = ?, updated_at = ?
    WHERE status = 'DELIVERED'`).run(now + ackWindowMs, now);
}

export function markAcked(db: DB, id: string): void {
  const now = Date.now();
  db.prepare(`UPDATE notifications SET status = 'ACKED', completed_at = ?, updated_at = ? WHERE id = ?`).run(now, now, id);
}

export function markDelivered(db: DB, id: string): void {
  db.prepare(`UPDATE notifications SET status = 'DELIVERED', updated_at = ? WHERE id = ?`).run(Date.now(), id);
}

// 返回迁移后的状态：RETRYING 或 DEAD（耗尽）
export function markRetrying(db: DB, n: Notification, error: string): string {
  const attempts = n.attempts + 1;
  if (attempts >= n.max_attempts) return markDead(db, n.id, attempts, error), "DEAD";
  const idx = Math.min(n.backoff, BACKOFF_MS.length - 1);
  const wait = Math.round(BACKOFF_MS[idx] * (0.8 + Math.random() * 0.4)); // ±20% 抖动
  db.prepare(`UPDATE notifications SET status = 'RETRYING', attempts = ?, backoff = ?,
    next_retry_at = ?, last_error = ?, updated_at = ? WHERE id = ?`)
    .run(attempts, idx + 1, Date.now() + wait, error, Date.now(), n.id);
  return "RETRYING";
}

export function markDead(db: DB, id: string, attempts: number, error: string): void {
  const now = Date.now();
  db.prepare(`UPDATE notifications SET status = 'DEAD', attempts = ?, last_error = ?, completed_at = ?, updated_at = ? WHERE id = ?`)
    .run(attempts, error, now, now, id);
}

// 仅允许 AWAITING_ACK → ACKED/ACK_FAILED；非法迁移返回 null（调用方区分 404/409）
export function applyAck(db: DB, id: string, result: "success" | "failed", reason: string | null): Notification | null {
  const status = result === "success" ? "ACKED" : "ACK_FAILED";
  const now = Date.now();
  return (db.prepare(`UPDATE notifications SET status = ?, ack_result = ?, completed_at = ?, updated_at = ?
    WHERE id = ? AND status = 'AWAITING_ACK' RETURNING *`).get(status, reason, now, now, id) as Notification | undefined) ?? null;
}

export function ackTimeouts(db: DB): Notification[] {
  return db.prepare(`SELECT * FROM notifications WHERE status = 'AWAITING_ACK' AND ack_deadline < ?`).all(Date.now()) as Notification[];
}
