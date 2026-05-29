#!/usr/bin/env node
import { config } from 'dotenv'
config()
import { Command } from 'commander'
import { createInterface } from 'node:readline/promises'
import { DeepSeekClient } from './model/deepseek-client.js'
import { ToolRegistry } from './tools/registry.js'
import { readTool } from './tools/read.js'
import { writeTool } from './tools/write.js'
import { editTool } from './tools/edit.js'
import { bashTool } from './tools/bash.js'
import { createSession, runTurn } from './agent/loop.js'

const SYSTEM = 'You are FlowLoom, a coding agent. Use the provided tools (read_file, write_file, edit_file, run_shell) to inspect and modify the user\'s project. Prefer edit_file for small changes; call a tool whenever you need file contents or to run a command.'

function makeSession(model: string) {
  const registry = new ToolRegistry()
  ;[readTool, writeTool, editTool, bashTool].forEach((t) => registry.register(t))
  return createSession({ client: new DeepSeekClient({ model }), registry, system: SYSTEM, model, maxTokens: 4096 })
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
      return
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    console.log('FlowLoom interactive mode — type /exit to quit.')
    for (;;) {
      const line = (await rl.question('\nfloom> ')).trim()
      if (line === '/exit') break
      if (line === '') continue
      await runTurn(session, line, write)
      process.stdout.write('\n')
    }
    rl.close()
  })
program.parseAsync()
