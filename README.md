# Mockingbird MVP 0.1

面向 Java 后端开发的本地桌面工作台：导入项目 → 选择 API → 手动或 AI 发现并确认依赖 → 生成并审核 Mock → 启动 WireMock → 覆盖下游路由 → 调用验证 → 保存并自行管理 Mock。

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
7. 在 Routes 点击 **运行项目**，等待 Java application 状态为 running，默认端口 `18080`。
8. 点击 **验证入口 API**。HTTP Client 已准备请求，点击 **Send**，应返回 HTTP 200、`status: COMPLETED`。底部 Requests 展示四条匹配日志，点击记录可查看请求 / 响应。
9. 打开 Bank API 规则，将响应中的 `approved` 改为 `false`，保留 `transactionId`、`message`。查看 Diff 并保存，再次 Send，业务返回 `DECLINED`；规则热更新无需重启 Java。
10. 自行将银行 Mock 的 `approved` 改回 `true` 并保存，再发送得到 `COMPLETED`。若路由配置也发生变化，应先停止并重新运行 Java 项目，让 Spring 重新读取覆盖配置。

默认请求：

```json
{"userId":"u_001","sku":"sku_001","quantity":1,"amount":128}
```

同一个 API 可保存 Success / Error 等多个场景。匹配范围有重叠的场景不能同时启用；可关闭旧场景，或使用互斥的 query / header / JSON body 条件。

Mock 编辑器的 **配置行为** 支持复用一份基础响应：

- **请求与响应**：从请求样例直接编辑 Body / Header / Query 字段，只勾选需要约束的字段；完整 JSON 可折叠编辑。响应字段选择固定值、来自请求（含缺失默认值）、UUID、当前时间或条件分支。同名 UUID 变量在一次响应中复用。
- **特殊情况**：按顺序匹配第一个例外，只填写要改变的响应字段与可选 HTTP 状态；未命中时使用基础响应。高级选项提供连接故障和行为优先级。旧的 Body 匹配可选择完整或部分 JSON。
- **连续调用**：选择先失败再成功、先处理中再完成，调整步骤与字段差异；最后一步可保持、循环或停止匹配，也可重置已发布的步骤。当前用于单实例串行测试，不按用户或订单隔离。
- **验证样例**：共用基础请求，只保存差异；完整 Body 模式可验证缺失字段。支持命中、最终 HTTP 状态、字段值与传输故障断言。在 Requests 详情中可将实际请求保存为样例。
- **预览当前请求 / 验证全部样例**：使用独立临时 WireMock，每个样例从第一步开始，不消耗正在运行的状态。保存动态行为前会渲染样例并检查已知 DTO；失败时保留原配置。验证样例的通过仅代表这些输入，不能证明所有输入。

AI 在用户明确要求动态行为时可返回同一套可编辑配置，仍需审核并保存。WireMock 导出保留动态字段、例外与步骤；Postman 导出基础响应 Examples 并说明执行差异。


下游 Mock 按 URL 配置键隔离。例如 `services.user.url=https://service/v1` 会覆盖为 `http://127.0.0.1:9090/__mockingbird/config-services.user.url/v1`；依赖路径 `/users/{id}` 保持不变，Mapping、测试请求和导出会使用包含服务前缀与 `/v1` 的完整路径。不同配置键下的同名接口可以同时启用；共享配置键的调用仍须一起切换 Real / Mock，重叠场景仍会冲突。已有规则在读取时补齐服务信息，升级后请重新应用 Routes，并重启已运行的 Java 项目以加载新地址。

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
- 原子保存当前 Mock 和路由配置，持久化对话和最近项目。用户自行编辑、导出和备份 Mock。

快捷键：⌘ / Ctrl + O 打开项目；B 折叠左栏；Shift + B 折叠 AI 栏；J 切换工具面板；S 保存有效的 Mock 草稿。

## 多项目与窗口

顶部项目 Tab 栏展示当前窗口打开的项目，点击切换，点击 `＋` 在当前窗口打开新项目。Tab 支持左右方向键、Home / End 切换，数量较多时可横向滚动，悬停显示完整路径；绿点表示项目有运行中的服务或 AI 任务。关闭当前 Tab 后切到相邻项目，最后一个关闭后回到欢迎页；关闭项目会停止该项目的服务和任务。刷新页面会恢复当前窗口的项目 Tab 与选中项目。

项目名下拉切换器包含已打开项目、最近项目、路径搜索，以及各项目的 Java / WireMock / AI 运行状态；其他窗口中的项目可从此处聚焦或操作。切回已打开项目会复用索引和工作区，恢复标签页、当前 Flow、文件树、Mock 草稿、HTTP 请求草稿与未发送的 AI 输入。源码或配置变化仍需重新索引并核对依赖。

- **切换项目**：保留原项目的 Java、WireMock 和 AI 任务，后台结果只写回所属项目。
- **关闭项目**：先保存编辑草稿，再取消分析 / AI / 行为预览，停止该项目的 Java / WireMock 和文件监听。其它项目继续运行。重开恢复配置和草稿，不自动启动服务或 AI。
- **桌面多窗口**：打开项目弹窗可勾选“在新窗口打开”；项目切换器中的箭头可把项目移到独立窗口。原窗口保留其它项目。同一真实目录只保留一个项目实例；再次打开会切到或聚焦已有窗口。文件菜单也提供“新建窗口”。关闭桌面窗口会关闭归属该窗口的全部项目，退出应用关闭所有管理的进程。
- **浏览器模式**：支持单页面切换多个项目。同一项目被其它标签页占用时会提示返回原标签页；标签页异常退出后约两分钟可重新接管。结束服务请使用“关闭项目”，浏览器标签页关闭不自动停止后台项目。

每个项目的 WireMock 工作目录和服务端口独立。未应用 Mock 路由时会选择可用端口；已经写入路由的 Mock 端口保持不变，冲突会明确报错。修改这类端口须先恢复 Real 路由，再选择新端口、重新应用 Mock 路由并重启 Java。

项目中的 `.mockingbird/workspace.json` 与 `routes.properties` 继续保存已应用配置。应用数据目录的 `projects/<projectId>/view.json` 单独保存未发布的编辑状态，包括尚未完成的 JSON；`ports.json` 保存运行端口。草稿自动保存在本机，只有“保存并应用”才修改已发布规则；源码版本过期的草稿不能直接发布。`recent.json`、`settings.json` 与 CLI / 模型目录由应用统一管理，各项目共享模型选择。

内部 HTTP API 使用 `/api/projects/:projectId/...` 指定项目；`/api/state` 返回应用的项目列表。旧的无项目 ID 的规则、运行和任务接口已移除，窗口通过 `X-Mockingbird-Client` 标识归属。

界面和原生窗口回归：首次运行先执行 `npx playwright install chromium`，随后执行 `npm run test:ui`。测试使用临时项目和独立应用数据目录，不修改本机项目，也不调用真实 AI 模型。

## Mock 导出

在 Mock Rules 编辑器右上角点击 **导出**，选择 **WireMock** 或 **Postman Collection v2.1**。导出包含当前编辑器草稿，不会自动保存或发布；默认仅包含启用规则。勾选包含未启用场景后，WireMock 会检查这些场景是否可以同时启用，因为其 Mapping 没有规则启用标记。

WireMock 文件是标准 `{ "mappings": [...] }` 批量导入 JSON，通过目标服务的 `POST /__admin/mappings/import` 加载。此文件不是单条 Mapping，不能直接放进 `mappings/` 目录。

Postman 文件通过 Import 导入，包含各场景的请求、响应 Examples、Query、Header 和 JSON Body。Collection 的 `baseUrl` 默认是本地 Mock 地址，路径变量使用 `sample` 示例值。需要 Postman Mock Server 时，另行创建并配置 Header / Body 匹配；原始延迟仅保留在说明中。

## 入口 API 请求验证

入口请求会按 Controller 所在模块读取基础配置中的 `server.servlet.context-path`，自动添加应用路径前缀；生成与发送校验使用同一完整路径。多模块项目的 URL 配置也按 Flow 入口所在的应用模块解析，即使 HTTP Client 位于共享模块，也不会借用其它应用模块的同名配置。`src/test` 下的配置不参与运行配置解析。同一模块内的基础配置文件对同一键给出不同值时会报冲突，需先核对配置。旧工作区中的错误地址不能直接重新确认或应用 Mock 路由，应重新索引并编辑确认依赖。

路由页的 **验证入口 API** 根据当前源码生成请求方法、路径、Query、Headers 和 JSON Body，每次打开都重置上一份请求。`long / Long` 生成 JSON 整数，字符串、布尔值、集合、嵌套 DTO 和枚举按可解析类型生成；DTO 的 `@JsonProperty`、`@JsonNaming` 和 `@JsonIgnore` 参与字段映射。示例值用于结构验证，业务 ID 和金额仍需按实际场景填写。

发送入口请求前，服务端检查已解析字段的类型、整数范围、枚举值，以及路径 / Query / Header 参数；类型错误会显示字段路径并阻止请求。源码变更后需重新索引并再次生成请求。空 Body 表示不发送 Body，未声明请求体的 API 不再携带默认支付示例。

该功能使用静态源码解析，不等同于 Spring / Jackson 的运行时契约。Map、JsonNode、同名 DTO、复杂泛型、继承、自定义 Jackson 转换及循环引用会提示人工确认。未知部分不作类型保证；DTO 字段必填、Bean Validation 约束和业务规则由 Java 服务验证。整数使用 JavaScript 安全整数范围，超出范围会拒绝发送，避免精度丢失。

## 数据与边界

项目目录中的 `.mockingbird/workspace.json` 保存可读的规则、Flow、对话和对应的源码 revision；`.mockingbird/routes.properties` 保存生成的 Spring 覆盖配置。删除或移动工作区前可备份这两个文件。重开项目恢复配置，不自动启动进程。退出应用停止其管理的 Java / WireMock / Agent 子进程。

Flow 保存**用户确认的 HTTP 依赖及用户指定 / AI 推断的调用关系**，不再通过常见 Client 的静态特征自动发现依赖。导入阶段的 Java 索引用于入口和源码定位。AI 可搜索全部已索引的 Java 源码快照，检查自定义封装、接口实现与配置；候选必须由用户确认，动态路径需先填写，HTTP 日志才是实际请求证据。重新打开 Flow 保留已确认依赖；源码更新后需重新索引、核对依赖并确认版本。当前自动覆盖以基础 `application.properties/yml` 中可识别的 URL 配置项为主；profile、环境变量、多模块复杂构建和 Gradle 实际启动需要针对目标项目进一步验证。硬编码或未解析 URL 不允许自动接管。

响应校验能识别当前索引里的 record、普通类私有字段、一层泛型集合、枚举常量，以及 `@JsonProperty` / `@JsonNaming` / `@JsonIgnore`。它不是 Java 编译器：继承、构造器注入、复杂泛型和运行时多态不会完整解析。Map、JsonNode、Object 和找不到声明的类型会写进「未验证结构」，校验不会把它们当成已经证明的契约。已有 `mockingbird-contracts.json` 只是成功样本证据；业务拒绝等场景可以偏离它，但 2xx 响应仍要满足能解析到的 DTO 形状。校验失败的候选不会进入可审核 proposal。

源码生成只静态阅读脱敏快照，不会运行测试或调用下游。说明里的「未经运行或调用验证」表示业务分支没有被执行证明。证据行必须落在当前索引的非空源码行上。源码 revision 变化，或所选依赖的方法、路径、响应类型、确认状态变化后，审核、保存和批准都会拒绝这份候选。生成任务绑定打开它的 Flow，不会因为另一个标签页正在活动而改写那个 Flow。

Codex / OpenCode / Grok 通过各自模型服务工作。AI 可按需读取隔离目录中的完整脱敏 Java 源码快照和基础配置。Codex 使用只读沙箱执行搜索 / 读取；OpenCode 仅允许 read / glob / grep；Grok 使用 read-only 沙箱和 read_file / grep / list_dir，只读工具白名单，禁用 Web、MCP 调用及子代理。Grok 默认 grok-4.7、medium，可在模型下拉框选择其他模型。依赖候选确认后加入 Flow，Mock 仍需审核保存才发布。日志对常见 token / password 等做脱敏。内置请求工具仅访问应用管理的本机服务。Terminal 首版提供受控诊断命令，不是完整 shell。

当前已验证 macOS arm64 本地构建；Windows / Linux 配置保留，尚未验证发行包。当前 macOS 包用于本机试用，尚未做 Developer ID 公证。

## 验证与构建

```sh
npm test           # 核心、依赖发现、源码生成、导出、模型发现与多项目隔离测试
npm run test:e2e   # 真实 WireMock + Spring Boot 端到端流程
npm run test:ui    # 浏览器项目切换 / 草稿恢复与 Electron 多窗口回归
npm run test:runtime # JDK 分块 POST 与 HTTP/2 降级兼容性（需要 JDK 和 WireMock）
npm run test:agent # 已登录 Codex 的分析、生成、审核和取消
npm run test:grok  # 已登录 Grok 的分析、生成、审核和取消
npx tsx scripts/verify-source-generation.ts  # 可选：去掉 contract 后用真实 Grok 4.7 生成一条成功候选，不发布
npm run package    # 当前平台的本地目录应用包
```

测试在临时副本中执行并清理所属进程，不修改示例源码。Codex 验证会使用当前账户的模型额度。验收证据见 [docs/acceptance.md](docs/acceptance.md)、[artifacts/e2e-report.json](artifacts/e2e-report.json) 和 [artifacts/agent-report.json](artifacts/agent-report.json)。

主要代码：`src/App.tsx` 应用与窗口会话、`src/ProjectWorkbench.tsx` 单项目界面、`src/project-session.tsx` 草稿与请求归属；`server/projects.ts` 项目管理与共享设置；`server/analyzer.ts` 源码索引和入口工作流；`server/analysis*.ts` 异步 Worker；`server/agents.ts` CLI Adapter；`server/dependencies.ts` 依赖校验与确认；`server/rules.ts` 校验与生成；`server/runtime.ts` WireMock；`server/routes.ts` 路由与 Java 启动；`electron/main.ts` 桌面壳；`examples/payment-service/` 验收项目。


每条 Mock Rule 的 **AI 修改** 可用文字配置请求匹配、动态字段、条件例外、连续调用、延迟和故障。选择已安装的 Codex / OpenCode / Grok CLI，输入需求后，Agent 会基于所选规则的当前草稿提出建议。点击 **Review 行为修改** 查看完整配置 Diff，可继续编辑或 Discard；点击 **批准并应用** 后才会验证并发布到本地 Mock 服务。建议绑定具体 Rule 和源码版本，规则、依赖或当前草稿发生变化时需重新请求，避免覆盖后续修改。
