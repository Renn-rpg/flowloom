import type { ToolSpec } from '../protocol/types.js'
export interface Tool {
  spec: ToolSpec
  handler(input: Record<string, unknown>): Promise<string>
}
