#!/usr/bin/env node
import { config } from 'dotenv'
config({ quiet: true })
import { Command } from 'commander'
import { createInterface } from 'node:readline/promises'
import { resolve, dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
import type { Ora } from 'ora'
import { DeepSeekClient } from './model/deepseek-client.js'
import { ToolRegistry } from './tools/registry.js'
import { readTool } from './tools/read.js'
import { writeTool } from './tools/write.js'
import { editTool } from './tools/edit.js'
import { bashTool } from './tools/bash.js'
import { createSession, runTurn } from './agent/loop.js'
import { executeWorkflow } from './workflow/workflow-runtime.js'
import { NodeVmRuntime } from './workflow/sandbox.js'
import { createSpinner, toolStart } from './cli/spinner.js'
import { fmt } from './cli/format.js'
import { showWelcome } from './cli/welcome.js'

const VERSION = '0.8.0'

const SYSTEM =
  'You are FlowLoom, a coding agent. Use the provided tools (read_file, write_file, edit_file, run_shell) to inspect and modify the user\'s project. Prefer edit_file for small changes; call a tool whenever you need file contents or to run a command.'

function makeRegistry() {
  const registry = new ToolRegistry()
  ;[readTool, writeTool, editTool, bashTool].forEach((t) => registry.register(t))
  return registry
}

function makeSession(model: string) {
  return createSession({
    client: new DeepSeekClient({ model }),
    registry: makeRegistry(),
    system: SYSTEM,
    model,
    maxTokens: 4096,
  })
}

// 单次 turn 的 UI 渲染：spinner + 计时 + 工具链动画
async function runTurnWithUI(
  session: ReturnType<typeof makeSession>,
  task: string,
  write: (d: string) => void,
) {
  const startTime = Date.now()
  const thinkSpinner = createSpinner('Thinking...')
  let toolSpinner: Ora | null = null
  let totalTools = 0

  await runTurn(session, task, {
    onText: write,
    onThinking: () => {
      thinkSpinner.text = 'Thinking...'
    },
    onThinkingDone: (ms) => {
      thinkSpinner.stop()
      process.stderr.write(fmt.thinking(ms) + '\n')
    },
    onToolCall: (name, input) => {
      const detail = input.path ? String(input.path) : undefined
      toolSpinner = toolStart(name, detail)
    },
    onToolResult: (name, ms, isError) => {
      toolSpinner?.stop()
      totalTools++
      if (isError) {
        process.stderr.write(fmt.toolError(name, ms) + '\n')
      } else {
        process.stderr.write(fmt.toolDone(name, ms) + '\n')
      }
    },
  })

  const elapsed = Date.now() - startTime
  const outTokens = session.usage.outputTokens
  process.stderr.write(fmt.summary(outTokens, totalTools, elapsed) + '\n')
}

const program = new Command()
program
  .name('floom')
  .argument(
    '[task...]',
    'task for the agent; omit to enter interactive mode',
  )
  .option(
    '-m, --model <id>',
    'model id',
    process.env.DEEPSEEK_MODEL ?? 'deepseek-chat',
  )
  .action(async (task: string[], opts: { model: string }) => {
    const session = makeSession(opts.model)
    const write = (d: string) => process.stdout.write(d)

    if (task.length) {
      await runTurnWithUI(session, task.join(' '), write)
      process.stdout.write('\n')
      return
    }

    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    })
    showWelcome({
      version: VERSION,
      model: opts.model,
      nodeVersion: process.versions.node,
      cwd: process.cwd(),
      isInteractive: true,
    })
    for (;;) {
      let line: string
      try {
        line = (await rl.question(fmt.green('\nfloom> '))).trim()
      } catch {
        break
      }
      if (line === '/exit') break
      if (line === '') continue
      await runTurnWithUI(session, line, write)
      process.stdout.write('\n')
    }
    rl.close()
  })

program
  .command('run <script>')
  .description('run a workflow script')
  .option('-b, --budget <n>', 'token budget', '1000000')
  .option('-j, --journal <path>', 'journal database path', '.floom/journal.db')
  .option('-a, --args <json>', 'JSON args to pass to the script', '{}')
  .option(
    '-m, --model <id>',
    'model id',
    process.env.DEEPSEEK_MODEL ?? 'deepseek-chat',
  )
  .option('--sandbox <type>', 'sandbox type: vm (default) or isolated (stub)', 'vm')
  .option('--workspace <dir>', 'custom workspace directory (default: temp dir)')
  .option('--no-cleanup', 'keep workspace directory after execution')
  .action(
    async (
      script: string,
      opts: {
        budget: string
        journal: string
        args: string
        model: string
        sandbox: string
        workspace?: string
        cleanup: boolean
      },
    ) => {
      const registry = makeRegistry()
      const client = new DeepSeekClient({ model: opts.model })
      let args: Record<string, unknown> = {}
      try {
        args = JSON.parse(opts.args)
      } catch {
        process.stderr.write(
          fmt.yellow('WARNING: ') + 'invalid --args JSON, using {}\n',
        )
      }

      let runtime: NodeVmRuntime | undefined
      if (opts.sandbox === 'vm') {
        runtime = new NodeVmRuntime()
      } else if (opts.sandbox === 'isolated') {
        process.stderr.write(
          fmt.yellow('WARNING: ') +
            'isolated-vm sandbox not yet implemented, using default\n',
        )
      }

      const result = await executeWorkflow({
        scriptPath: resolve(script),
        args,
        client,
        registry,
        journalPath: (() => {
          mkdirSync(dirname(resolve(opts.journal)), { recursive: true })
          return opts.journal
        })(),
        budgetLimit: parseInt(opts.budget, 10),
        model: opts.model,
        system: SYSTEM,
        runtime,
        forceReload: true,
      })

      if (result.status === 'done') {
        if (result.result !== undefined) {
          const out =
            typeof result.result === 'string'
              ? result.result
              : JSON.stringify(result.result, null, 2)
          console.log(out)
        }
        process.stderr.write(
          fmt.dim(
            `  live=${result.liveCalls} cached=${result.cachedCalls} · budget=${result.usage.outputTokens}\n`,
          ),
        )
      } else {
        process.stderr.write(fmt.red(`ERROR: ${result.error}\n`))
        process.exit(1)
      }
    },
  )

program.parseAsync()
