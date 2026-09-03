# rc_m1kasaz

企业内部 **API 通知系统（NotifyHub）** 设计与实现 —— AI Coding 作业。

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [docs/prd.md](docs/prd.md) | PRD：需求背景、功能目标、系统边界、产出预期 |
| [docs/tech-design.md](docs/tech-design.md) | 技术设计：架构、流程图/时序图、数据模型、接口定义、失败处理与演进路线 |
| [docs/test-cases.md](docs/test-cases.md) | 测试用例评审：26 条用例及评审结论 |
| [docs/ai-usage.md](docs/ai-usage.md) | AI 使用说明 |

## 一句话设计

统一受理外部 API 通知请求，先持久化后返回回执，由 Worker 以 **at-least-once** 语义异步投递，失败按分类退避重试、耗尽进死信。MVP：TypeScript + Hono + SQLite（`node:sqlite`），单进程。

## 快速开始

```bash
npm install
npm run smoke   # 进程内 mock 供应商 + 18 条断言端到端验证
npm start       # 启动服务，默认 :3100（PORT 可覆盖，db 默认 notifyhub.db）
```

## 代码结构

```
src/db.ts      # SQLite 打开 + 建表（WAL、两条部分索引）
src/store.ts   # 全部 SQL 与状态机迁移
src/api.ts     # 受理 / 查询 / ack 三个路由
src/worker.ts  # 投递循环 + ack 超时扫描
src/index.ts   # 启动入口
scripts/smoke.ts  # 端到端验证脚本
```
