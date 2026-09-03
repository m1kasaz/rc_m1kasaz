import { serve } from "@hono/node-server";
import { createApp } from "./api";
import { openDb } from "./db";
import { startWorker } from "./worker";

const port = Number(process.env.PORT ?? 3100);
const db = openDb(process.argv[2]); // 可选传入 db 文件路径
startWorker(db);
serve({ fetch: createApp(db).fetch, port });
console.log(`NotifyHub listening on :${port}`);
