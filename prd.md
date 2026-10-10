# Mockingbird — MVP 产品需求文档（PRD）

**版本：** v1.0  
**阶段：** MVP  
**产品形态：** 桌面端 AI-Native IDE  
**目标用户：** Java 后端开发工程师  
**支持 AI Agent：** Codex CLI、OpenCode CLI

---

## 1. 产品概述

### 1.1 产品定位

Mockingbird 是一款 AI 原生的 Java 开发与 Mock 管理 IDE。

用户通过导入已有 Java 项目，以自然语言与 AI Agent 交互，自动完成指定业务 API 的调用链分析、外部 HTTP 依赖识别、Mock 生成、Mock Server 启动及测试环境配置。

产品目标不是替代 IntelliJ IDEA 的完整开发能力，而是提供专门面向 **API Workflow 理解与 Mock 自动化** 的高效率工作台。

### 1.2 目标用户

主要面向以下开发者：

- 使用 Spring Boot、Maven 或 Gradle 的 Java 后端工程师。
- 项目依赖大量外部 HTTP API。
- 需要在下游服务不可用时继续开发。
- 需要频繁编写、修改和维护 Mock。
- 已经习惯使用 Codex、OpenCode 等 Coding Agent。

### 1.3 核心价值

**让开发者通过自然语言，在一个统一的 IDE 中完成原本需要多个工具和大量手动操作的 Mock 工作。**

预期核心价值：

1. 降低 API 依赖识别成本。
2. 降低 Mock 编写与维护成本。
3. 降低对外部开发测试环境的依赖。
4. 让业务 Flow 和 Mock 关系可视化。
5. 让 Mock 配置和路由可保存，由用户自行管理。

### 1.4 MVP 成功标准

开发者能够在 Mockingbird 中完成以下完整操作：

1. 导入一个现有 Java 项目。
2. 选择一个对外提供的 HTTP API。
3. 使用 AI 分析该 API 的业务调用链。
4. 查看该 Flow 依赖的外部 HTTP API。
5. 自动生成对应的 Mock 定义。
6. 启动 Mockingbird 内置 HTTP Mock Server。
7. 将目标 Java 项目的指定下游请求路由至本地 Mock。
8. 执行调用验证。
9. 保存 Mock 配置并支持用户管理。

完成以上流程不应要求用户手工编写大量 Mock JSON 或逐一修改 URL。

---

## 2. MVP 功能范围

### 2.1 必须支持的功能

| ID | 功能模块 | 优先级 |
|---|---|---|
| F01 | Java 项目导入与项目浏览器 | P0 |
| F02 | Codex/OpenCode CLI 集成 | P0 |
| F03 | AI 原生对话工作台 | P0 |
| F04 | 指定入口 API 的 Flow 识别 | P0 |
| F05 | HTTP 下游依赖识别 | P0 |
| F06 | Workflow 可视化 | P0 |
| F07 | AI Mock 自动生成 | P0 |
| F08 | Mock 可视化编辑 | P0 |
| F09 | 内置 HTTP Mock Server | P0 |
| F10 | Mock 路由配置与接管 | P0 |
| F11 | Mock 请求调试与日志 | P0 |
| F12 | Mock 配置保存与管理 | P0 |
| F13 | 底部工具面板及任务状态 | P0 |

### 2.2 MVP 技术边界

第一版支持：

- Java 17/21 项目，其他版本视兼容性验证结果而定。
- Spring Boot。
- Maven，Gradle 基础支持。
- Spring MVC Controller API 入口。
- Feign、RestTemplate、WebClient、OkHttp 等 HTTP Client 的常见调用模式。
- HTTP/HTTPS 下游 API。
- JSON 为主的请求和响应。
- 本地 Mock Server。
- 单个 Java 项目内的业务 Flow 分析。
- Codex CLI 和 OpenCode CLI。

不同 HTTP Client 的分析和路由覆盖需要逐项验证，不承诺首版支持任意自定义 HTTP 封装。

### 2.3 明确不属于 MVP 的功能

- 完整 Java 代码编辑器、重构器和 Debugger。
- 跨多个代码仓库的完整分布式调用链。
- Kafka、RabbitMQ 等 MQ Mock。
- 数据库虚拟化。
- 完整的企业级测试环境管理。
- 团队账号与云端协作。
- 云端 Mock Hosting。
- 任意 Java HTTP Client 的通用字节码拦截。
- 真实支付等外部副作用的自动回滚。
- 完整自动化测试平台。

---

## 3. 产品界面设计

### 3.1 整体布局

Mockingbird 采用类似 IntelliJ IDEA / 现代 Coding IDE 的三栏工作区，加底部工具栏。

**左侧：Project & Workflow Explorer**

用于展示项目结构、入口 API、业务 Flow、外部依赖与 Mock 列表。

**中间：Main Workspace**

用于展示代码、Flow Graph、Mock 编辑器、HTTP 调试结果等主要内容，采用多 Tab 形式。

**右侧：AI Agent Panel**

用于自然语言交互、Agent 任务执行、分析结果、生成内容和变更审批。

**底部：Tool Window**

采用可切换、可折叠的工具面板，包含 Terminal、Mock Server、Request Logs、Problems 和 Tasks。

### 3.2 基础布局要求

- 左右面板支持拖动调整宽度。
- 面板支持折叠和展开。
- 中间支持多 Tab。
- 左侧文件和 API 支持搜索。
- Flow 节点支持点击查看详情。
- AI 生成的结果可直接打开到中间工作区。
- 底部面板默认收起或采用较小高度。
- 常用操作提供右键菜单和快捷键。
- 用户可以在一个界面内完成完整 Mock 工作流。

### 3.3 交互原则

**AI First, Visual Control, Human Approval**

AI 是主要的工作执行入口，但用户始终能够查看和控制生成结果。

核心交互包括：

- 用户可以通过自然语言触发功能。
- 也可以通过菜单、右键和图形按钮触发相同功能。
- AI 操作过程中必须显示任务状态。
- 生成结果必须能被查看、编辑和批准。
- 所有影响项目文件或运行路由的变更应当可撤销。
- AI 无法确认的依赖必须明确标记，不允许虚构已验证结果。

---

## 4. 核心功能详细需求

### F01 — Java 项目导入

**用户故事**

作为 Java 开发者，我希望选择本地 Java 项目后，Mockingbird 能自动读取项目结构，使我无需手动配置代码上下文。

**功能要求**

1. 通过 Welcome 页面选择本地项目目录。
2. 识别 Maven/Gradle 构建文件。
3. 解析 Java 模块和源代码目录。
4. 建立初步代码索引。
5. 识别 Spring Controller。
6. 在左侧 Project Explorer 展示项目结构。
7. 支持最近打开的项目。
8. 记录项目索引状态与错误。

**验收标准**

- 用户可以通过图形界面导入项目。
- 成功加载项目文件树。
- 能识别支持范围内的 Controller。
- 导入失败时提供明确原因。
- 不自动修改原始项目文件。

### F02 — AI Agent 集成

**用户故事**

作为用户，我希望选择 Codex 或 OpenCode 作为 AI 引擎，直接在 Mockingbird 内进行对话和执行工程任务。

**功能要求**

- 自动检测本机 Codex CLI / OpenCode CLI 是否已安装。
- 用户选择默认 Agent。
- 检查 CLI 可执行文件、版本及可用状态。
- 复用用户本机已有的认证配置，不在应用中明文保存凭证。
- 支持创建任务、取消任务和查看执行状态。
- 支持同一项目内连续对话。
- 显示 AI 输出、执行进度、错误信息和变更建议。
- 通过独立 Adapter 层兼容不同 CLI。
- 根据各 CLI 的实际输出能力解析结构化事件；必要时使用 Mockingbird 自己定义的结构化结果协议。

CLI 集成的主要职责为：

- 理解用户请求。
- 分析项目代码。
- 执行受控代码检索。
- 输出 API Flow 分析。
- 生成 Mock 候选数据。
- 提出规则修改建议。

**安全要求**

AI 默认使用只读项目分析模式。涉及文件写入、进程启动、联网或命令执行时，按照授权策略进行控制。

**验收标准**

- 可以选择 Codex 或 OpenCode。
- 可以启动和取消任务。
- 能展示任务执行结果及错误。
- 任务失败不会导致 IDE 崩溃。
- 不依赖某一个 Agent 的专有业务逻辑。

### F03 — AI 对话工作台

右侧始终提供 AI Chat Panel。

**主要元素**

1. Agent 选择器。
2. 对话历史。
3. Prompt 输入框。
4. 当前项目 / Workflow 上下文。
5. AI 任务执行状态。
6. 文件、API 和 Mock 的上下文引用。
7. 生成结果操作卡片。
8. 变更审批入口。

**示例对话**

用户：

“帮我分析 `/api/payment/create` 这个接口的完整 Flow，找出所有下游 HTTP API。”

AI：

“已发现 18 个潜在下游 HTTP 调用，其中 12 个具有明确的静态代码依据，6 个需要进一步验证。”

用户：

“帮我为这些 API 生成正常返回的 Mock。”

AI：

“已生成 18 条候选 Mock 规则，其中 4 条缺少完整响应契约，需要确认。”

用户可以直接点击 AI 结果中的 **View Flow、Review Mock、Start Server** 等操作。

**验收标准**

- 交互过程中能够保留当前 Workflow 上下文。
- 生成结果能够在中间工作区打开。
- 任务可取消。
- 用户能够查看成功、失败、待审批状态。

### F04 — 入口 API 识别与 Flow 分析

这是 Mockingbird 的核心功能之一。

**用户故事**

作为开发者，我希望指定一个对外提供的 HTTP API，让 Mockingbird 自动分析该 API 在当前 Java 项目中的潜在业务调用路径。

**功能要求**

1. 自动扫描 Spring MVC Controller。
2. 显示 HTTP Method、Path、Controller 类和方法。
3. 支持按 URL、方法名、类名搜索。
4. 支持右键选择 Analyze Flow。
5. 使用静态分析、代码检索和 Agent 推理建立调用关系。
6. 标识调用过程中的 HTTP Client。
7. 提取潜在下游 API。
8. 展示分支、调用位置和分析依据。
9. 在运行时证据可用时，补充实际观测到的请求。
10. 对动态 URL、反射和无法解析的调用标记待确认状态。

**Flow 分析结果至少包含**

- 当前 API 入口。
- 业务方法调用关系。
- 下游 HTTP API 列表。
- HTTP Method。
- URL 或路径模板。
- 调用代码位置。
- HTTP Client 类型。
- 请求 / 响应 DTO 信息（如能提取）。
- 证据类型及分析状态。

**验收标准**

在预先准备、包含多种受支持 HTTP Client 的标准测试项目中，系统能够识别其预定义的下游 HTTP 调用，并正确标记无法确定的依赖。

不允许把未经验证的推断展示为已经确认的实际调用。

### F05 — Workflow 可视化

**用户故事**

作为开发者，我希望通过图形化方式理解 API Flow，而不是只阅读 AI 生成的文字报告。

**功能要求**

- 以节点图展示入口 API、内部方法及外部 HTTP 调用。
- 外部 HTTP 依赖使用不同形状或标签区分。
- 标记 Real、Mock、Unresolved 状态。
- 点击节点展示 API 详情。
- 支持缩放、平移及自动布局。
- 支持从节点跳转源码。
- 支持从节点生成 Mock。
- 支持查看分析证据。
- 支持保存和重新打开 Flow。

**验收标准**

- Flow 能展示在独立 Tab 中。
- 可交互查看节点。
- 能通过图形界面选中一个或多个依赖。
- 用户可以直接从 Flow 发起 Mock 生成。

### F06 — AI Mock 生成

这是 Mockingbird 的第二项核心功能。

**用户故事**

作为开发者，我希望选中整个 Flow 或部分 HTTP 依赖，让 AI 自动生成 Mock，无需逐个手工编写。

**功能要求**

支持两种生成入口：

**方式一：通过 AI 对话**

“为整个支付 Flow 生成 Mock，所有 API 先返回正常结果。”

**方式二：通过 UI**

选择 Workflow → Generate Mocks → 选择场景 → Generate。

**生成能力**

- 根据 URL、Method、DTO、现有接口契约和测试样本生成请求匹配规则。
- 生成 JSON Response。
- 自动设置 HTTP Status。
- 支持 Success 与常见 Error 场景。
- 支持用户用自然语言修改指定 Mock。
- 支持重新生成单条 Mock。
- 支持批量生成。
- 展示生成依据及待确认字段。
- 保存为可读、可版本管理的规则文件。

**生成后校验**

- JSON 语法检查。
- 可获取契约的 Schema 检查。
- Mock 规则冲突检查。
- 请求匹配有效性检查。
- 标识未验证的业务字段及状态转换。

**验收标准**

- 支持批量生成。
- 用户可以查看生成结果。
- 可以修改其中一条规则，而不影响其他规则。
- 校验失败不会自动发布到运行中的 Mock Server。

### F07 — Mock 可视化编辑器

中间工作区提供 Mock Editor。

**编辑内容**

- HTTP Method 和 Path。
- 请求匹配条件。
- HTTP 状态码。
- Response Header。
- JSON Body。
- Response Delay。
- Mock 启用状态。
- 场景名称。

**交互要求**

- Form 编辑与 JSON 编辑两种模式。
- JSON 语法高亮及校验。
- AI 修改指令入口。
- Save / Discard。
- 修改前后 Diff。
- 同一个 API 可以拥有多个场景。
- 可直接发送测试请求验证 Mock。

### F08 — 内置 Mock Server

**用户故事**

作为开发者，我希望在 Mockingbird 中直接启动本地 HTTP Mock 服务，不需要手动配置额外的 Mock 工具。

**实现建议**

采用 WireMock 作为第一版 HTTP Mock Runtime。

**功能要求**

- 从界面启动 / 停止 Mock Server。
- 配置监听端口。
- 自动加载当前启用的 Mock 规则。
- 支持热更新规则。
- 展示 Server 状态。
- 查看 Request / Response Logs。
- 对未匹配请求显示明确错误。
- 支持使用内置请求工具测试 Mock。

**验收标准**

用户启动 Mock Server 后，能够通过本机 HTTP 客户端请求 Mock URL，获得与当前规则一致的响应。

默认仅监听 localhost，除非用户明确修改设置。

### F09 — HTTP 路由接管

**用户故事**

作为开发者，我希望将当前 Java 项目中的某些 HTTP 依赖切换到 Mock Server，同时保留其他依赖的真实连接。

**功能要求**

- 每个下游依赖支持 Real / Mock 切换。
- 自动识别可以覆盖的 URL 配置。
- 首选通过 Spring Profile、环境变量或启动参数覆盖配置。
- 展示变更前后的目标地址。
- 支持批量启用 Mock。
- 支持一键恢复原配置。
- 提供配置覆盖不可用的明确提示。
- 不默认修改业务源码。
- 用户可以查看项目启动配置和路由接管结果。

**MVP 边界**

仅承诺支持能够通过已识别配置项覆盖的客户端。

对硬编码 URL、自定义路由和特殊代理实现，仅提供人工确认或标记不支持；不以通用 JVM 插桩作为 MVP 必须交付功能。

如果用户自行启动 Java 项目，Mockingbird 可以生成对应的启动配置；是否由 IDE 直接启动项目，应以第一版的运行控制设计为准。

**验收标准**

在支持的示例项目中，切换 Mock 路由后，无须修改业务 Java 源码即可将下游请求发送到本地 Mock Server。

恢复路由后，配置能够回到切换之前的状态。

### F10 — 底部工具面板

底部工具面板采用 IntelliJ 风格。

**必须提供的 Tab**

| Tab | 功能 |
|---|---|
| Terminal | 查看并执行受控本地命令 |
| Mock Server | 端口、状态、启停操作 |
| Requests | HTTP 请求、匹配规则和响应记录 |
| Problems | Mock 校验和依赖分析异常 |
| Tasks | Agent 任务状态、执行记录 |

**交互要求**

- 面板可以展开、折叠及调整高度。
- 允许切换不同 Tab。
- 新错误发生时展示非侵入式状态提醒。
- 任务执行日志可查看。
- 运行中的任务可以取消。
- 从 AI 对话中可直接定位对应的底部日志。

### F11 — Mock 保存与管理

**用户故事**

作为用户，我希望编辑、审核并保存当前 Mock 配置，自行管理测试场景与备份。

**功能要求**

- 保存当前 Mock 规则。
- 支持查看变更 Diff。
- 支持撤销未发布修改。
- 保存当前依赖路由配置。
- 保存时记录对应项目版本信息。
- 用户自行编辑、导出和备份 Mock，不保存历史环境版本。

---

## 5. 核心用户流程

### 5.1 首次使用

**Step 1 — Welcome**

用户打开 Mockingbird，点击 Open Project。

**Step 2 — Project Import**

选择 Java 项目路径，系统加载 Maven/Gradle、分析项目结构、识别 Controller。

**Step 3 — AI Setup**

检测本地 Codex CLI 和 OpenCode CLI，用户选择默认 Agent。

**Step 4 — Workspace**

进入 IDE 主界面，左侧显示项目，右侧显示 AI 对话，中间显示项目概览，底部提供工具面板。

### 5.2 分析 API Flow

1. 用户展开 API Explorer。
2. 搜索或选择 `/api/payment/create`。
3. 点击 Analyze Flow。
4. AI 分析 Java 调用关系。
5. 中间展示 Workflow Graph。
6. 左侧显示下游 API 列表。
7. 用户检查尚未确认的依赖。

### 5.3 生成 Mock

1. 用户选择整个 Flow。
2. 点击 Generate Mocks。
3. 选择 Success 或 Error 场景。
4. AI 生成 Mock 规则。
5. 中间打开 Mock Review。
6. 用户检查并修改内容。
7. 点击 Save / Apply。
8. Mockingbird 验证并发布规则。

### 5.4 运行 Mock

1. 用户点击 Start Mock Server。
2. 系统启动本地 HTTP Server。
3. 用户选择需要 Mock 的下游依赖。
4. Mockingbird 生成路由覆盖配置。
5. 用户检查并应用配置。
6. 用户运行项目及目标 API。
7. 底部 Requests 展示命中情况。
8. 用户可以编辑、保存并重新测试。

---

## 6. 核心数据对象

MVP 至少需要以下数据模型：

**Project**

- Project ID
- Local Path
- Build Type
- Java Version
- Project Modules
- Selected AI Agent

**Workflow**

- Workflow ID
- Entry Controller
- Entry HTTP Method / Path
- Internal Call Graph
- External Dependencies
- Analysis Status
- Code Revision

**HTTP Dependency**

- Dependency ID
- Source Class / Method
- HTTP Client Type
- Method
- URL / Path Template
- Request / Response Contract
- Evidence
- Routing Mode

**Mock Rule**

- Rule ID
- Dependency ID
- Scenario Name
- Request Matcher
- Response Definition
- Validation Status
- Version

**Agent Task**

- Task ID
- Agent Type
- User Request
- Task Status
- Output Artifacts
- Error Information
- Approval Status

---

## 7. 非功能性需求

### 7.1 性能

- 桌面界面不能因 AI 任务阻塞。
- 项目分析必须异步执行。
- 大项目索引应展示进度。
- Flow Graph 必须支持基础缩放和平移。
- Mock Server 启停应具有明确状态反馈。
- 进程异常退出应能被检测并报告。

### 7.2 安全

- 默认本地优先运行。
- 不自动上传完整代码仓库到 Mockingbird 自有服务。
- 使用外部 Agent 时，明确遵循所选 Agent 的数据传输及权限设置。
- 对潜在敏感日志、Token、用户信息提供脱敏和警告。
- 不将认证凭证写入项目配置或普通日志。
- AI 修改文件、执行高风险命令需要相应授权。
- 默认禁止未授权的真实写请求回退转发。
- 项目源文件默认只读分析。

### 7.3 可靠性

- Mock 规则生成失败不影响已有规则。
- 新规则必须验证成功才能发布。
- Mock Server 意外退出后给出错误提示。
- Agent 失败不得破坏当前 Workspace。
- 项目代码变更后能够提示 Flow 分析结果可能已过期。

---

## 8. 技术架构建议

**Desktop**

Electron + React + TypeScript

**Editor**

Monaco Editor

**Workflow Visualization**

React Flow

**AI Integration**

Codex CLI Adapter  
OpenCode CLI Adapter

**Code Analysis**

JavaParser / Eclipse JDT  
Client-specific Analyzers  
Agent-assisted Analysis

**Mock Runtime**

WireMock

**Storage**

SQLite  
Local YAML/JSON Files

**Routing**

Spring Configuration Override  
Environment Variables  
Launch Configuration

**Observability（按需）**

OpenTelemetry Java Instrumentation

整体结构：

```text
Mockingbird Desktop
│
├── Project Explorer
├── Workflow Explorer
├── Main Workspace
│   ├── Workflow Graph
│   ├── Code Viewer
│   └── Mock Editor
│
├── AI Panel
│   ├── Codex CLI Adapter
│   └── OpenCode CLI Adapter
│
├── Java Analysis Engine
├── Dependency Graph Engine
├── Mock Generation Engine
├── Route Manager
│
└── Local Mock Runtime
    └── WireMock Server
```

**架构原则：** AI 负责分析和生成建议；确定性的本地执行引擎负责校验、Mock 发布和路由。

---

## 9. MVP 开发里程碑

### Milestone 1 — IDE Shell

交付项目导入、项目树、中间多 Tab、右侧 AI Chat、底部工具面板及基础设置。

### Milestone 2 — AI & Workflow

接通 Codex/OpenCode CLI，支持 API 入口选择、调用关系分析、下游依赖列表与 Workflow Graph。

### Milestone 3 — Mock Generation

支持批量 Mock 生成、编辑、校验和保存。

### Milestone 4 — Mock Runtime

集成 WireMock，实现启动、停止、请求命中及日志查看。

### Milestone 5 — Routing & Persistence

实现配置覆盖、Mock/Real 切换、变更预览与当前配置保存。

### Milestone 6 — End-to-End Validation

使用至少一个包含多种 HTTP Client 的 Spring Boot 示例项目完成完整验收。

---

## 10. MVP 端到端验收场景

**场景：支付 API 开发环境隔离**

测试项目对外提供：

`POST /api/payment/create`

该 Flow 包含至少四个使用不同 HTTP Client 的下游 API：

- User API — Feign
- Inventory API — RestTemplate
- Risk API — WebClient
- Bank API — OkHttp

**验收任务**

1. 导入项目。
2. 发现入口 API。
3. 分析并展示四个下游 HTTP 依赖。
4. 为四个依赖生成可编辑的 Mock。
5. 启动 Mock Server。
6. 通过受支持的配置覆盖方式接管这些依赖。
7. 调用入口 API，确认 Mock 被命中。
8. 修改银行 Mock 响应，重新测试。
9. 用户手动修改 Mock 响应并切换路由配置。
10. 再次执行并验证修改后的行为。

**通过条件**

- 所有验收操作均可通过 Mockingbird UI 完成。
- 不需要用户手写 Mock JSON。
- 不需要直接修改业务 Java 源码。
- 能明确展示依赖识别证据和未确认项。
- 所有 Mock 变更可查看、编辑和保存。
- 有效 Mock 能在本地 Server 正常运行。
- 受支持的路由切换和 Mock 编辑能够重复执行。
- Agent 或 Mock Server 失败时，界面不会丢失已有工作结果。

---

## 11. MVP 暂定产品指标

以下作为试验阶段的目标，需要在真实团队试用后校准：

| 指标 | 初始目标 |
|---|---|
| 首次上手 | 无须阅读完整技术文档即可完成主要流程 |
| Mock 创建效率 | 相比当前手工流程减少至少 50% 的操作时间 |
| Mock 修改 | 单个 Mock 可通过图形界面或 AI 修改 |
| Flow 可解释性 | 每个识别出的下游依赖可查看来源证据 |
| Mock 执行 | 支持重复执行相同确定性场景 |
| 配置保存 | 当前路由与规则保存后可重新打开 |
| Agent 兼容 | Codex 和 OpenCode 均通过端到端验收 |

核心验证指标不是 AI 生成多少代码，而是：

**从用户选择入口 API 到成功使用 Mock 独立执行 Flow 的总耗时。**

---

## 12. 产品设计总结

Mockingbird MVP 不追求成为另一个完整的 IntelliJ IDEA。

它的核心是将传统 Mock 开发过程中分散的操作整合为一个 AI-Native Workflow：

**Understand → Discover → Mock → Serve → Route → Verify → Restore**

用户主要通过 AI 对话表达意图，通过 IDE 式可视化界面审核和操作，通过底部工具面板完成日常运行、日志查看和调试。

MVP 最重要的产品承诺是：

**让 Java 开发者更容易理解一个 API 所依赖的外部 HTTP 系统，并快速创建、运行和维护用于开发测试的 Mock 环境。**