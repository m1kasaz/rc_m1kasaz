import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/api";
import { openDb } from "../src/db";
import { startWorker } from "../src/worker";

const HUB = "http://127.0.0.1:4100";
const MOCK = "http://127.0.0.1:4101";
let passed = 0;

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  passed++;
  console.log(`  ok - ${msg}`);
}

// ---- mock 供应商 ----
const mock = new Hono();
mock.post("/ok", (c) => c.text("ok"));
mock.post("/bad", (c) => c.text("bad", 400));
mock.post("/fail", (c) => c.text("fail", 503));
mock.post("/cb", (c) => c.text("ok"));
serve({ fetch: mock.fetch, port: 4101 });

// ---- 被测服务（临时 db）----
const db = openDb(join(mkdtempSync(join(tmpdir(), "notifyhub-")), "test.db"));
startWorker(db);
serve({ fetch: createApp(db).fetch, port: 4100 });

// ---- 辅助 ----
async function submit(input: object): Promise<Response> {
  return fetch(`${HUB}/v1/notifications`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

async function statusOf(id: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(`${HUB}/v1/notifications/${id}`);
  return res.status === 200 ? (await res.json()) as Record<string, unknown> : null;
}

async function waitFor(id: string, pred: (s: Record<string, unknown>) => boolean, timeoutMs = 15_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = await statusOf(id);
    if (s && pred(s)) return s;
    if (Date.now() > deadline) throw new Error(`TIMEOUT notify_id=${id} last=${JSON.stringify(s)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function ack(id: string, payload: object): Promise<Response> {
  return fetch(`${HUB}/v1/notifications/${id}/ack`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

// ---- 场景 ----
async function main(): Promise<void> {
  console.log("S1: http_2xx 模式 2xx → ACKED");
  const r1 = await submit({ idempotency_key: "s1", target_url: `${MOCK}/ok`, body: { a: 1 } });
  assert(r1.status === 202, "submit returns 202");
  const j1 = await r1.json() as { notify_id: string; status: string; duplicated: boolean };
  assert(j1.status === "PENDING" && !j1.duplicated, "accepted as PENDING");
  assert((await waitFor(j1.notify_id, (s) => s.status === "ACKED")).status === "ACKED", "2xx → ACKED");

  console.log("S2: callback 模式 2xx → AWAITING_ACK → ack success → ACKED");
  const r2 = await submit({ idempotency_key: "s2", target_url: `${MOCK}/cb`, ack_mode: "callback" });
  const j2 = await r2.json() as { notify_id: string };
  const s2 = await waitFor(j2.notify_id, (s) => s.status === "AWAITING_ACK" && !!s.ack_deadline);
  assert(s2.attempts === 0, "delivered on first attempt (attempts 只计失败)");
  assert((await ack(j2.notify_id, { result: "success" })).status === 200, "ack accepted");
  assert((await statusOf(j2.notify_id))!.status === "ACKED", "ACKED after ack");

  console.log("S3: ack failed → ACK_FAILED，重复 ack → 409");
  const j3 = (await (await submit({ idempotency_key: "s3", target_url: `${MOCK}/cb`, ack_mode: "callback" })).json()) as { notify_id: string };
  await waitFor(j3.notify_id, (s) => s.status === "AWAITING_ACK");
  assert((await ack(j3.notify_id, { result: "failed", reason: "business rejected" })).status === 200, "negative ack accepted");
  assert((await statusOf(j3.notify_id))!.status === "ACK_FAILED", "ACK_FAILED recorded");
  assert((await ack(j3.notify_id, { result: "success" })).status === 409, "re-ack rejected with 409");

  console.log("S4: 503 → RETRYING（退避重试）");
  const j4 = (await (await submit({ idempotency_key: "s4", target_url: `${MOCK}/fail` })).json()) as { notify_id: string };
  const s4 = await waitFor(j4.notify_id, (s) => s.status === "RETRYING" && (s.attempts as number) >= 1);
  assert(s4.attempts === 1 && String(s4.last_error).includes("503"), "retrying with error recorded");
  assert(typeof s4.next_retry_at === "string", "next_retry_at scheduled");

  console.log("S5: 400 → 直接 DEAD（不重试）");
  const j5 = (await (await submit({ idempotency_key: "s5", target_url: `${MOCK}/bad` })).json()) as { notify_id: string };
  const s5 = await waitFor(j5.notify_id, (s) => s.status === "DEAD");
  assert(s5.attempts === 1, "4xx not retried");

  console.log("S6: 幂等受理");
  const in6 = { idempotency_key: "s6", target_url: `${MOCK}/ok`, body: { x: 1 } };
  const j6 = (await (await submit(in6)).json()) as { notify_id: string };
  const dup = await submit(in6);
  const j6d = await dup.json() as { notify_id: string; duplicated: boolean };
  assert(dup.status === 202 && j6d.duplicated && j6d.notify_id === j6.notify_id, "same key+body → duplicated");
  assert((await submit({ ...in6, body: { x: 2 } })).status === 409, "same key different body → 409");

  console.log("S7: 参数校验与错误路径");
  assert((await submit({ target_url: `${MOCK}/ok` })).status === 422, "missing idempotency_key → 422");
  assert((await submit({ idempotency_key: "s7b", target_url: "http://api.vendor.com/x" })).status === 422, "non-https remote → 422");
  assert((await fetch(`${HUB}/v1/notifications/nope`)).status === 404, "unknown id → 404");
  assert((await ack(j5.notify_id, { result: "success" })).status === 409, "ack on DEAD task → 409");

  console.log(`\n${passed} assertions passed`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
