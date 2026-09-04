import { serve } from "@hono/node-server";
import { Hono } from "hono";

// 三主机测试的 downstream 供应商模拟器。
// 收到通知后读取 X-Notify-Id 关联头，业务"处理"完成后回调 worker 的 ack 接口（D1 回执通道）。
const WORKER_URL = process.env.WORKER_URL ?? "http://127.0.0.1:3100";
const PORT = Number(process.env.PORT ?? 4101);
const ACK_RESULT = process.env.ACK_RESULT ?? "success"; // success | failed | none

const app = new Hono();

app.post("/notify", async (c) => {
  const notifyId = c.req.header("x-notify-id");
  await c.req.text(); // 读完请求体再响应
  if (notifyId && ACK_RESULT !== "none") {
    const body = ACK_RESULT === "failed" ? { result: "failed", reason: "business rejected" } : { result: "success" };
    void fetch(`${WORKER_URL}/v1/notifications/${notifyId}/ack`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }
  return c.text("ok");
});

app.post("/fail", (c) => c.text("fail", 503));
app.post("/bad", (c) => c.text("bad", 400));

serve({ fetch: app.fetch, port: PORT });
console.log(`mock vendor listening on :${PORT}, ack → ${WORKER_URL} (${ACK_RESULT})`);
