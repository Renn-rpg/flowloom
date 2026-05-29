// 阶段0 探针：直连 DeepSeek，统计 tool_calls 的 JSON 质量（坏 JSON 率 / 幻觉参数 / 多调）
// 复用我们的协议层 toOpenAIRequest，单轮请求，只看 DeepSeek 首轮工具调用质量。
import { config } from 'dotenv'
config()
import OpenAI from 'openai'
import { toOpenAIRequest } from '../src/protocol/to-openai.js'
import { readTool } from '../src/tools/read.js'
import { writeTool } from '../src/tools/write.js'
import { bashTool } from '../src/tools/bash.js'

const tools = [readTool, writeTool, bashTool].map((t) => t.spec)
const specByName = new Map(tools.map((s) => [s.name, s]))

const SYSTEM =
  'You are FlowLoom, a coding agent. To accomplish the task you MUST call exactly one of the provided tools. Put all parameters in valid JSON.'

// 专门设计诱发坏 JSON 的任务：特殊字符 / 嵌套引号 / 反斜杠 / 多行代码 / 长文本 / 中文
const TASKS = [
  'Read the file package.json and report the version.',
  'Create file ./tmp_probe/quote.txt with EXACT content: She said "Hi", then left.\nSecond line\tTabbed end.',
  'Run the shell command: node --version',
  'Write ./tmp_probe/config.json with this JSON content: {"name":"x","nums":[1,2,3],"nested":{"a":true,"b":"q\\"q"}}',
  'Write ./tmp_probe/hello.py containing a python function greet(name) with a docstring that prints a greeting over multiple lines.',
  '读取文件 ./tsconfig.json 并说明 target 是什么',
  'Write ./tmp_probe/poem.txt with a 150-word poem about the sea.',
  'List all .ts files under the src directory using one shell command.',
  'Write ./tmp_probe/win.txt with content containing a Windows path C:\\Users\\test\\a.txt and a regex \\d+\\.\\d+ on one line.',
  'Read package.json then (in the same answer) tell me what tool you would call to count its lines.',
]

const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
})
const model = process.env.DEEPSEEK_MODEL ?? 'deepseek-chat'

let totalCalls = 0
let badJson = 0
let halluc = 0
let multiCallRounds = 0
let noToolRounds = 0
let apiErrors = 0

for (let i = 0; i < TASKS.length; i++) {
  const body = toOpenAIRequest({
    system: SYSTEM,
    messages: [{ role: 'user', text: TASKS[i] }],
    tools,
    model,
    maxTokens: 2048,
  })
  let resp: any
  try {
    resp = await client.chat.completions.create({ ...(body as any), stream: false })
  } catch (e: any) {
    apiErrors++
    console.log(`#${i + 1} API_ERROR ${e?.message ?? e}`)
    continue
  }
  const choice = resp.choices?.[0] ?? {}
  const calls = choice.message?.tool_calls ?? []
  if (calls.length === 0) noToolRounds++
  if (calls.length > 1) multiCallRounds++
  let line = `#${i + 1} finish=${choice.finish_reason} calls=${calls.length}`
  for (const c of calls) {
    totalCalls++
    const raw: string = c.function?.arguments ?? ''
    let parsed: any
    try {
      parsed = JSON.parse(raw)
    } catch {
      badJson++
      line += ` [BAD_JSON ${c.function?.name}: ${JSON.stringify(raw).slice(0, 70)}]`
      continue
    }
    const props: any = (specByName.get(c.function?.name) as any)?.inputSchema?.properties ?? {}
    const extra = Object.keys(parsed).filter((k) => !(k in props))
    if (extra.length) {
      halluc++
      line += ` [HALLUC ${c.function?.name}: +${extra.join(',')}]`
    } else {
      line += ` [ok ${c.function?.name}]`
    }
  }
  console.log(line)
}

console.log(
  `\n=== SUMMARY ===\n` +
    `tasks=${TASKS.length}  apiErrors=${apiErrors}\n` +
    `toolCalls=${totalCalls}  badJSON=${badJson}  halluc=${halluc}\n` +
    `multiCallRounds=${multiCallRounds}  noToolRounds=${noToolRounds}\n` +
    `badJSON_rate=${totalCalls ? ((badJson / totalCalls) * 100).toFixed(1) : 'n/a'}%`,
)
