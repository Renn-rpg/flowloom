import OpenAI from 'openai'
import type { ModelClient } from './client.js'
import type { GenerateRequest, GenerateResult, GenerateOptions } from '../protocol/types.js'
import { toOpenAIRequest } from '../protocol/to-openai.js'
import { fromOpenAIResponse, StreamAccumulator } from '../protocol/from-openai.js'

export interface DeepSeekClientOptions {
  model: string
  apiKey?: string
  baseURL?: string
  openai?: OpenAI // 测试注入；缺省时用 env 构造
}

export class DeepSeekClient implements ModelClient {
  private openai: OpenAI
  private model: string
  constructor(opts: DeepSeekClientOptions) {
    this.model = opts.model
    this.openai =
      opts.openai ??
      new OpenAI({
        apiKey: opts.apiKey ?? process.env.DEEPSEEK_API_KEY,
        baseURL: opts.baseURL ?? process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
      })
  }
  async generate(req: GenerateRequest, opts?: GenerateOptions): Promise<GenerateResult> {
    const body = toOpenAIRequest({ ...req, model: this.model })
    if (!opts?.onText) {
      const resp = await this.openai.chat.completions.create({ ...(body as any), stream: false })
      return fromOpenAIResponse(resp)
    }
    const stream: any = await this.openai.chat.completions.create({ ...(body as any), stream: true, stream_options: { include_usage: true } })
    const acc = new StreamAccumulator()
    for await (const chunk of stream) {
      const delta = acc.addChunk(chunk)
      if (delta) opts.onText(delta)
    }
    return acc.result()
  }
}
