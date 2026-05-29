#!/usr/bin/env node
import { config } from 'dotenv'
import { Command } from 'commander'
import { DeepSeekClient } from './model/deepseek-client.js'
import { ToolRegistry } from './tools/registry.js'
import { readTool } from './tools/read.js'
import { writeTool } from './tools/write.js'
import { bashTool } from './tools/bash.js'
import { runAgentTurn } from './agent/loop.js'

// 从 .env 加载 DEEPSEEK_API_KEY 等（key 不进 git/对话）
config()

const SYSTEM = 'You are FlowLoom, a coding agent. Use the provided tools to inspect and modify the user\'s project. Always call a tool when you need file contents or to run a command.'

const program = new Command()
program
  .name('floom')
  .argument('<task...>', 'task for the agent')
  .option('-m, --model <id>', 'model id', process.env.DEEPSEEK_MODEL ?? 'deepseek-chat')
  .action(async (task: string[], opts: { model: string }) => {
    const registry = new ToolRegistry()
    ;[readTool, writeTool, bashTool].forEach((t) => registry.register(t))
    const client = new DeepSeekClient({ model: opts.model })
    const out = await runAgentTurn({ client, registry, system: SYSTEM, userText: task.join(' '), model: opts.model, maxTokens: 4096 })
    console.log(out)
  })
program.parseAsync()
