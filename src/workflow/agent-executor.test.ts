import { describe, it, expect, vi } from 'vitest'
import { AgentExecutor, validateAgainstJsonSchema } from './agent-executor.js'

function mockClient(responses: any[]) {
  let i = 0
  return {
    generate: vi.fn(async () => {
      const r = responses[i++]
      if (!r) throw new Error('no more responses')
      return r
    }),
  }
}

describe('validateAgainstJsonSchema', () => {
  it('validates object type with properties', () => {
    expect(
      validateAgainstJsonSchema(
        { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
        { name: 'hi' },
      ),
    ).toEqual({ valid: true, errors: [] })
  })

  it('rejects missing required', () => {
    const r = validateAgainstJsonSchema(
      { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
      {},
    )
    expect(r.valid).toBe(false)
    expect(r.errors.length).toBeGreaterThan(0)
  })

  it('rejects wrong type', () => {
    const r = validateAgainstJsonSchema(
      { type: 'object', properties: { a: { type: 'number' } }, required: ['a'] },
      { a: 'string' },
    )
    expect(r.valid).toBe(false)
  })

  it('rejects extra properties when additionalProperties: false', () => {
    const r = validateAgainstJsonSchema(
      { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false },
      { a: 'ok', b: 1 },
    )
    expect(r.valid).toBe(false)
  })

  it('allows extra properties when additionalProperties not set', () => {
    const r = validateAgainstJsonSchema(
      { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
      { a: 'ok', b: 1 },
    )
    expect(r.valid).toBe(true)
  })

  it('validates enum', () => {
    expect(
      validateAgainstJsonSchema({ type: 'string', enum: ['a', 'b'] }, 'a').valid,
    ).toBe(true)
    expect(
      validateAgainstJsonSchema({ type: 'string', enum: ['a', 'b'] }, 'c').valid,
    ).toBe(false)
  })

  it('validates arrays', () => {
    expect(
      validateAgainstJsonSchema({ type: 'array', items: { type: 'number' } }, [
        1, 2,
      ]).valid,
    ).toBe(true)
    expect(
      validateAgainstJsonSchema({ type: 'array', items: { type: 'number' } }, [
        1, 'x',
      ]).valid,
    ).toBe(false)
  })

  it('validates boolean type', () => {
    expect(
      validateAgainstJsonSchema({ type: 'boolean' }, true).valid,
    ).toBe(true)
    expect(
      validateAgainstJsonSchema({ type: 'boolean' }, 'true').valid,
    ).toBe(false)
  })

  it('validates nested objects', () => {
    const schema = {
      type: 'object',
      properties: {
        person: {
          type: 'object',
          properties: { name: { type: 'string' }, age: { type: 'number' } },
          required: ['name', 'age'],
        },
      },
      required: ['person'],
    }
    expect(
      validateAgainstJsonSchema(schema, { person: { name: 'A', age: 30 } })
        .valid,
    ).toBe(true)
    expect(
      validateAgainstJsonSchema(schema, { person: { name: 'A' } }).valid,
    ).toBe(false)
  })
})

describe('AgentExecutor', () => {
  const makeExec = (client: any) =>
    new AgentExecutor({
      client,
      registry: { specs: () => [], run: async () => 'ok', get: () => undefined, register: () => {} } as any,
      defaultModel: 'm',
      defaultMaxTokens: 100,
      defaultSystem: 'sys',
    })

  it('agent without schema returns text', async () => {
    const client = mockClient([
      {
        text: 'final answer',
        toolCalls: [],
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 5, cacheHitTokens: 0 },
      },
    ])
    const exec = makeExec(client)
    const r = await exec.agent('hello')
    expect(r.text).toBe('final answer')
  })

  it('agentStructured returns validated object on first success', async () => {
    const client = mockClient([
      {
        text: null,
        stopReason: 'tool_use',
        toolCalls: [
          {
            id: 'c1',
            name: 'structured_output',
            input: { name: 'foo', value: 42 },
          },
        ],
        usage: { inputTokens: 10, outputTokens: 5 },
      },
    ])
    const exec = makeExec(client)
    const r = await exec.agentStructured('extract', {
      schema: {
        type: 'object',
        properties: { name: { type: 'string' }, value: { type: 'number' } },
        required: ['name', 'value'],
      },
    })
    expect(r).toEqual({ name: 'foo', value: 42 })
  })

  it('agentStructured retries on validation failure', async () => {
    let call = 0
    const client = {
      generate: vi.fn(async () => {
        call++
        if (call === 1) {
          return {
            text: null,
            stopReason: 'tool_use',
            toolCalls: [
              { id: 'c1', name: 'structured_output', input: { x: 1 } },
            ],
            usage: { inputTokens: 10, outputTokens: 5 },
          }
        }
        return {
          text: null,
          stopReason: 'tool_use',
          toolCalls: [
            {
              id: 'c2',
              name: 'structured_output',
              input: { name: 'bar', value: 99 },
            },
          ],
          usage: { inputTokens: 10, outputTokens: 5 },
        }
      }),
    }
    const exec = new AgentExecutor({
      client,
      registry: { specs: () => [], run: async () => 'ok', get: () => undefined, register: () => {} } as any,
      defaultModel: 'm',
      defaultMaxTokens: 100,
      defaultSystem: 'sys',
    })
    const r = await exec.agentStructured('extract', {
      schema: {
        type: 'object',
        properties: { name: { type: 'string' }, value: { type: 'number' } },
        required: ['name', 'value'],
        additionalProperties: false,
      },
      maxRetries: 2,
    })
    expect(r).toEqual({ name: 'bar', value: 99 })
    expect(call).toBe(2)
  })

  it('agentStructured returns null after exhausting retries', async () => {
    const client = {
      generate: vi.fn(async () => ({
        text: null,
        stopReason: 'tool_use',
        toolCalls: [
          { id: 'c', name: 'structured_output', input: {} },
        ],
        usage: { inputTokens: 10, outputTokens: 5 },
      })),
    }
    const exec = makeExec(client)
    const r = await exec.agentStructured('x', {
      schema: {
        type: 'object',
        properties: { a: { type: 'string' } },
        required: ['a'],
      },
      maxRetries: 1,
    })
    expect(r).toBeNull()
    expect(client.generate).toHaveBeenCalledTimes(2) // 1 initial + 1 retry
  })

  it('execute dispatches to agent when no schema', async () => {
    const client = mockClient([
      { text: 'text result', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 2 } },
    ])
    const exec = makeExec(client)
    expect(await exec.execute('hi')).toBe('text result')
  })

  it('execute dispatches to agentStructured when schema present', async () => {
    const client = mockClient([
      { text: null, stopReason: 'tool_use', toolCalls: [{ id: 'c1', name: 'structured_output', input: { a: 'ok' } }], usage: { inputTokens: 5, outputTokens: 2 } },
    ])
    const exec = makeExec(client)
    const r = await exec.execute('hi', { schema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] } })
    expect(r).toEqual({ a: 'ok' })
  })
})
