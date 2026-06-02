# 上下文压缩（Context Compaction）

长会话会把对话历史推过模型的上下文窗口。FlowLoom 早先的自我保护是**整轮丢弃**最旧的对话——简单但**会丢信息**。语义压缩改为：把最旧的若干轮交给模型**摘要**成一段紧凑的「早前对话摘要」，折叠进 system 提示保留要点，而不是直接扔掉。对标 Claude Code 的 `/compact`。

## 两种触发方式

### 1. 自动压缩（超预算时）

当设置了上下文预算 `contextTokens`（自我保护阈值，`<=0` 或缺省 = 关闭）且**发请求前**估算 token 超过它时，`runTurn` 会**优先**摘要最旧的轮、折叠进 system，再发请求。

- **静默**：摘要调用不走 `onText/onReasoning`，摘要内容不会泄漏到你的输出流。
- **永不打断本轮**：摘要调用失败（网络/超时等）或没有可压缩的旧轮时，自动**回退**到原有的「整轮丢弃」（`trimMessages`）。
- **当前轮始终保留**：最新的 user 及其后续消息不参与摘要，多轮工具调用中不会丢掉进行中的上下文。
- 由会话标志 `autoCompact` 控制（默认 **开**）。注意它仅在 `contextTokens > 0` 时才可能触发；`contextTokens` 缺省为 0，故默认不会产生额外模型调用。

### 2. 手动 `/compact`（交互式 REPL）

```
/compact
```

把**除最新一轮之外**的全部历史摘要成一段「早前对话摘要」折叠进 system，并保存会话。适合你主动腾出上下文、又想保住此前的决策与上下文要点时使用。

## 摘要里保留什么

摘要 prompt 要求模型保留：你的**目标与明确指令**、做出的**决策**、创建/修改的**文件与函数**、发现的**关键事实**、运行过的**命令及其结果**、以及**未完成的任务/下一步**;丢弃寒暄;并明令**不得臆造**历史中没有的内容。

## 不变量（为何安全）

- **按「整轮」切分**（复用 `context.ts` 的 `splitRounds`）：保留的消息仍以 `user` 开头，且不产生「孤儿 `tool_call_id`」——与 `trimMessages` 同一套不变量，避免 OpenAI/DeepSeek 因 tool 结果找不到对应 `tool_calls` 而报 400。
- **摘要请求扁平化为纯文本**：要压缩的轮被渲染成可读文本塞进单条 `user` 消息（`buildSummaryRequest`/`flattenRoundsToText`），**不复用结构化 `tool` 消息**，从根上规避 `tool_call_id` 牵连。
- **替换而非叠加**：摘要块用稳定分隔符包裹，反复压缩时**替换**既有摘要块（`foldSummaryIntoSystem` + `extractSystemSummary`），system 不会无限膨胀;更早的摘要会被并入新摘要保持连续。
- **模型无关**：摘要一律经 `ModelClient` 接口发起，`src/agent/` 不感知具体模型、不 `import openai`。

## 实现

- 核心（纯 + 异步）：`src/agent/compaction.ts`
  - `planCompaction`（决定摘要哪些最旧的轮：budget 模式 / `keepLastRounds` 手动模式）、`buildSummaryRequest`、`flattenRoundsToText`、`foldSummaryIntoSystem`、`extractSystemSummary`（均为纯函数，单测覆盖）；
  - `compactMessages`（编排：规划 → 静默摘要 → 折叠 → 返回；无可压缩或模型未给摘要时返回 `null`，调用方回退 trim；模型调用出错则抛出）。
- 自动接线：`src/agent/loop.ts` `runTurn`（超预算优先压缩、失败回退 trim、`onContextCompact` 回调）。
- 手动命令：`src/cli/commands.ts` 的 `/compact`（`runSlash` 保持同步、仅发信号）+ `src/cli.ts` 异步执行实际摘要并提示。

> 估算口径：约 4 字符/token，是经验近似，**非** DeepSeek 官方数字（见 `docs/deepseek-fact-check.md`）。`contextTokens` 走配置，不硬编码任何窗口长度。
