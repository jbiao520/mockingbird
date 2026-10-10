# MVP 验收记录

本轮范围依据 `prd.md` 与参考界面 `img.png`。用户补充约定：先以 Codex 完成首版，OpenCode 预留。验收日期：2026-10-10。

| 范围 | 结果与证据 |
|---|---|
| 项目导入 | 支付示例 Maven / Java 17、两个 Controller 入口、文件树、最近项目；Gradle / YAML 的基础索引用独立 fixture 验证 |
| 异步分析 | 索引和 Flow 分析在 Worker 中执行，桌面 ASAR 中实际导入成功；源码变更监测与旧 Flow 阻止生成测试通过 |
| HTTP 依赖 | Feign、RestTemplate、WebClient、OkHttp 均识别；行号匹配真实调用源码；动态 URL 明确 unresolved |
| Flow UI | 节点、Real / Mock、选中详情、证据和源码跳转、缩放与保存重开 |
| Codex | 实际 CLI 输出四类依赖；生成四条候选、审核前规则数为 0、显式审批后规则数为 4；取消任务成功 |
| OpenCode | 检测、Adapter、模型入口与错误路径已实现；默认模型不可用，按用户约定保留集成，不宣称成功路径通过 |
| Mock 编辑 | Form / JSON / Diff、场景、启用、状态、响应延迟、headers / query / body 匹配；无效规则拒绝且旧 Runtime 不变 |
| WireMock | 使用真实 3.13.2 JAR；localhost 监听、启动 / 停止、规则热更新、实际请求日志 |
| 路由 | 四项 Spring 属性覆盖、逐项 Real / Mock、共享配置一致性检查、差异审批；含空格路径的打包示例实际启动成功 |
| 业务请求 | Spring Boot 实际 `POST /api/payment/create` 返回 `COMPLETED`，四个下游全部命中；银行规则改变后返回 `DECLINED` |
| 用户管理 | 手动将银行 Mock 改回成功响应后返回 `COMPLETED`；User 单独切回 Real 时连接不可用返回 502，重新应用 Mock 路由并重启后再次成功 |
| 保存 | 工作区、规则、路由、Flow重开恢复；原始 Java / application 配置 hash 不变 |
| 桌面交付 | macOS arm64 本地应用包；实际桌面启动、项目导入、Java / WireMock 启动和 Codex 对话验证 |

可重复的核心验收由 `scripts/e2e.ts` 完成，结果写入 `artifacts/e2e-report.json`。真实 Agent 的独立验收由 `scripts/verify-agents.ts` 完成，结果写入 `artifacts/agent-report.json`。UI 在同一打包应用的本地页面中检查，并保存桌面截图。

最终验证：8 项核心测试、13 步真实端到端验收、TypeScript 检查与应用打包均通过。界面实际完成银行响应编辑、Diff 审核、保存发布、`DECLINED` 响应验证、历史版本的环境恢复操作以及重新请求获得 `COMPLETED`。请求日志可见四类下游。退出旧应用后，其 Java / WireMock 子进程均已结束；重开后持久化规则、Flow、对话可用。

预览：[桌面 Mock Editor](../artifacts/mvp-desktop.jpg)、[Flow 与请求记录](../artifacts/mvp-flow.jpg)。

首版限制以根目录 README 为准：静态可能调用关系、基础契约校验、可识别 URL 配置覆盖；尚无完整 Java 类型系统、任意封装路由、完整 OpenAPI 契约或跨平台发行验收。操作效率等产品指标需要真实团队试用测量，当前不宣称已达标。


## 依赖发现流程更新（2026-10-10）

API 点击现在只打开入口工作流，依赖来自手动填写或用户指挥 AI 阅读完整的脱敏源码快照。AI 返回可编辑候选，用户逐项确认后才加入 Flow。自定义 Client 名称可直接填写，源码行号可从查看器光标带入；已确认依赖可以编辑、移除并持久化。源码版本变化会保留依赖并要求重新核对，过期 AI 候选禁止确认。

更新后的 11 项测试与 TypeScript / Web 构建通过。真实 WireMock + Spring Boot 的 13 步验收改为手动声明四个依赖后执行，依然通过；真实 Codex CLI 读取源码快照并返回四个依赖候选，确认前依赖数为 0，逐项确认后为 4。旧截图与原始桌面验收属于此前版本。

实际 UI 验证包含：API 打开空 Flow、手动添加自定义 Client、AI 返回候选时依赖数量不变、编辑确认后加入 Flow、重开保留依赖、确认表单显示真实源码片段。预览：[依赖发现界面](../artifacts/dependency-discovery.jpg)。

## 当前 Mock 管理方式

环境保存与恢复功能已移除，当前验收使用用户编辑并保存 Mock、显式切换 Real / Mock 路由。上文的历史桌面验收记录不代表当前提供环境恢复能力。
