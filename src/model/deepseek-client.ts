import OpenAI from 'openai'
import type { ModelClient } from './client.js'
import type { GenerateRequest, GenerateResult, GenerateOptions } from '../protocol/types.js'
import { toOpenAIRequest } from '../protocol/to-openai.js'
import { fromOpenAIResponse, StreamAccumulator } from '../protocol/from-openai.js'
import { withRetry } from './retry.js'

export interface DeepSeekClientOptions {
  model: string
  apiKey?: string
  baseURL?: string
  openai?: OpenAI // 测试注入；缺省时用 env 构造
  maxRetries?: number
  timeoutMs?: number
}

export class DeepSeekClient implements ModelClient {
  private openai: OpenAI
  private model: string
  private maxRetries: number
  private timeoutMs: number
  constructor(opts: DeepSeekClientOptions) {
    this.model = opts.model
    this.maxRetries = opts.maxRetries ?? 3
    this.timeoutMs = opts.timeoutMs ?? 60_000
    this.openai =
      opts.openai ??
      new OpenAI({
        apiKey: opts.apiKey ?? process.env.DEEPSEEK_API_KEY,
        baseURL: opts.baseURL ?? process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
        maxRetries: 0, // 关掉 SDK 自带重试，改用我们可见可控的 withRetry
      })
  }
  async generate(req: GenerateRequest, opts?: GenerateOptions): Promise<GenerateResult> {
    const body = toOpenAIRequest({ ...req, model: this.model })
    const create = (extra: Record<string, unknown>) =>
      this.openai.chat.completions.create({ ...(body as any), ...extra }, { timeout: this.timeoutMs })
    if (!opts?.onText) {
      const resp = await withRetry(() => create({ stream: false }), { maxRetries: this.maxRetries })
      return fromOpenAIResponse(resp)
    }
    const stream: any = await withRetry(() => create({ stream: true, stream_options: { include_usage: true } }), { maxRetries: this.maxRetries })
    const acc = new StreamAccumulator()
    for await (const chunk of stream) {
      const delta = acc.addChunk(chunk)
      if (delta) opts.onText(delta)
    }
    return acc.result()
  }
}
