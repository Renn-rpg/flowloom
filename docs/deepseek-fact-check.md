# DeepSeek 事实核验表（阶段 0 产物）

> ⚠️ 这是**待填**模板。规划与 MVP 代码都**未假设**任何 DeepSeek 数字——它们一律走 `.env` / 配置。
> 拿到真实 API Key 后，按本表逐项实测并填写"实测值"与状态（✅已确认 / ❌已证伪 / ❓未知）。
> 实测命令见 plan 文件 Task 0 各步骤。本表是后续所有配置默认值的**唯一依据**。

## 凭据准备
```powershell
$env:DEEPSEEK_API_KEY = "sk-..."
$env:DEEPSEEK_BASE_URL = "https://api.deepseek.com"
```

## 核验表

| # | 待核验项 | 怎么测 | 状态 | 实测值 / 备注 |
|---|---------|--------|------|--------------|
| 1 | 真实 model id 列表 | `curl .../models -H "Authorization: Bearer $KEY"` | ✅ | `deepseek-chat` 实测可用（端到端跑通）；完整列表仍待 `/models` 核对 |
| 2 | 是否支持 function/tool calling | 发一个带 `tools` 的请求看是否回 `tool_calls` | ✅ | 实测支持：单次调用 `read_file` 成功 |
| 3 | 是否支持**并行**工具调用（一次多个 tool_calls） | 设计需两个工具的任务，看 `tool_calls.length` | 🟡 | 10 发均单工具调用（multiCallRounds=0）；deepseek-chat 倾向一次一个工具，本批未观察到并行 |
| 4 | `tool_calls[].function.arguments` 是否合法 JSON | 重复 10 次最小调用，统计坏 JSON 频次 | ✅ | **10/10 合法 JSON，坏 JSON 率 0%**（含嵌套引号/反斜杠/多行代码/中文/长文本等诱发任务）；显著优于研究报告假设的 80–90%。样本仍小，建议扩到 50+ 复核 |
| 5 | 幻觉 schema 外参数频次 | 同上，检查返回参数是否都在 schema 内 | ✅ | 10/10 无 schema 外参数（halluc=0） |
| 6 | context 窗口长度（按 model） | 查官方文档 / 超长输入实测 | 🟡 | 官方仍**未实测确认**；owner 决定 deepseek-v4-pro 按 **1M** 作为项目默认（`CONTEXT_TOKENS`/`ctxWindow` 默认 1_000_000，状态行显示 (1M)，可 `FLOOM_CONTEXT_TOKENS` 覆盖）。换更小模型须下调，否则估算放行后可能被 API 以超长报 400 |
| 7 | max output tokens（按 model） | 查文档 / 实测 | ❓ | **勿假设 384K** |
| 8 | `finish_reason` 取值集合 | 观察各种结束情况 | ❓ | 至少确认 stop / tool_calls / length |
| 9 | JSON 模式"假死"是否存在 | `response_format=json_object` 且 prompt **不含** "json" | ❓ | 是否无限空白到 max_tokens？ |
| 10 | 连接超时阈值 + 保活帧形式 | 长任务观察 | ❓ | 规划称 ~10 分钟；保活帧需正确忽略 |
| 11 | 账户并发额度（429 阈值） | 并发压测触发 429 | ❓ | 本地 Semaphore 上限须 ≤ 此值；**勿假设 500/2500** |
| 12 | `usage` 是否含缓存计费字段 | 检查响应 `usage` | ✅ | 实测返回 `prompt_cache_hit_tokens`（[usage] cacheHit 实测 4736→9984），字段确实存在 |
| 13 | 自动前缀缓存是否默认开启、如何计费 | 重复相同前缀请求看命中 | ✅ | 默认开启：相同前缀（system+tools）实测命中 cacheHit>0，第二次命中更多；命中部分按更低价计费 |
| 14 | 是否有 `/anthropic` 兼容端点 | 查文档 / 试 base_url=.../anthropic | ❓ | 若有且完整，可走原生 Anthropic 路径 |
| 15 | 是否有生产级 vision（图像/PDF 理解） | 查文档 | ❓ | 决定 Read 工具对图片/PDF 是否降级 |
| 16 | 是否支持 `strict` 模式（schema 服务端校验，beta） | 试 base_url=.../beta + strict:true | ❓ | 若可用，优先开启降低修复频率 |

## deepseek-reasoner / thinking mode 专项（📄 官方文档核验，**待真机复核**）

> 来源：`api-docs.deepseek.com/guides/reasoning_model`、`/guides/thinking_mode`、`/api/create-chat-completion`（2025–2026 版）。
> 标记 📄 = 文档明确陈述但**尚未用真实 key 实测**；不得当作 ✅ 实测结论。

| # | 项 | 状态 | 文档原文 / 结论 | 来源页 |
|---|---|------|----------------|--------|
| R1 | `deepseek-reasoner` 是真实 model id | 📄 | 是；推理模型页以该 id 为准 | reasoning_model |
| R2 | **`deepseek-reasoner` 是否支持 Function Calling** | 📄❌ | **不支持**：「NOT Supported: Function Calling、FIM (Beta)」；支持「Json Output、Chat Completion、Chat Prefix Completion」 | reasoning_model |
| R3 | `deepseek-reasoner` 采样参数 | 📄 | temperature/top_p/presence_penalty/frequency_penalty **不报错但无效**；logprobs/top_logprobs **报错** | reasoning_model |
| R4 | `deepseek-reasoner` max_tokens | 📄 | 默认 **32K**、最大 **64K**，**含 CoT(`reasoning_content`)+ 最终答案(`content`)**。输入 context 窗口该页**未给** → 仍**勿假设** | reasoning_model |
| R5 | CoT 字段名与位置 | 📄 | `reasoning_content`，与 `content` **同级**、独立字段 | reasoning_model / thinking_mode / API ref |
| R6 | 流式 / 非流式取 CoT | 📄 | 流式 `chunk.choices[0].delta.reasoning_content`；非流式 `choices[0].message.reasoning_content` | API ref |
| R7 | 多轮历史处理（**非工具轮**） | 📄 | 下一轮**必须剥掉** `reasoning_content`：把它带进输入 messages 会 **400**（reasoning_model）；thinking mode 下则「被忽略」 | reasoning_model / thinking_mode |
| R8 | 多轮历史处理（**工具轮**） | 📄 | 发生过 tool call 的轮，`reasoning_content` **必须原样回传**所有后续请求，否则 **400** | thinking_mode |
| R9 | thinking mode 是否支持工具调用 | ✅ | 「The DeepSeek model's thinking mode supports tool calls.」该指南示例 model id 为 `deepseek-v4-pro`（**非** `deepseek-reasoner`）。**用户已实测 `deepseek-v4-pro` 在本账户可跑通**，现已设为默认 `DEEPSEEK_MODEL` | thinking_mode + 用户实测 |

**设计影响（关键）**：
- ❌ 不能让 `--effort high` 把 agent 循环模型直接换成 `deepseek-reasoner`——它不支持工具，会打断工具循环。
- 「带工具的思考」需要 thinking-mode 模型（文档示例 `deepseek-v4-pro`），但其 id 未在本账户实测，**勿假设存在**——交由用户用真实 key 填 `FLOOM_REASONER_MODEL`。
- 三方案的共同地基（协议层捕获 `reasoning_content` 供显示）零假设、可先落地。
- 若将来走 thinking+工具循环，**必须**实现「工具轮回传 reasoning_content」否则 400（R8）。

## 结论摘要（填完后写）
- 选定默认 `DEEPSEEK_MODEL` = `deepseek-v4-pro`（thinking+工具模型，用户已实测可用）；`deepseek-chat` 作为更快/更省的备选
- 单次响应 `max_tokens` 默认 8192（`FLOOM_MAX_TOKENS` 可覆盖）：thinking 模型 CoT+答案共用额度，4096 太小会截断
- 工具调用可靠率基线 = 10/10（0% 坏 JSON，样本小，建议扩到 50+）
- 已证伪/需绕开的假设：`deepseek-reasoner` **不能**作 agentic 工具循环模型（R2，📄待真机复核）；reasoner max output 32K/64K 含 CoT（R4）
