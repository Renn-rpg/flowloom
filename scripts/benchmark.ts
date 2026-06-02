// 性能基准：衡量工具调用延迟、首 token 延迟、上下文裁剪性能。
// 用法: npx tsx scripts/benchmark.ts
// 需要 DeepSeek API key（读 .env）。

import { config } from 'dotenv'
config({ quiet: true })

import { DeepSeekClient } from '../src/model/deepseek-client.js'
import { ToolRegistry } from '../src/tools/registry.js'
import { makeReadTool } from '../src/tools/read.js'
import { makeGlobTool } from '../src/tools/glob.js'
import { makeGrepTool } from '../src/tools/grep.js'
import { createSession, runTurn } from '../src/agent/loop.js'
import { estimateTokens, trimMessages } from '../src/agent/context.js'
import { allowAllPaths } from '../src/tools/permissions.js'

const model = process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-pro'
const client = new DeepSeekClient({ model })

const registry = new ToolRegistry()
registry.register(makeReadTool(allowAllPaths))
registry.register(makeGlobTool(allowAllPaths))
registry.register(makeGrepTool(allowAllPaths))

interface BenchResult {
  name: string
  value: number
  unit: string
}

async function bench(name: string, fn: () => Promise<void>): Promise<BenchResult> {
  const t0 = performance.now()
  await fn()
  return { name, value: Math.round(performance.now() - t0), unit: 'ms' }
}

async function main() {
  const results: BenchResult[] = []

  // 1. 工具调用延迟
  results.push(await bench('read_file (small)', async () => {
    await registry.run('read_file', { path: 'package.json' })
  }))

  // 2. glob 延迟
  results.push(await bench('glob (src/**/*.ts)', async () => {
    await registry.run('glob', { pattern: 'src/**/*.ts' })
  }))

  // 3. 首 token 延迟
  let firstTokenMs = 0
  const session = createSession({ client, registry, system: 'You are a helpful assistant.', model, maxTokens: 256 })
  const t0 = performance.now()
  await runTurn(session, 'Say "Hello, FlowLoom!" and nothing else.', {
    onText: () => { if (!firstTokenMs) firstTokenMs = Math.round(performance.now() - t0) },
  })
  results.push({ name: 'first token latency', value: firstTokenMs, unit: 'ms' })

  // 4. 上下文裁剪性能 (10k messages)
  const msgs = Array.from({ length: 1000 }, (_, i) => ({ role: 'user' as const, text: `message ${i} `.repeat(100) }))
  results.push(await bench('trimMessages (1000 msgs)', async () => {
    trimMessages('system', msgs, [], 100_000)
  }))

  // 5. Token 估算性能
  results.push(await bench('estimateTokens (1000 msgs)', async () => {
    estimateTokens('system', msgs, [])
  }))

  console.log('\n=== FlowLoom Benchmark ===')
  console.log(`Model: ${model}`)
  console.log('')
  for (const r of results) {
    console.log(`  ${r.name}: ${r.value}${r.unit}`)
  }
}

main().catch(console.error)
