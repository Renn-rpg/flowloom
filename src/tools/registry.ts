import type { Tool } from './types.js'
import type { ToolSpec } from '../protocol/types.js'

export class ToolRegistry {
  private tools = new Map<string, Tool>()
  register(t: Tool): void { this.tools.set(t.spec.name, t) }
  get(name: string): Tool | undefined { return this.tools.get(name) }
  specs(): ToolSpec[] { return [...this.tools.values()].map((t) => t.spec) }
  async run(name: string, input: Record<string, unknown>): Promise<string> {
    const t = this.tools.get(name)
    if (!t) return `ERROR: unknown tool "${name}"`
    try { return await t.handler(input) } catch (e) { return `ERROR: ${(e as Error).message}` }
  }
}
