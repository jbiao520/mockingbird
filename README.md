# Mockingbird MVP 0.1

面向 Java 后端开发的本地桌面工作台：导入项目 → 选择 API → 手动或 AI 发现并确认依赖 → 生成并审核 Mock → 启动 WireMock → 覆盖下游路由 → 调用验证 → 保存与恢复环境。

支持 **Codex CLI、OpenCode CLI 和 Grok CLI**。Grok 支持检测、模型发现、结构化依赖 / Mock 候选、审核、任务日志与取消。认证由各自 CLI 管理。

## 启动

当前机器已生成 macOS Apple Silicon 应用：`dist/mac-arm64/Mockingbird.app`。双击即可打开；应用包含 WireMock 和支付示例。示例首次打开会复制到应用数据目录，供运行和保存工作区使用。

从源码运行需要 Node.js 22+、JDK 17/21，以及目标项目所用的 Maven / Gradle（也支持项目 Wrapper）：

```sh
npm ci
npm run setup:runtime
npm run desktop
```

`setup:runtime` 从 Maven Central 下载 WireMock 3.13.2，并验证 SHA-512。首次运行 Java 示例可能下载 Maven 依赖。Codex 使用本机已安装、已登录的 CLI，不在 Mockingbird 中保存认证密钥；AI 面板选择 Codex / OpenCode / Grok 后自动识别模型，可从下拉框选择并刷新；保留 CLI 默认模型选项。模型目录不代表账户一定有调用权限，实际调用结果由 CLI 展示。

开发模式：`npm run dev`，打开 `http://127.0.0.1:5173`。生产浏览器模式：`npm run build && npm start`，打开 `http://127.0.0.1:4317`。浏览器模式输入项目绝对路径；桌面模式提供原生目录选择器。

## 五分钟走通支付示例

1. Welcome 点击 **体验支付示例**，左侧可见 Maven 文件树和两个 Spring MVC 入口。
2. 点击左侧 `/api/payment/create`，打开空 Flow。点击 **AI 发现依赖**，按需修改指令，再发送给 **Codex**；也可以通过 **手动添加依赖** 填写 Client、请求方法、路径、配置键和源码位置。源码查看器支持从当前光标位置添加依赖。
3. AI 返回四个下游候选。逐个点击 **编辑并确认**，核对地址、配置键和源码依据后保存，Flow 才会展示 Feign User、RestTemplate Inventory、WebClient Risk、OkHttp Bank 四个下游。点击节点查看源码行号与证据；点击源码链接打开只读代码。按 ⌘ / Shift 可多选依赖。
4. 点击 Flow、依赖详情、Explorer 或 Mock 编辑器里的 **生成 Mock**。默认打开「基于源码的 AI」：选择当前标签页的 Flow、依赖范围、已安装的 CLI 和模型、成功 / 业务拒绝 / 自定义场景，以及可选说明。Grok 默认 `grok-4.7`、medium。任务可取消；CLI 缺失或失败会直接显示错误，不会偷偷改用本地模板。完成后在 Mock 编辑器查看每条规则的依据、可点击的源码证据、假设和未验证结构，再 **保存并应用**。同一弹窗里的 **快速本地模板** 仍立即按 DTO / 项目样本生成，不阅读业务分支。自由对话里的旧发现 / 模板请求保持原样。
5. 底部 **Mock Server** 使用默认端口 `9090`，点击 **启动 Server**。
6. 打开 **Routes**，点击 **全部切为 Mock**。查看四项 URL 覆盖的前后差异，点击 **批准并应用**。原始 Java 和 application 配置保持不变。
7. 在 **Snapshots** 保存「Payment success baseline」，然后回到 Routes 点击 **运行项目**，等待 Java application 状态为 running，默认端口 `18080`。
8. 点击 **验证入口 API**。HTTP Client 已准备请求，点击 **Send**，应返回 HTTP 200、`status: COMPLETED`。底部 Requests 展示四条匹配日志，点击记录可查看请求 / 响应。
9. 打开 Bank API 规则，将响应中的 `approved` 改为 `false`，保留 `transactionId`、`message`。查看 Diff 并保存，再次 Send，业务返回 `DECLINED`；规则热更新无需重启 Java。
10. 在 Snapshots 恢复基线，再发送得到 `COMPLETED`。若路由配置也发生变化，应先停止并重新运行 Java 项目，让 Spring 重新读取覆盖配置。

默认请求：

```json
{"userId":"u_001","sku":"sku_001","quantity":1,"amount":128}
```

同一个 API 可保存 Success / Error 等多个场景。匹配范围有重叠的场景不能同时启用；可关闭旧场景，或使用互斥的 query / header / JSON body 条件。

## 已实现

- IDE 三栏、多 Tab、可折叠和拖动面板、搜索、API 点击打开 Flow、只读 Monaco 源码与 JSON 编辑器。
- Maven / Gradle 基础索引、Spring MVC 入口、手动添加 / 编辑 / 移除依赖、自定义 HTTP 封装、AI 发现候选及逐项确认、源码证据、Flow 保存重开、源码变化提醒。
- Codex 连续对话、结构化候选、任务状态 / 日志 / 取消、候选审核；OpenCode / Grok CLI Adapter。本地助手支持打开 Flow 与模板生成。依赖发现由用户指挥 AI，或手动填写。
- 源码感知的 Mock 生成：显式选择 Flow、依赖、场景、CLI 与模型；候选绑定源码 revision 和依赖定义。审核、保存和批准都会拒绝过期候选。生成使用单独的结构化结果，不改变依赖发现的旧 schema。
- Mock method / path / status / headers / delay / query / request headers / JSON body 匹配；已知 record / 普通类字段、嵌套对象、列表、枚举和 Jackson 别名会在候选完成前校验。Map、JsonNode 和未能解析的类型标成未验证，不假装完成了 Java 类型推断。
- 真实 WireMock 启停、规则热更新、未匹配请求和日志、内置本地 HTTP Client。
- Mock 编辑器支持导出 WireMock 批量 Mapping JSON 和 Postman Collection v2.1（含响应 Examples），可选包含未启用场景；桌面原生保存，浏览器下载。
- Codex 通过 app-server model/list、OpenCode 通过 models --pure、Grok 通过 models 自动发现模型；AI 面板可选模型、刷新列表，按助手分别保留选择。
- Spring URL 配置项按依赖 Real / Mock 切换，批量覆盖预览，Maven / Gradle 项目启停与启动输出。
- 原子保存、每次规则更新前自动 ChangeSet、手动快照、Mock / 路由 / WireMock 端口恢复、持久化对话和最近项目。

快捷键：⌘ / Ctrl + O 打开项目；B 折叠左栏；Shift + B 折叠 AI 栏；J 切换工具面板；S 保存有效的 Mock 草稿。

## Mock 导出

在 Mock Rules 编辑器右上角点击 **导出**，选择 **WireMock** 或 **Postman Collection v2.1**。导出包含当前编辑器草稿，不会自动保存或发布；默认仅包含启用规则。勾选包含未启用场景后，WireMock 会检查这些场景是否可以同时启用，因为其 Mapping 没有规则启用标记。

WireMock 文件是标准 `{ "mappings": [...] }` 批量导入 JSON，通过目标服务的 `POST /__admin/mappings/import` 加载。此文件不是单条 Mapping，不能直接放进 `mappings/` 目录。

Postman 文件通过 Import 导入，包含各场景的请求、响应 Examples、Query、Header 和 JSON Body。Collection 的 `baseUrl` 默认是本地 Mock 地址，路径变量使用 `sample` 示例值。需要 Postman Mock Server 时，另行创建并配置 Header / Body 匹配；原始延迟仅保留在说明中。

## 数据与边界

项目目录中的 `.mockingbird/workspace.json` 保存可读的规则、Flow、对话、快照和对应的源码 revision；`.mockingbird/routes.properties` 保存生成的 Spring 覆盖配置。删除或移动工作区前可备份这两个文件。重开项目恢复配置，不自动启动进程。退出应用停止其管理的 Java / WireMock / Agent 子进程。

Flow 保存**用户确认的 HTTP 依赖及用户指定 / AI 推断的调用关系**，不再通过常见 Client 的静态特征自动发现依赖。导入阶段的 Java 索引用于入口和源码定位。AI 可搜索全部已索引的 Java 源码快照，检查自定义封装、接口实现与配置；候选必须由用户确认，动态路径需先填写，HTTP 日志才是实际请求证据。重新打开 Flow 保留已确认依赖；源码更新后需重新索引、核对依赖并确认版本。当前自动覆盖以基础 `application.properties/yml` 中可识别的 URL 配置项为主；profile、环境变量、多模块复杂构建和 Gradle 实际启动需要针对目标项目进一步验证。硬编码或未解析 URL 不允许自动接管。

响应校验能识别当前索引里的 record、普通类私有字段、一层泛型集合、枚举常量，以及 `@JsonProperty` / `@JsonNaming` / `@JsonIgnore`。它不是 Java 编译器：继承、构造器注入、复杂泛型和运行时多态不会完整解析。Map、JsonNode、Object 和找不到声明的类型会写进「未验证结构」，校验不会把它们当成已经证明的契约。已有 `mockingbird-contracts.json` 只是成功样本证据；业务拒绝等场景可以偏离它，但 2xx 响应仍要满足能解析到的 DTO 形状。校验失败的候选不会进入可审核 proposal。

源码生成只静态阅读脱敏快照，不会运行测试或调用下游。说明里的「未经运行或调用验证」表示业务分支没有被执行证明。证据行必须落在当前索引的非空源码行上。源码 revision 变化，或所选依赖的方法、路径、响应类型、确认状态变化后，审核、保存和批准都会拒绝这份候选。生成任务绑定打开它的 Flow，不会因为另一个标签页正在活动而改写那个 Flow。

Codex / OpenCode / Grok 通过各自模型服务工作。AI 可按需读取隔离目录中的完整脱敏 Java 源码快照和基础配置。Codex 使用只读沙箱执行搜索 / 读取；OpenCode 仅允许 read / glob / grep；Grok 使用 read-only 沙箱和 read_file / grep / list_dir，只读工具白名单，禁用 Web、MCP 调用及子代理。Grok 默认 grok-4.7、medium，可在模型下拉框选择其他模型。依赖候选确认后加入 Flow，Mock 仍需审核保存才发布。日志对常见 token / password 等做脱敏。内置请求工具仅访问应用管理的本机服务。Terminal 首版提供受控诊断命令，不是完整 shell。

当前已验证 macOS arm64 本地构建；Windows / Linux 配置保留，尚未验证发行包。当前 macOS 包用于本机试用，尚未做 Developer ID 公证。快照只恢复工作台管理的 Mock 和配置。

## 验证与构建

```sh
npm test           # 核心、依赖发现、源码生成、导出与模型发现测试
npm run test:e2e   # 真实 WireMock + Spring Boot 端到端流程
npm run test:agent # 已登录 Codex 的分析、生成、审核和取消
npm run test:grok  # 已登录 Grok 的分析、生成、审核和取消
npx tsx scripts/verify-source-generation.ts  # 可选：去掉 contract 后用真实 Grok 4.7 生成一条成功候选，不发布
npm run package    # 当前平台的本地目录应用包
```

测试在临时副本中执行并清理所属进程，不修改示例源码。Codex 验证会使用当前账户的模型额度。验收证据见 [docs/acceptance.md](docs/acceptance.md)、[artifacts/e2e-report.json](artifacts/e2e-report.json) 和 [artifacts/agent-report.json](artifacts/agent-report.json)。

主要代码：`src/` 桌面界面；`server/analyzer.ts` 源码索引和入口工作流；`server/analysis*.ts` 异步 Worker；`server/agents.ts` CLI Adapter；`server/dependencies.ts` 依赖校验与确认；`server/rules.ts` 校验与生成；`server/runtime.ts` WireMock；`server/routes.ts` 路由与 Java 启动；`electron/main.ts` 桌面壳；`examples/payment-service/` 验收项目。
