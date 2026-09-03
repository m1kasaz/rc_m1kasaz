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

统一受理外部 API 通知请求，先持久化后返回回执，由 Worker 以 **at-least-once** 语义异步投递，失败按分类退避重试、耗尽进死信。MVP：TypeScript + Hono + SQLite，单进程。
