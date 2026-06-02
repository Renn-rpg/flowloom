# 子 agent（dispatch_agent）

FlowLoom 的主 agent 可通过内置工具 **`dispatch_agent`** 派发一个**隔离的子 agent** 去自主完成一个聚焦、自包含的子任务,跑完后只把**最终报告文本**回喂主 agent。这就是 Claude Code 的 `Task`/sub-agent 能力——交互式版本(区别于脚本式的 [workflow 引擎](../README.md#-dynamic-workflow-engine))。

## 为什么用它

- **保护主上下文**:大段代码探索 / 多步调研的中间过程(工具输出、试错)留在子 agent 的独立上下文里,主对话只收到一份摘要,省 token、不污染。
- **任务分解**:把一个界定清晰的子任务整体委派出去,主 agent 专注编排。

## 模型怎么用

模型自行决定调用,入参:

| 字段 | 必填 | 含义 |
|------|------|------|
| `prompt` | 是 | **完整、自包含**的子任务描述(子 agent 看不到主对话) |
| `description` | 否 | 3–5 词的简短标签 |

主 agent 在 system prompt 里被告知:把"大段自包含子任务(如全仓探索、聚焦的多步调研)"委派给 `dispatch_agent`。

## 运行时行为

- 子 agent 有**全新的 messages**(只含派发的 `prompt`)、**独立 usage**、自己的 `runTurn` 循环(`maxIters` 默认 25)。
- 子 agent 的工具集 = **同款基础工具 + 已连接的 MCP 工具**(同款路径围栏);**PreToolUse hooks 对子 agent 同样生效**,且 shell/hook 审批提示带 `sub-agent` 前缀,让用户知道在给谁授权。
- **shell 审批状态相互隔离**:子 agent 用**独立的 shell 策略实例**——在子 agent 里选"本会话不再询问"**只对该子 agent 生效**,不会泄漏到父 agent 或后续子 agent(信任边界隔离;子 agent 中间步骤对用户不可见,故不能让其默默关闭父级确认)。
- 子 agent **不含 `dispatch_agent` 本身** → 无法再派发,**递归深度封顶为 1**。
- **未完成会如实上报**:子 agent 跑满 `maxIters` 仍未收尾时返回 `ERROR: sub-agent did not finish`,主 agent 据此知道子任务被截断(不会把半截结果当成功)。子 agent 抛异常同样返回 `ERROR:`,嵌套进度行变红 `⤷ sub-agent failed`。
- 嵌套进度以暗色就地显示:`⤷ sub-agent working…` + 每个子工具一行 `· <tool> <detail>`,结束 `⤷ sub-agent done · N tool(s) · M tok · Xs`(失败为红色 `failed`)。
- 子 agent 的 token 用量**累计进父级 usage**,保持"成本可视"(turn 末 `── tools · tokens · s ──` 含子 agent)。
- 子 agent 终答 > 50K 字符会被截断(防爆主上下文)。

## 实现与边界

- `src/agent/subagent.ts` —— `makeDispatchAgentTool(deps)` 返回标准 `Tool`;handler 用注入的 `client` + `buildRegistry()`(不含 dispatch_agent)+ `subSystem` 建子 session 跑 `runTurn`。
- **架构不变式**:本模块只依赖 `ModelClient` 接口、`loop`、`ToolRegistry`、`Tool`,**绝不 import openai/DeepSeek**;具体 client/registry/system/gate 由 `cli.ts` 注入(与 hooks/MCP 同款隔离思路)。
- 进度与用量经 `onActivity`/`onUsage` 回调暴露给 UI,`agent/` 层不碰终端。

### 已知边界（后续增量）

- **串行**:DeepSeek 一次只发一个工具调用(见 `docs/deepseek-fact-check`),故主 agent 是逐个派发子 agent,非并行。真并行用脚本式 workflow(`floom run`)。
- 子 agent **不支持嵌套 `dispatch_agent`**(刻意,防递归);如需多层编排请用 workflow。
- 子 agent 流式思考/正文**不外显**(只显示工具进度 + 最终回喂),与"折叠详情"一致。
