import { DatabaseSync } from "node:sqlite";

export type DB = DatabaseSync;

export function openDb(path = process.env.NOTIFYHUB_DB ?? "notifyhub.db"): DB {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      target_url TEXT NOT NULL,
      method TEXT NOT NULL DEFAULT 'POST',
      headers TEXT NOT NULL DEFAULT '{}',
      body TEXT,
      ack_mode TEXT NOT NULL DEFAULT 'http_2xx',
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 8,
      next_retry_at INTEGER,
      backoff INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      ack_deadline INTEGER,
      ack_result TEXT,
      created_at INTEGER NOT NULL,
      completed_at INTEGER,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_due ON notifications(status, next_retry_at)
      WHERE status IN ('PENDING','RETRYING');
    CREATE INDEX IF NOT EXISTS idx_ack_due ON notifications(status, ack_deadline)
      WHERE status = 'AWAITING_ACK';
  `);
  return db;
}
