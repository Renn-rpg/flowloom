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
    const rawKey = opts.apiKey ?? process.env.DEEPSEEK_API_KEY
    // 清洗：去掉首尾空白和引号（.env 中可能写了 DEEPSEEK_API_KEY="sk-xxx"）
    const apiKey = rawKey?.trim().replace(/^["']|["']$/g, '').replace(/^["']|["']$/g, '') ?? ''
    if (!apiKey && !opts.openai) {
      throw new Error(
        'No API key configured. Set DEEPSEEK_API_KEY in .env or pass apiKey option.\n' +
        '  echo "DEEPSEEK_API_KEY=sk-your-key" > .env',
      )
    }
    this.openai =
      opts.openai ??
      new OpenAI({
        apiKey,
        baseURL: opts.baseURL ?? process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
        maxRetries: 0,
      })
  }
  async generate(req: GenerateRequest, opts?: GenerateOptions): Promise<GenerateResult> {
    const body = toOpenAIRequest({ ...req, model: this.model })
    const create = (extra: Record<string, unknown>) =>
      this.openai.chat.completions.create({ ...(body as any), ...extra }, { timeout: this.timeoutMs })
    // 仅当调用方要看流式文本/思考链时才走 stream 分支
    if (!opts?.onText && !opts?.onReasoning) {
      const resp = await withRetry(() => create({ stream: false }), { maxRetries: this.maxRetries })
      return fromOpenAIResponse(resp)
    }
    // 流式请求不重试：已经消费了一半的 stream 重试会导致不一致。
    const stream: any = await withRetry(() => create({ stream: true, stream_options: { include_usage: true } }), { maxRetries: 0 })
    const acc = new StreamAccumulator()
    for await (const chunk of stream) {
      const { text, reasoning } = acc.addChunk(chunk)
      if (text) opts.onText?.(text)
      if (reasoning) opts.onReasoning?.(reasoning) // 推理模型才会触发
    }
    return acc.result()
  }
}
