import OpenAI from 'openai'
import type { ModelClient } from './client.js'
import type { GenerateRequest, GenerateResult, GenerateOptions } from '../protocol/types.js'
import { toOpenAIRequest } from '../protocol/to-openai.js'
import { fromOpenAIResponse, StreamAccumulator } from '../protocol/from-openai.js'
import { withRetry } from './retry.js'
import { makeAbortError } from '../utils/abort-error.js'

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
    // 清洗：去掉首尾空白和引号。
    // 防御 dotenv 未正确剥离引号的环境（如 shell 中 export DEEPSEEK_API_KEY="sk-xxx"）。
    const apiKey = rawKey?.trim().replace(/^["']|["']$/g, '') ?? ''
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
    // 外部中断:进入即检查,已 aborted 直接抛(如 ESC 在工具执行期触发,下一轮 generate 立即退出)。
    if (opts?.signal?.aborted) throw makeAbortError('request aborted')
    const body = toOpenAIRequest({ ...req, model: this.model })
    // create 的两个参数：extra → 合并到请求体(JSON body)，reqOpts → 合并到 RequestOptions(fetch 层)
    const create = (extra: Record<string, unknown>, reqOpts?: Record<string, unknown>) =>
      this.openai.chat.completions.create({ ...(body as any), ...extra }, { timeout: this.timeoutMs, ...reqOpts })
    // 仅当调用方要看流式文本/思考链时才走 stream 分支
    if (!opts?.onText && !opts?.onReasoning) {
      const resp = await withRetry(() => create({ stream: false }, { signal: opts?.signal }), { maxRetries: this.maxRetries })
      return fromOpenAIResponse(resp)
    }
    // 流式请求：AbortController「空闲超时」——连接阶段与相邻 chunk 之间最多等 timeoutMs。
    // 收到任何数据就重置计时：稳定的长输出不会被「总时长」上限误杀，只有真正卡住(无数据)才中断。
    const ac = new AbortController()
    // 外部信号(ESC 打断)联动:外部 abort → 同时 abort 内部 controller,立即中断流。
    const onExternalAbort = () => ac.abort()
    opts?.signal?.addEventListener('abort', onExternalAbort, { once: true })
    let timer: ReturnType<typeof setTimeout> | undefined
    const resetIdle = () => {
      clearTimeout(timer)
      timer = setTimeout(() => ac.abort(), this.timeoutMs)
    }
    resetIdle() // 覆盖连接阶段
    try {
      const stream: any = await create({ stream: true, stream_options: { include_usage: true } }, { signal: ac.signal })
      const acc = new StreamAccumulator()
      // Promise.race：让 ESC 中断立即终止迭代，不等下一个 chunk
      const aborted = new Promise<never>((_, reject) => {
        ac.signal.addEventListener('abort', () => reject(makeAbortError('stream aborted')), { once: true })
      })
      const iterator = stream[Symbol.asyncIterator]()
      while (true) {
        const { done, value } = await Promise.race([iterator.next(), aborted])
        if (done) break
        resetIdle()
        const { text, reasoning } = acc.addChunk(value)
        if (text) opts.onText?.(text)
        if (reasoning) opts.onReasoning?.(reasoning)
      }
      return acc.result()
    } finally {
      clearTimeout(timer)
      opts?.signal?.removeEventListener('abort', onExternalAbort)
    }
  }
}
