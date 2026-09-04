import { Hono } from "hono";
import type { DB } from "./db";
import {
  applyAck,
  getById,
  getByKey,
  insertNotification,
  sameRequest,
  type SubmitInput,
} from "./store";

const METHODS = ["POST", "PUT", "PATCH"];

function validate(n: Record<string, unknown>): string | null {
  if (
    typeof n.idempotency_key !== "string" ||
    !n.idempotency_key ||
    n.idempotency_key.length > 128
  )
    return "idempotency_key must be a non-empty string (<=128 chars)";
  if (typeof n.target_url !== "string") return "target_url is required";
  let url: URL;
  try {
    url = new URL(n.target_url);
  } catch {
    return "target_url is invalid";
  }
  // https 强制；localhost 放行以便本地联调；NOTIFYHUB_ALLOW_HTTP=1 为测试环境特批
  const allowHttp = process.env.NOTIFYHUB_ALLOW_HTTP === "1";
  if (
    url.protocol !== "https:" &&
    !allowHttp &&
    !["localhost", "127.0.0.1"].includes(url.hostname)
  )
    return "target_url must be https";
  if (n.method !== undefined && !METHODS.includes(n.method as string))
    return "method must be POST, PUT or PATCH";
  if (
    n.headers !== undefined &&
    (typeof n.headers !== "object" ||
      n.headers === null ||
      Array.isArray(n.headers))
  )
    return "headers must be an object";
  const h = (n.headers ?? {}) as Record<string, unknown>;
  if ("Host" in h || "Content-Length" in h)
    return "headers must not contain Host or Content-Length";
  if (
    n.ack_mode !== undefined &&
    !["http_2xx", "callback"].includes(n.ack_mode as string)
  )
    return "ack_mode must be http_2xx or callback";
  return null;
}

function toInput(body: Record<string, unknown>): SubmitInput {
  return {
    idempotency_key: body.idempotency_key as string,
    target_url: body.target_url as string,
    method: (body.method as string) ?? "POST",
    headers: JSON.stringify(body.headers ?? {}),
    body: body.body === undefined ? null : JSON.stringify(body.body),
    ack_mode: (body.ack_mode as string) ?? "http_2xx",
  };
}

export function createApp(db: DB): Hono {
  const app = new Hono();

  app.post("/v1/notifications", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (typeof body !== "object" || body === null || Array.isArray(body))
      return c.json(
        { error: "VALIDATION_FAILED", message: "body must be a JSON object" },
        422,
      );
    const err = validate(body);
    if (err) return c.json({ error: "VALIDATION_FAILED", message: err }, 422);
    const input = toInput(body);
    const existing = getByKey(db, input.idempotency_key);
    if (existing) {
      if (!sameRequest(existing, input))
        return c.json({ error: "IDEMPOTENCY_CONFLICT" }, 409);
      return c.json(
        { notify_id: existing.id, status: existing.status, duplicated: true },
        202,
      );
    }
    try {
      const row = insertNotification(db, input); // 事务落库后才返回（D4）
      return c.json(
        { notify_id: row.id, status: row.status, duplicated: false },
        202,
      );
    } catch {
      // 唯一索引兜底并发插入：构造期再查一次，按幂等处理
      const first = getByKey(db, input.idempotency_key);
      if (first && sameRequest(first, input))
        return c.json(
          { notify_id: first.id, status: first.status, duplicated: true },
          202,
        );
      throw new Error("insert failed");
    }
  });

  app.get("/v1/notifications/:id", (c) => {
    const n = getById(db, c.req.param("id"));
    if (!n) return c.json({ error: "NOT_FOUND" }, 404);
    const iso = (ms: number | null) =>
      ms === null ? null : new Date(ms).toISOString();
    return c.json({
      notify_id: n.id,
      status: n.status === "IN_FLIGHT" ? "RETRYING" : n.status,
      attempts: n.attempts,
      max_attempts: n.max_attempts,
      next_retry_at: iso(n.next_retry_at),
      ack_deadline: iso(n.ack_deadline),
      last_error: n.last_error,
      created_at: iso(n.created_at),
      completed_at: iso(n.completed_at),
    });
  });

  app.post("/v1/notifications/:id/ack", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { result, reason } = body as { result?: string; reason?: string };
    if (result !== "success" && result !== "failed")
      return c.json(
        {
          error: "VALIDATION_FAILED",
          message: "result must be success or failed",
        },
        422,
      );
    const id = c.req.param("id");
    const row = applyAck(
      db,
      id,
      result,
      typeof reason === "string" ? reason : null,
    );
    if (!row) {
      if (!getById(db, id)) return c.json({ error: "NOT_FOUND" }, 404);
      return c.json({ error: "INVALID_STATE" }, 409);
    }
    if (row.status === "ACK_FAILED")
      console.error(
        `[alert:critical] ack_failed notify_id=${row.id} reason=${row.ack_result}`,
      );
    return c.json({ notify_id: row.id, status: row.status });
  });

  return app;
}
