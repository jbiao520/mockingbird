# 更丰富的 Mock 行为：支持方案

日期：2026-10-10。本文是设计建议，功能尚未接入 Mockingbird 编辑器和规则模型。

## 目标与建议

让同一个 API 根据请求中的 path、query、header、body 生成响应，尽量复用响应结构；为重试、超时和轮询提供可控制的异常与状态变化。

优先交付「动态响应模板 + 更灵活的匹配 + 明确的优先级」。这是减少固定 JSON 和规则复制最直接的一步。继续使用项目已有的 WireMock 3.13.2 执行规则。

匹配条件决定“用哪一种行为”；模板决定“这个请求具体返回什么”。仅仅增加 JSONPath 匹配仍然会留下大量固定响应。

## 当前代码中的限制

| 位置 | 当前行为 | 扩展影响 |
| --- | --- | --- |
| `shared/types.ts` 的 `MockRule` | 静态 JSON body、固定 delay、精确 query/header/body | 需要区分静态响应、模板响应、连接故障 |
| `server/rules.ts` 的 `mapping()` | 编译为 `equalTo`、`equalToJson`、`jsonBody`、`fixedDelayMilliseconds` | 增加匹配操作符、模板 transformer、故障与状态映射 |
| `shared/rule-groups.ts` | 重叠规则拒绝或自动关闭；`scenario` 仅用于分组 | 支持默认规则与特殊规则共存，独立建模运行时状态 |
| `server/agents.ts` | 源码生成要求每个选中依赖恰好一条静态规则 | 默认生成可复用模板；按明确请求生成多个条件分支 |
| `server/workbench.ts` / `server/response-shape.ts` | 保存时校验静态 body 与 DTO | 模板需要先渲染样本再校验，不能把模板文本当 DTO |
| `server/runtime.ts` | 发布映射、读取 HTTP 日志 | 加入状态查询/重置；区分 HTTP 错误与传输错误 |
| `server/exports.ts` | WireMock 映射、Postman 静态 Examples | 区分保留行为的导出与仅包含样本的导出 |

工作区同时存在服务 namespace 路由设计。后续匹配、模板路径变量和状态机名称都应遵守这个边界：用户看到业务路径，编译器处理 `/__mockingbird/...` 前缀，避免不同服务相互影响。

## 1. 动态响应：复用结构，让字段来自请求

建议编辑器提供「固定 JSON / 动态模板」两种响应方式。动态模板支持：

- 请求取值：path 参数、query、header、JSON body 字段。
- 字段计算：默认值、条件分支、简单算术、数组遍历。
- 数据生成：UUID、时间、范围内的随机整数、候选值随机选择。
- 局部变量：生成一次 ID，在同一响应的多个字段中复用。

例如支付响应的配置可以描述为：

| 响应字段 | 取值方式 |
| --- | --- |
| `userId` | 请求 body 的 `userId` |
| `amount` | 请求 body 的 `amount`，保留数字类型 |
| `transactionId` | 本次响应生成的 UUID |
| `approved` | header 指定拒绝时为 false；否则根据金额判断 |
| `createdAt` | 当前时间 |

这样换用户、换金额不需要新增规则。业务结构相同、只有少量字段不同，可以在模板内分支；HTTP 状态或响应结构明显不同，使用独立条件规则更容易理解。人工固定样本仍然适合精确断言。

首版使用 WireMock 内置 Handlebars。界面提供「插入请求字段」「插入 UUID」「插入条件」等预设，并展示渲染结果；不要求用户编写 WireMock mapping JSON。[模板能力](https://wiremock.org/docs/response-templating/)

以下模板已在项目自带的 3.13.2 JAR 上验证，可作为默认插入示例：

```handlebars
{{parseJson request.body 'input'}}
{{val (randomValue type='UUID') assign='transactionId'}}
{
  "userId": {{{toJson input.userId}}},
  "amount": {{{toJson input.amount}}},
  "approved": {{#lt input.amount 1000}}true{{else}}false{{/lt}},
  "transactionId": "{{transactionId}}",
  "referenceId": "{{transactionId}}"
}
```

模板编辑区按模板文本处理，不强制它在渲染前是合法 JSON。取值采用 JSON 序列化，正确保留数字、布尔、对象和数组，并处理引号、反斜杠、换行；不依靠字符串拼接。缺失值明确区分“默认值 / null / 拒绝请求”，不能悄悄生成空字符串。

表单预设只提供受控的数据处理功能，首版不引入任意 JavaScript 或访问外部服务的脚本模式。

## 2. 请求匹配：只约束影响业务的部分

| 目标 | 建议首版支持 |
| --- | --- |
| Query / Header | 等于、包含、正则、存在、不存在 |
| JSON Body | 完整 JSON 相等、部分 JSON、JSONPath |
| 多个条件 | 默认 AND；复杂 OR 可用独立规则表达 |

部分 JSON 例如只匹配 `{ "currency": "CNY" }`，允许请求携带不同的用户、金额和额外字段。映射到 `equalToJson + ignoreExtraElements`；数组是否忽略顺序单独配置，不默认改变数组语义。JSONPath 适合 `amount >= 1000`、嵌套对象与数组筛选。[匹配能力](https://wiremock.org/docs/request-matching/)

必须允许「特殊规则 + 默认规则」共存。建议提供数值优先级，较小值先匹配，例如拒绝规则 10、默认规则 100。相同优先级且可能重叠时要求用户消除歧义，避免依赖发布时间选中规则。[优先级](https://wiremock.org/docs/stubbing/#stub-priority)

现有重叠算法只适合精确条件。任意正则与 JSONPath 的交集难以静态证明，应区分“确定互斥 / 确定重叠 / 无法判定”。显式不同优先级可以解决选择问题；同一状态机的互斥状态也可以共存。分组启用逻辑必须同步修改，否则后端允许的分支仍会被界面关闭。

## 3. 随机数据：先明确生命周期

| 需求 | 建议处理 |
| --- | --- |
| 每次请求生成新的 ID | 内置 UUID / 随机函数 |
| 同一响应多个字段使用同一 ID | 局部变量生成一次、重复引用 |
| 不同下游响应关联同一业务请求 | 从真实传入的业务键或关联 header 取值 |
| 创建后再查询仍返回相同 ID | 按业务键存储生成结果，后续阶段实现 |
| 重试返回相同结果 | 按幂等键复用结果，后续阶段实现 |

“随机 UUID”与“有业务记忆的 Mock”是不同能力。按业务键存储结果需要额外的状态存储或 WireMock 扩展，不能承诺简单模板自动做到。关联 header 也必须由业务代码实际传递，不能假定所有下游都收到入口请求的 header。

测试模式提供固定 ID 和固定时间；未实现可设 seed 的随机执行器前，不宣称相同 seed 能复现结果。若后续增加随机失败比例，也应提供可复现控制。业务枚举与成功/失败分支默认由条件决定，随机值主要用于没有确定性要求的数据字段。

## 4. 异常：业务拒绝、HTTP 错误、传输错误

编辑器需要区分三个结果：

- HTTP 200 + `approved: false`：业务拒绝，调用方仍可读取 DTO。
- HTTP 503：服务错误，可验证异常处理或重试。
- 无响应、连接重置、损坏响应：传输故障，可验证网络异常路径。

延迟支持固定延迟与范围抖动。超时预设应让延迟超过客户端的读取超时；单纯返回 504 只是在模拟 HTTP 状态，不能证明客户端超时机制触发。可以后续增加分块慢响应。

故障模式与正常 JSON 响应使用互斥配置，避免用户同时配置 body 与“无响应”。连接重置有平台差异，需要在界面和验收中如实说明。[故障与延迟](https://wiremock.org/docs/simulating-faults/)

请求日志中的传输故障应展示独立结果，不应因没有 HTTP 状态而回退成 404。保留实际返回的渲染正文与命中的规则信息，并沿用现有脱敏。

## 5. 连续调用：独立的状态机

建议增加 `stateMachine`，字段包括独立 ID、当前匹配状态、命中后的下一状态。现有 `scenario` 继续作为用户分组名称，避免 Success / Error 分组变成全局状态机。

两个典型预设：

```text
重试：Started --503--> Retry1 --503--> Recovered --200--> Recovered
轮询：Started --PENDING--> Processing --PENDING--> Complete --SUCCESS--> Complete
```

序列耗尽时明确选择“保持最后一步 / 从头循环 / 不再匹配”，默认保持最后一步。只有实际命中的步骤推进状态，编辑器预览不能消耗真实状态。

第一版有状态行为只承诺单实例、串行测试。WireMock 原生 scenario 按名称维护共享状态，不自动按用户、订单或 header 隔离；不同业务对象交错请求、并发请求的严格次数保证，需要进一步设计关联存储和原子状态更新。[状态与重置](https://wiremock.org/docs/stateful-behaviour/)

状态机名称编译时包含服务 namespace 与稳定的状态机 ID；查询当前状态、单个重置、全部重置都应可见。启动、修改状态机定义时回到初始状态；普通无状态规则更新尽量保留现有状态。批量发布对状态的实际影响需在 3.13.2 上单独验收，不能假定 import 自动保留状态。

用户自行管理 Mock 行为配置和运行时状态；状态重置通过显式操作完成。

## 模型、验证和交互

建议引入明确的规则格式版本 `schemaVersion`，与当前每次修改递增的 `version` 区分。保持 ID、依赖、分组、证据等元数据，内部统一为：

```text
Rule
  metadata: id / dependencyId / scenario / version / evidence / ...
  priority
  match: method / path / queryMatchers / headerMatchers / bodyMatchers
  response:
    static   -> status / headers / JSON body / delay
    template -> status / headers / bodyTemplate / delay
    fault    -> fault / optional delay
  stateMachine?: id / requiredState / nextState
```

旧规则在读取时规范化为精确 matcher 与静态 response，保持原有行为；旧工作区、AI 候选和导出走同一个规范化入口。旧字段与新字段不能各自决定运行行为。保存使用新格式，需要记录旧版本应用不能读取的新能力。

模板验证分两步：保存时校验语法、允许的 helper、字段来源与默认值；用代表性请求渲染后，再检查 JSON 与已知 DTO。一次样本通过只能证明该样本，需要覆盖条件的两侧、缺失值和边界值。不能给任意模板标记“所有输入均已通过契约验证”。

编辑器增加「匹配条件 / 响应行为 / 状态变化 / 请求预览」；普通规则仍使用现有简单表单。预览支持填写请求并展示命中规则、响应和校验结果，使用隔离运行环境或无副作用的执行接口；不推进线上 Mock 的状态。真实请求日志先展示 WireMock 能提供的实际信息，逐条件解释与状态前后值需要额外采集，不能凭推断标成已观测。

AI 生成应允许这样的指令：

> 根据请求回填 userId 和 amount，生成 transactionId；金额大于等于 1000 时拒绝，其他情况通过。

默认返回一份模板与测试样本；多个业务分支可返回同一依赖的多条规则，但必须覆盖所选依赖、使用已确认的方法和路径、具有明确优先级，仍经过候选审核。将“必须每个依赖恰好一条”的校验改为“每个选中依赖有明确且完整的行为”。HTTP Client 需要独立的样本请求，不能把 JSONPath 表达式或部分匹配条件直接当成请求 body。

WireMock 导出保留可由内置能力执行的匹配、模板、故障和状态规则，并声明所需版本。Postman 导出动态规则的样本响应及行为说明，明确哪些能力没有等价执行语义。未来若引入自定义扩展，导出必须带扩展要求或拒绝无损导出。

## 实施顺序与验收

1. **第一阶段：输入驱动响应。** 模板模式、请求引用、UUID/时间/变量、部分 Body、JSONPath、query/header 操作符、优先级，以及隔离预览和样本 DTO 校验。
2. **第二阶段：可靠性测试。** 网络故障、延迟抖动、响应序列/状态机、重置、传输结果日志。
3. **第三阶段：业务关联。** 按用户/订单/幂等键隔离状态，创建后查询、跨请求数据、并发与可复现随机。

第一阶段验收至少包含：旧规则重开行为不变；不同输入回填不同响应；字符串特殊字符不破坏 JSON；数字/布尔/数组保留类型；同一响应 ID 一致、不同响应 ID 可变化；特殊 header 规则优先、未命中时落到默认规则；额外 body 字段不影响部分匹配；金额边界两侧正确；非法模板不覆盖已发布规则；预览不改变真实状态；WireMock 导出后实际执行相同行为。

第二阶段验收包含：读取超时在真实 Java Client 上触发；串行首次失败随后恢复；循环/保持最后一步语义明确；重置可重复序列；普通发布、修改状态机的状态行为符合定义；连接故障不显示为 HTTP 404。按业务键隔离与并发验收留在第三阶段。

## 本次技术验证

使用项目自带 WireMock 3.13.2，在临时目录和独立端口启动，通过实际 HTTP 请求验证：模板取 body 值、JSON 特殊字符转义、数字类型、金额条件分支、UUID 每次变化且同一响应复用、部分 JSON 匹配、JSONPath 数值筛选、503→200→200 状态序列、重置回到 503、EMPTY_RESPONSE 引发传输失败。验证进程与临时目录已清理。

本次未修改产品实现；header 条件模板、范围抖动、跨请求关联、并发隔离、批量发布时的状态保留、编辑器预览与导出迁移仍属于上述后续验收范围。
