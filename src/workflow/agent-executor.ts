import type { ModelClient } from '../model/client.js'
import type { ToolRegistry } from '../tools/registry.js'
import type { GenerateResult, ToolSpec } from '../protocol/types.js'
import { createSession, runTurn } from '../agent/loop.js'
import type { AgentOpts, StructuredAgentOpts, AgentResult } from './types.js'

interface ValidationResult {
  valid: boolean
  errors: string[]
}

export function validateAgainstJsonSchema(
  schema: Record<string, unknown>,
  value: unknown,
): ValidationResult {
  const errors: string[] = []
  function fail(msg: string) {
    errors.push(msg)
  }

  function validate(
    s: Record<string, unknown>,
    v: unknown,
    path: string,
  ): void {
    if (s.enum !== undefined) {
      if (!(s.enum as any[]).includes(v)) {
        fail(`${path}: value not in enum`)
      }
      return
    }
    switch (s.type) {
      case 'object': {
        if (typeof v !== 'object' || v === null || Array.isArray(v)) {
          fail(`${path}: expected object`)
          return
        }
        const obj = v as Record<string, unknown>
        const props = (s.properties ?? {}) as Record<
          string,
          Record<string, unknown>
        >
        for (const key of Object.keys(props)) {
          if (key in obj) {
            validate(props[key], obj[key], `${path}.${key}`)
          } else if (
            Array.isArray(s.required) &&
            (s.required as string[]).includes(key)
          ) {
            fail(`${path}.${key}: required`)
          }
        }
        if (s.additionalProperties === false) {
          for (const key of Object.keys(obj)) {
            if (!(key in props)) {
              fail(`${path}.${key}: additional property not allowed`)
            }
          }
        }
        break
      }
      case 'array': {
        if (!Array.isArray(v)) {
          fail(`${path}: expected array`)
          return
        }
        if (s.items) {
          v.forEach((item, i) =>
            validate(s.items as Record<string, unknown>, item, `${path}[${i}]`),
          )
        }
        break
      }
      case 'string':
        if (typeof v !== 'string') fail(`${path}: expected string`)
        break
      case 'number':
        if (typeof v !== 'number' || !Number.isFinite(v))
          fail(`${path}: expected number`)
        break
      case 'boolean':
        if (typeof v !== 'boolean') fail(`${path}: expected boolean`)
        break
    }
  }

  validate(schema, value, '$')
  return { valid: errors.length === 0, errors }
}

export interface AgentExecutorConfig {
  client: ModelClient
  registry: ToolRegistry
  defaultModel: string
  defaultMaxTokens: number
  defaultSystem: string
}

export class AgentExecutor {
  constructor(private cfg: AgentExecutorConfig) {}

  async agent(prompt: string, opts?: AgentOpts): Promise<AgentResult> {
    const s = createSession({
      client: this.cfg.client,
      registry: this.cfg.registry,
      system: opts?.system ?? this.cfg.defaultSystem,
      model: opts?.model ?? this.cfg.defaultModel,
      maxTokens: opts?.maxTokens ?? this.cfg.defaultMaxTokens,
    })
    const text = await runTurn(s, prompt)
    if (text.startsWith('stopped:')) {
      throw new Error(text)
    }
    return { text, usage: s.usage }
  }

  async agentStructured(
    prompt: string,
    opts: StructuredAgentOpts & { maxRetries?: number },
  ): Promise<Record<string, unknown> | null> {
    const maxR = opts.maxRetries ?? 2
    const schemaName = opts.schemaName ?? 'structured_output'
    const toolSpec: ToolSpec = {
      name: schemaName,
      description: 'Produce structured output matching the given schema',
      inputSchema: opts.schema,
    }
    const msgs: Array<{ role: 'user' | 'assistant'; text: string }> = [
      { role: 'user', text: prompt },
    ]

    for (let attempt = 0; attempt <= maxR; attempt++) {
      const res: GenerateResult = await this.cfg.client.generate({
        system: opts.system ?? this.cfg.defaultSystem,
        messages: msgs.map((m) => ({ role: m.role, text: m.text })),
        tools: [toolSpec],
        model: opts.model ?? this.cfg.defaultModel,
        maxTokens: opts.maxTokens ?? this.cfg.defaultMaxTokens,
      } as any)

      const call = res.toolCalls.find((c) => c.name === schemaName)
      if (call) {
        const vr = validateAgainstJsonSchema(opts.schema, call.input)
        if (vr.valid) return call.input
        msgs.push({
          role: 'assistant',
          text: `Validation failed: ${vr.errors.join('; ')}`,
        })
        msgs.push({
          role: 'user',
          text: `Previous output was invalid. Errors: ${vr.errors.join(
            '; ',
          )}. Please produce valid output matching the schema.`,
        })
      } else if (res.text) {
        msgs.push({ role: 'assistant', text: res.text })
        msgs.push({
          role: 'user',
          text: 'Please call the structured_output tool.',
        })
      } else {
        return null
      }
    }
    return null
  }

  async execute(
    prompt: string,
    opts?: AgentOpts | StructuredAgentOpts,
  ): Promise<string | Record<string, unknown> | null> {
    if (opts && 'schema' in opts) {
      return this.agentStructured(prompt, opts as StructuredAgentOpts)
    }
    const r = await this.agent(prompt, opts as AgentOpts | undefined)
    return r.text
  }
}
