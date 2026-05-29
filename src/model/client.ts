import type { GenerateRequest, GenerateResult } from '../protocol/types.js'
export interface ModelClient {
  generate(req: GenerateRequest): Promise<GenerateResult>
}
