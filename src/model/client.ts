import type { GenerateRequest, GenerateResult, GenerateOptions } from '../protocol/types.js'
export interface ModelClient {
  generate(req: GenerateRequest, opts?: GenerateOptions): Promise<GenerateResult>
}
