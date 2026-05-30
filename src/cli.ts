#!/usr/bin/env node
import { config } from 'dotenv'
config()
import { Command } from 'commander'
import { createInterface } from 'node:readline/promises'
import { resolve, dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
import { DeepSeekClient } from './model/deepseek-client.js'
import { ToolRegistry } from './tools/registry.js'
import { readTool } from './tools/read.js'
import { writeTool } from './tools/write.js'
import { editTool } from './tools/edit.js'
import { bashTool } from './tools/bash.js'
import { createSession, runTurn } from './agent/loop.js'
import { executeWorkflow } from './workflow/workflow-runtime.js'

const SYSTEM = 'You are FlowLoom, a coding agent. Use the provided tools (read_file, write_file, edit_file, run_shell) to inspect and modify the user\'s project. Prefer edit_file for small changes; call a tool whenever you need file contents or to run a command.'

function makeRegistry() {
  const registry = new ToolRegistry()
  ;[readTool, writeTool, editTool, bashTool].forEach((t) => registry.register(t))
  return registry
}

function makeSession(model: string) {
  return createSession({ client: new DeepSeekClient({ model }), registry: makeRegistry(), system: SYSTEM, model, maxTokens: 4096 })
}

function printUsage(session: ReturnType<typeof makeSession>) {
  process.stderr.write(`[usage] in=${session.usage.inputTokens} out=${session.usage.outputTokens} cacheHit=${session.usage.cacheHitTokens}\n`)
}

const program = new Command()
program
  .name('floom')
  .argument('[task...]', 'task for the agent; omit to enter interactive mode')
  .option('-m, --model <id>', 'model id', process.env.DEEPSEEK_MODEL ?? 'deepseek-chat')
  .action(async (task: string[], opts: { model: string }) => {
    const session = makeSession(opts.model)
    const write = (d: string) => process.stdout.write(d)
    if (task.length) {
      await runTurn(session, task.join(' '), write)
      process.stdout.write('\n')
      printUsage(session)
      return
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    console.log('FlowLoom interactive mode — type /exit to quit.')
    for (;;) {
      let line: string
      try {
        line = (await rl.question('\nfloom> ')).trim()
      } catch {
        break // stdin 关闭 / EOF（管道结束或 Ctrl+D）→ 优雅退出，不崩溃
      }
      if (line === '/exit') break
      if (line === '') continue
      await runTurn(session, line, write)
      process.stdout.write('\n')
      printUsage(session)
    }
    rl.close()
  })
program
  .command('run <script>')
  .description('run a workflow script')
  .option('-b, --budget <n>', 'token budget', '1000000')
  .option('-j, --journal <path>', 'journal database path', '.floom/journal.db')
  .option('-a, --args <json>', 'JSON args to pass to the script', '{}')
  .option('-m, --model <id>', 'model id', process.env.DEEPSEEK_MODEL ?? 'deepseek-chat')
  .action(async (script: string, opts: { budget: string; journal: string; args: string; model: string }) => {
    const registry = makeRegistry()
    const client = new DeepSeekClient({ model: opts.model })
    let args: Record<string, unknown> = {}
    try {
      args = JSON.parse(opts.args)
    } catch {
      process.stderr.write(`WARNING: invalid --args JSON, using {}\n`)
    }
    const result = await executeWorkflow({
      scriptPath: resolve(script),
      args,
      client,
      registry,
      journalPath: (() => { mkdirSync(dirname(resolve(opts.journal)), { recursive: true }); return opts.journal })(),
      budgetLimit: parseInt(opts.budget, 10),
      model: opts.model,
      system: SYSTEM,
    })
    if (result.status === 'done') {
      if (result.result !== undefined) {
        console.log(typeof result.result === 'string' ? result.result : JSON.stringify(result.result, null, 2))
      }
    } else {
      process.stderr.write(`ERROR: ${result.error}\n`)
      process.exit(1)
    }
  })

program.parseAsync()
