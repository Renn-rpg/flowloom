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
| 6 | context 窗口长度（按 model） | 查官方文档 / 超长输入实测 | ❓ | **勿假设 1M** |
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

## 结论摘要（填完后写）
- 选定默认 `DEEPSEEK_MODEL` = `____`（写入 `.env`）
- 工具调用可靠率基线 = ____%（决定阶段2修复管线强度）
- 已证伪/需绕开的假设：____
